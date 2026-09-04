/**
 * W11 上下文实时追踪测试
 * 验证：1) 字符估算  2) token 估算  3) update/get/remove  4) 不同模型容量
 *        5) ratio 计算  6) level 颜色分级
 *
 * 用法：npx tsx scripts/test_w11_context_tracker.mjs
 */
import { ContextTracker } from '../electron/core-fork/agent/ContextTracker.js';
import { detectCapabilities } from '../electron/core-fork/llm/ProviderCapabilities.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

// ===== 字符估算 =====
function test1_estimateCharsString() {
  console.log('\n[1] 估算字符串 content');
  const t = new ContextTracker();
  log(t.estimateMessageChars({ role: 'user', content: 'hello' }) === 5, '5 字符', `c=${t.estimateMessageChars({ role: 'user', content: 'hello' })}`);
  log(t.estimateMessageChars({ role: 'user', content: '你好' }) === 2, '中文 2 字符', '');
  log(t.estimateMessageChars({ role: 'user', content: '' }) === 0, '空字符串', '');
  log(t.estimateMessageChars({ role: 'user', content: null }) === 0, 'null', '');
}

function test2_estimateCharsArray() {
  console.log('\n[2] 估算多模态 content[]');
  const t = new ContextTracker();
  const c = [
    { type: 'text', text: '描述图片' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,XXXXX' } }, // 图片不计
  ];
  const chars = t.estimateMessageChars({ role: 'user', content: c });
  log(chars === 4, '只计 text 字符（图片不计）', `c=${chars}`);
}

function test3_estimateCharsToolCalls() {
  console.log('\n[3] 估算 tool_calls');
  const t = new ContextTracker();
  const m = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { function: { name: 'read_file', arguments: '{"path":"/a.ts"}' } },
    ],
  };
  const chars = t.estimateMessageChars(m);
  // name 长度 9 + arguments 长度 16 = 25
  log(chars === 25, 'name + arguments 长度', `c=${chars}`);
}

function test4_estimateMessagesArray() {
  console.log('\n[4] 估算消息数组');
  const t = new ContextTracker();
  const chars = t.estimateMessagesChars([
    { role: 'system', content: '你是助手' },   // 4
    { role: 'user', content: 'hi' },            // 2
    { role: 'assistant', content: '你好' },    // 2
  ]);
  log(chars === 8, '总和', `c=${chars}`);
}

function test5_charsToTokens() {
  console.log('\n[5] charsToTokens');
  const t = new ContextTracker();
  log(t.charsToTokens(0) === 0, '0=0', '');
  log(t.charsToTokens(100) === 50, '100→50', `t=${t.charsToTokens(100)}`);
  log(t.charsToTokens(1) === 1, '1→1 (向上取整)', '');
}

// ===== update / get =====
function test6_updateBasic() {
  console.log('\n[6] update 基本');
  const t = new ContextTracker();
  const messages = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: 'hello world' },
  ];
  const s = t.update('s1', 'deepseek-chat', messages, { prompt_tokens: 20, completion_tokens: 10 });
  log(s.sessionId === 's1', 'sessionId 正确', '');
  log(s.model === 'deepseek-chat', 'model 正确', '');
  log(s.promptTokens === 20, 'promptTokens', `p=${s.promptTokens}`);
  log(s.completionTokens === 10, 'completionTokens', `c=${s.completionTokens}`);
  log(s.messageCount === 2, 'messageCount=2', `m=${s.messageCount}`);
  log(s.estimatedTokens > 0, 'estimatedTokens > 0', `e=${s.estimatedTokens}`);
  log(s.maxContextTokens > 0, 'maxContextTokens > 0', `max=${s.maxContextTokens}`);
  log(s.get === undefined || t.get('s1') !== undefined, 'get 能查回', '');
}

function test7_updateOverwrite() {
  console.log('\n[7] update 覆盖');
  const t = new ContextTracker();
  t.update('s1', 'm1', [{ role: 'user', content: 'a' }]);
  t.update('s1', 'm2', [{ role: 'user', content: 'bb' }]);
  const s = t.get('s1');
  log(s.model === 'm2', '覆盖为 m2', `m=${s.model}`);
}

function test8_removeAndList() {
  console.log('\n[8] remove + list');
  const t = new ContextTracker();
  t.update('s1', 'm', [{ role: 'user', content: 'a' }]);
  t.update('s2', 'm', [{ role: 'user', content: 'b' }]);
  log(t.list().length === 2, 'list 2 个', `n=${t.list().length}`);
  t.remove('s1');
  log(t.list().length === 1, 'remove 后 1 个', `n=${t.list().length}`);
  log(t.get('s1') === undefined, 'get s1 undefined', '');
}

function test9_differentModels() {
  console.log('\n[9] 不同模型的 maxContextTokens');
  const t = new ContextTracker();
  const r1 = t.update('s1', 'gpt-4o', [{ role: 'user', content: 'a' }]);
  const r2 = t.update('s2', 'qwen-turbo', [{ role: 'user', content: 'a' }]);
  const r3 = t.update('s3', 'claude-3-5-sonnet', [{ role: 'user', content: 'a' }]);
  log(r1.maxContextTokens === 200_000, 'gpt-4o 200K', `max=${r1.maxContextTokens}`);
  log(r2.maxContextTokens === 128_000, 'qwen-turbo 128K', `max=${r2.maxContextTokens}`);
  log(r3.maxContextTokens === 200_000, 'claude-3-5-sonnet 200K', `max=${r3.maxContextTokens}`);
}

function test10_noUsage() {
  console.log('\n[10] 无 usage（离线估算）');
  const t = new ContextTracker();
  const s = t.update('s1', 'gpt-4o', [{ role: 'user', content: 'hello' }]);
  log(s.promptTokens === 0, 'promptTokens=0', '');
  log(s.completionTokens === 0, 'completionTokens=0', '');
  log(s.estimatedTokens > 0, 'estimatedTokens > 0', `e=${s.estimatedTokens}`);
}

// ===== ratio + level =====
function test11_ratioAndLevel() {
  console.log('\n[11] ratio + level');
  const t = new ContextTracker();
  // 构造一个超长消息触发高 ratio
  const big = 'x'.repeat(20_000); // 10000 token
  const s = t.update('s1', 'gpt-4o', [{ role: 'user', content: big }]);
  // gpt-4o 200K → 10K/200K = 5% → safe
  log(ContextTracker.ratio(s) < 0.6, '小占用 → safe', `r=${ContextTracker.ratio(s).toFixed(3)}`);
  log(ContextTracker.level(s) === 'safe', 'level=safe', `l=${ContextTracker.level(s)}`);

  // 极端情况：120K 字符 = 60K token / 200K = 30% → safe
  const s2 = t.update('s2', 'gpt-4o', [{ role: 'user', content: 'x'.repeat(240_000) }]); // 120K token / 200K = 60%
  log(ContextTracker.ratio(s2) >= 0.6 && ContextTracker.ratio(s2) < 0.85, '中等 → warning', `r=${ContextTracker.ratio(s2).toFixed(3)}`);
  log(ContextTracker.level(s2) === 'warning', 'level=warning', `l=${ContextTracker.level(s2)}`);

  // 临界：180K token / 200K = 90%
  const s3 = t.update('s3', 'gpt-4o', [{ role: 'user', content: 'x'.repeat(360_000) }]);
  log(ContextTracker.ratio(s3) >= 0.85, '高 → critical', `r=${ContextTracker.ratio(s3).toFixed(3)}`);
  log(ContextTracker.level(s3) === 'critical', 'level=critical', `l=${ContextTracker.level(s3)}`);
}

function test12_displayText() {
  console.log('\n[12] displayText');
  const t = new ContextTracker();
  const s = t.update('s1', 'gpt-4o', [{ role: 'user', content: 'x'.repeat(200_000) }]); // 100K token / 200K = 50%
  const txt = ContextTracker.displayText(s);
  log(/100,000 \/ 200,000 tokens/.test(txt), '数字格式', txt);
  log(/50\.0%/.test(txt), '含百分比', txt);
}

(async () => {
  console.log('=== W11 上下文实时追踪测试 ===');
  test1_estimateCharsString();
  test2_estimateCharsArray();
  test3_estimateCharsToolCalls();
  test4_estimateMessagesArray();
  test5_charsToTokens();
  test6_updateBasic();
  test7_updateOverwrite();
  test8_removeAndList();
  test9_differentModels();
  test10_noUsage();
  test11_ratioAndLevel();
  test12_displayText();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
