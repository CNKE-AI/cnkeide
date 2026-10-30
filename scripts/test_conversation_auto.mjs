import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectLanguage, detectInteractionMode, routeConversation, resolveConversation, conversationInstruction } from '../electron/core-fork/agent/ConversationRouter.ts';
import { routeFastestModel, selectRoutingCandidates } from '../electron/core-fork/llm/ModelRouter.ts';
import { modelLatencyKey, recordModelLatency, readModelLatency } from '../electron/core-fork/llm/ModelLatency.ts';
import { LLMProvider } from '../electron/core-fork/llm/LLMProvider.ts';
import { ToolManager } from '../electron/core-fork/tools/ToolManager.ts';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const cfg = (id, model, extra = {}) => ({ id, model, baseUrl: 'https://example.invalid', apiKey: 'test-only', builtin: true, ...extra });
const fast = cfg('official_fast', 'qwen-turbo');
const slower = cfg('official_slow', 'qwen-max');
const now = Date.now();
const sample = (ms, extra = {}) => ({ ttftMs: ms, samples: 3, updatedAt: now, cooldownUntil: 0, ...extra });

for (const [text, expected] of [['解释这个 function', 'zh'], ['Explain this code', 'en'], ['コードを説明してください', 'ja'], ['코드를 설명하세요', 'ko'], ['Объясните код', 'ru'], ['اشرح الكود', 'ar'], ['Hola, explica esto', 'es'], ['Bonjour, expliquez ceci', 'fr'], ['Hallo, bitte erklären', 'de'], ['请用英文解释代码', 'en'], ['Answer in Chinese please', 'zh'], ['```js\nconst x = 1;\n```', 'zh']]) {
  await test(`language ${expected}: ${text.slice(0, 20)}`, () => assert.equal(detectLanguage(text), expected));
}
for (const [text, expected] of [['解释这个函数', 'ask'], ['如何修复这个 bug？', 'ask'], ['请实现登录函数', 'coder'], ['Fix this code', 'coder'], ['先给方案，不要修改代码', 'architect'], ['Plan the migration', 'architect'], ['Only explain this code; do not modify files', 'ask'], ['/ask explain', 'ask'], ['/craft implement', 'coder'], ['/plan migration', 'architect']]) {
  await test(`mode ${expected}: ${text}`, () => assert.equal(detectInteractionMode(text), expected));
}
await test('continuation preserves mode', () => assert.equal(detectInteractionMode('继续', 'coder'), 'coder'));
await test('manual selection wins', () => assert.equal(routeConversation('实现函数', '/a', undefined, 'ask').mode, 'ask'));
const initial = routeConversation('实现这个函数', '/a');
await test('language change preserves relevant history', () => { const d = routeConversation('Explain this code', '/a', initial); assert.equal(d.language, 'en'); assert.equal(d.resetHistory, false); });
await test('topic changes isolate context', () => assert.equal(routeConversation('写一封邮件', '/a', initial).resetHistory, true));
await test('workspace change isolates context', () => assert.equal(routeConversation('继续', '/b', initial).resetHistory, true));
await test('target platform switch preserves real host boundary', () => { const d = routeConversation('切换到 Linux 环境', '/a', initial); assert.equal(d.targetPlatform, 'linux'); assert(d.resetHistory); assert(conversationInstruction(d).includes('不改变工具真实执行')); });
await test('explicit new topic excludes previous history', () => assert.deepEqual(resolveConversation('换个话题，写邮件', '/a', [{ role: 'user', content: '实现函数' }]).history, []));
await test('followups keep only current topic segment', () => { const h = [{ role: 'user', content: '实现函数' }, { role: 'assistant', content: 'old code' }, { role: 'user', content: '换个话题，写一封邮件' }, { role: 'assistant', content: 'draft' }]; assert.deepEqual(resolveConversation('继续', '/a', h).history, h.slice(2)); });

await test('fastest measured model overrides tier', () => { const table = { [modelLatencyKey(fast)]: sample(900), [modelLatencyKey(slower)]: sample(120) }; assert.equal(routeFastestModel('实现函数', [fast, slower], fast.id, false, true, table).apiConfig.id, slower.id); });
await test('vision constraint outranks speed', () => { const table = { [modelLatencyKey(fast)]: sample(10), [modelLatencyKey(slower)]: sample(500) }; assert.equal(routeFastestModel('描述图片', [fast, slower], fast.id, true, true, table).apiConfig.id, slower.id); });
await test('no eligible image model fails clearly', () => assert.throws(() => routeFastestModel('image', [fast], fast.id, true, true, {}), /能力/));
await test('cold start explains lack of samples', () => assert.match(routeFastestModel('hello', [slower, fast], slower.id, false, true, {}).reason, /暂无有效测速样本/));
await test('cooldown avoids recently failing model', () => { const table = { [modelLatencyKey(fast)]: sample(1, { cooldownUntil: now + 60000 }), [modelLatencyKey(slower)]: sample(200) }; assert.equal(routeFastestModel('hello', [fast, slower], fast.id, false, true, table).apiConfig.id, slower.id); });
await test('disabled model excluded', () => assert.equal(routeFastestModel('hello', [{ ...fast, disabled: true }, slower], fast.id, false, true, {}).apiConfig.id, slower.id));
await test('explicit model override retained', () => assert.equal(routeFastestModel('@qwen-max hello', [fast, slower], fast.id, false, true, { [modelLatencyKey(fast)]: sample(1) }).apiConfig.id, slower.id));
await test('endpoint changes invalidate latency identity', () => assert.notEqual(modelLatencyKey(fast), modelLatencyKey({ ...fast, baseUrl: 'https://other.invalid' })));
await test('AUTO respects builtin-only scope', () => assert.deepEqual(selectRoutingCandidates([fast, { ...slower, id: 'custom', builtin: false }]), [fast]));

const values = new Map();
const storage = { get: (key, fallback) => values.get(key) ?? fallback, set: (key, value) => values.set(key, value) };
await test('EWMA persists without API credentials', () => { recordModelLatency(fast, 100, storage, now); recordModelLatency(fast, 200, storage, now); assert.equal(readModelLatency(storage, now)[modelLatencyKey(fast)].ttftMs, 130); assert(!JSON.stringify([...values]).includes('test-only')); });
await test('stale latency expires', () => assert.equal(Object.keys(readModelLatency(storage, now + 86400001)).length, 0));
await test('failed request sets cooldown', () => { recordModelLatency(fast, null, storage, now); assert(readModelLatency(storage, now)[modelLatencyKey(fast)].cooldownUntil > now); });

await test('provider records actual fallback and skips cancellation', async () => {
  values.clear();
  const provider = new LLMProvider(storage);
  provider.attemptChat = async (config, _m, _t, _temp, _topP, _stream, callback) => {
    if (config.id === fast.id) throw new Error('invalid configuration');
    await new Promise((resolve) => setTimeout(resolve, 5));
    callback('ok');
    return { content: 'ok', toolCalls: [] };
  };
  const response = await provider.chat({ apiConfig: fast, messages: [], stream: true, fallbackConfigs: [slower], retry: { maxRetries: 1 } });
  assert.equal(response.resolvedConfig.id, slower.id);
  const table = readModelLatency(storage);
  assert.equal(table[modelLatencyKey(slower)].samples, 1);
  assert(table[modelLatencyKey(fast)].cooldownUntil > now);
  values.clear();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.chat({ apiConfig: fast, messages: [], signal: controller.signal }), { name: 'AbortError' });
  assert.equal(values.size, 0);
});
await test('Ask and Plan exclude write and untrusted MCP tools', async () => {
  const manager = Object.create(ToolManager.prototype);
  manager.browserReady = false; manager.imageGenReady = false;
  manager.getMcpTools = async () => [{ name: 'mcp__write_files' }];
  for (const mode of ['ask', 'architect']) {
    const tools = await manager.getAvailableTools(mode);
    assert(tools.some((tool) => tool.name === 'read_file'));
    assert(!tools.some((tool) => /write_file|execute_command|mcp__/.test(tool.name)));
    if (mode === 'architect') {
      for (const name of ['create_plan', 'update_plan_status', 'add_plan_item', 'get_plan', 'mark_plan_complete']) {
        assert(tools.some((tool) => tool.name === name), `Plan 模式缺少 ${name}`);
      }
    }
  }
  assert((await manager.getAvailableTools('coder')).some((tool) => tool.name === 'mcp__write_files'));
});
await test('version skips invalid patch and lockfile agrees', () => { const p = JSON.parse(readFileSync('package.json', 'utf8')); const l = JSON.parse(readFileSync('package-lock.json', 'utf8')); assert.equal(p.version, '1.4.0'); assert.equal(l.version, p.version); assert.equal(l.packages[''].version, p.version); assert.match(p.version, /^\d+\.\d+\.\d$/); });
console.log(`RESULT ${passed} passed; 0 failed`);
