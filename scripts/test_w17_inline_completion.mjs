/**
 * W17 AI 行内补全测试
 * 验证：1) prompt 构造（system 约束 + FILE/CURSOR 标注）  2) markdown 围栏剥离
 *        3) 与 prefix 重复前缀剔除  4) LRU 缓存命中  5) 同 key 并发去重
 *        6) 取消（AbortError）  7) 空结果处理  8) 无激活配置降级
 *
 * 用法：npx tsx scripts/test_w17_inline_completion.mjs
 */
import { InlineCompletionService } from '../electron/core-fork/completion/InlineCompletionService.js';

let pass = 0, fail = 0;
const log = (ok, n, d = '') => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + ' :: ' + d); } };

// ---- Mock LLMProvider：记录调用参数，按队列返回预设 content ----
function makeLlm(queue) {
  const calls = [];
  return {
    calls,
    chat: async (params) => {
      calls.push(params);
      const next = queue.length ? queue.shift() : { content: '' };
      if (next.throw) throw next.throw;
      if (next.abort) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return { content: next.content ?? '', usage: {} };
    },
  };
}

const makeConfig = (active, fallbacks = []) => ({
  getApiKeyConfigs: async () => [active, ...fallbacks].filter(Boolean),
  get: async (k) => (k === 'activeApiConfigId' ? active?.id : undefined),
});

const ACTIVE = { id: 'a1', apiKey: 'k', model: 'm', baseUrl: 'http://x' };
const REQ = { filePath: 'src/a.ts', language: 'ts', prefix: 'function add(a, b) {\n  ', suffix: '\n}' };

// 1. prompt 构造
{
  const llm = makeLlm([{ content: 'return a + b;' }]);
  const svc = new InlineCompletionService(llm, makeConfig(ACTIVE));
  const r = await svc.complete({ ...REQ });
  const msgs = llm.calls[0]?.messages || [];
  const sys = msgs.find((m) => m.role === 'system')?.content || '';
  const usr = msgs.find((m) => m.role === 'user')?.content || '';
  log('text' in r && r.text.includes('return a + b;'), 'prompt: 返回续写文本', JSON.stringify(r));
  log(sys.includes('不要输出任何解释') && sys.includes('围栏'), 'prompt: system 强约束无解释/无围栏', sys.slice(0, 60));
  log(usr.includes('<FILE>') && usr.includes('<CURSOR>') && usr.includes('</FILE>'), 'prompt: user 用 FILE/CURSOR 标注', usr.slice(0, 60));
  log(usr.includes('src/a.ts') && usr.includes('语言: ts'), 'prompt: user 含文件路径与语言', '');
  log(llm.calls[0].stream === false && llm.calls[0].temperature === 0.2, 'prompt: 非流式 + 低温度', JSON.stringify({ stream: llm.calls[0].stream, t: llm.calls[0].temperature }));
}

// 2. markdown 围栏剥离
{
  const llm = makeLlm([{ content: '```ts\nconst x = 1;\n```' }]);
  const svc = new InlineCompletionService(llm, makeConfig(ACTIVE));
  const r = await svc.complete({ ...REQ, prefix: 'let y = 2;\n', suffix: '' });
  log('text' in r && r.text === 'const x = 1;', '围栏剥离: 去 ``` 包裹', JSON.stringify(r));
}

// 3. 与 prefix 重复前缀剔除
{
  const llm = makeLlm([{ content: 'function add(a, b) {\n  return a + b;\n}' }]);
  const svc = new InlineCompletionService(llm, makeConfig(ACTIVE));
  const r = await svc.complete({ ...REQ, prefix: 'function add(a, b) {\n  ', suffix: '' });
  // 模型回显了 prefix 的整行「function add(a, b) {」，应被剔除
  log('text' in r && !r.text.startsWith('function add'), '去重: 剔除与 prefix 重复前缀', JSON.stringify(r));
}

// 4. LRU 缓存命中（第二次同 key 不再调 LLM）
{
  const llm = makeLlm([{ content: 'return 1;' }]);
  const svc = new InlineCompletionService(llm, makeConfig(ACTIVE));
  await svc.complete({ ...REQ });
  const before = llm.calls.length;
  const r2 = await svc.complete({ ...REQ });
  log(llm.calls.length === before && 'text' in r2 && r2.text === 'return 1;', '缓存: 同 key 第二次命中不再调 LLM', `calls=${llm.calls.length}`);
}

// 5. 同 key 并发去重（两个并发 complete 只触发一次 LLM 调用）
{
  let release;
  const gate = new Promise((res) => { release = res; });
  const llm = { calls: [], chat: async (p) => { llm.calls.push(p); await gate; return { content: 'x();', usage: {} }; } };
  const svc = new InlineCompletionService(llm, makeConfig(ACTIVE));
  const p1 = svc.complete({ ...REQ });
  const p2 = svc.complete({ ...REQ });
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  log(llm.calls.length === 1 && 'text' in r1 && 'text' in r2, '并发去重: 同 key 并发复用同一请求', `calls=${llm.calls.length}`);
}

// 6. 取消（AbortError → 返回 error:aborted）
{
  const llm = makeLlm([{ abort: true }]);
  const svc = new InlineCompletionService(llm, makeConfig(ACTIVE));
  const r = await svc.complete({ ...REQ, prefix: 'unique-prefix-cancel-1\n' });
  log('error' in r && r.error === 'aborted', '取消: AbortError 映射为 error:aborted', JSON.stringify(r));
}

// 7. 空结果处理（模型返回空 → text 为空字符串，不入缓存）
{
  const llm = makeLlm([{ content: '   \n  ' }]);
  const svc = new InlineCompletionService(llm, makeConfig(ACTIVE));
  const r = await svc.complete({ ...REQ, prefix: 'unique-prefix-empty-2\n' });
  log('text' in r && r.text === '', '空结果: 返回空 text', JSON.stringify(r));
  const before = llm.calls.length;
  await svc.complete({ ...REQ, prefix: 'unique-prefix-empty-2\n' });
  log(llm.calls.length === before + 1, '空结果: 空结果不入缓存（再次仍调用）', `calls=${before}->${llm.calls.length}`);
}

// 8. 无激活配置降级
{
  const llm = makeLlm([]);
  const svc = new InlineCompletionService(llm, makeConfig(null));
  const r = await svc.complete({ ...REQ, prefix: 'unique-prefix-nocfg-3\n' });
  log('error' in r && r.error === 'no-active-config', '降级: 无激活配置返回 no-active-config', JSON.stringify(r));
  log(llm.calls.length === 0, '降级: 无激活配置不调用 LLM', `calls=${llm.calls.length}`);
}

console.log(`\nW17 inline completion: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
