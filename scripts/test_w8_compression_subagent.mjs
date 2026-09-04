/**
 * W8 自动压缩 + SubAgent 测试
 * 验证：1) ContextCompressor 估算字符/token  2) shouldCompress 阈值判断
 *        3) compress 保留最近 K 轮  4) SubAgent 跑通  5) explore 类型禁用写工具
 *        6) 子任务并发互斥
 *
 * 用法：npx tsx scripts/test_w8_compression_subagent.mjs
 */
import { ContextCompressor, SUMMARIZE_PROMPT } from '../electron/core-fork/agent/ContextCompressor.js';
import { SubAgentManager } from '../electron/core-fork/agent/SubAgentManager.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ===== ContextCompressor =====
function test1_estimateChars() {
  console.log('\n[1] estimateChars 字符数');
  const c = new ContextCompressor();
  log(c.estimateChars([]) === 0, '空数组=0', '');
  log(c.estimateChars([{ role: 'system', content: 'hi' }]) === 2, '字符串长度', `c=${c.estimateChars([{ role: 'system', content: 'hi' }])}`);
  log(c.estimateChars([{ role: 'user', content: '你好' }]) === 2, '中文', '');
  log(c.estimateChars([{ role: 'assistant', content: null, tool_calls: [{ function: { arguments: '{"x":1}' } }] }]) === 7, 'tool_calls 计入', '');
}

function test2_estimateTokens() {
  console.log('\n[2] estimateTokens');
  const c = new ContextCompressor();
  log(c.estimateTokens(0) === 0, '0=0', '');
  log(c.estimateTokens(200) === 100, '200 字符=100 token', `t=${c.estimateTokens(200)}`);
  log(c.estimateTokens(1) === 1, '1 字符=1 token (向上取整)', `t=${c.estimateTokens(1)}`);
}

function test3_shouldCompress() {
  console.log('\n[3] shouldCompress 阈值');
  const c = new ContextCompressor();
  const small = [{ role: 'system', content: 'hi' }];
  log(c.shouldCompress(small, { maxContextTokens: 100 }) === false, '小消息不触发', '');
  // 构造 1000 字符（500 token）
  const big = [{ role: 'user', content: 'x'.repeat(1000) }];
  log(c.shouldCompress(big, { maxContextTokens: 100, triggerRatio: 0.8 }) === true, '超阈值触发', '');
  log(c.shouldCompress(big, { maxContextTokens: 10000 }) === false, '大 maxContext 不触发', '');
  // 高阈值：500 token vs 5000*0.99=4950 → 不触发
  log(c.shouldCompress(big, { maxContextTokens: 5000, triggerRatio: 0.99 }) === false, '高阈值不触发', '');
}

async function test4_compress() {
  console.log('\n[4] compress 保留最近 K 轮');
  const c = new ContextCompressor();
  const messages = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第 1 轮' },
    { role: 'assistant', content: '回复 1' },
    { role: 'user', content: '第 2 轮' },
    { role: 'assistant', content: '回复 2' },
    { role: 'user', content: '第 3 轮' },
    { role: 'assistant', content: '回复 3' },
    { role: 'user', content: '第 4 轮' },
    { role: 'assistant', content: '回复 4' },
  ];
  const r = await c.compress(messages, async (toCompress) => {
    return `摘要：${toCompress.length} 条消息`;
  }, { maxContextTokens: 100, keepRecentTurns: 2 });
  // 期望：system + 摘要 + 第 3 轮 + 回复 3 + 第 4 轮 + 回复 4
  log(r.messages.length === 6, '压缩后 6 条', `n=${r.messages.length}`);
  log(r.messages[0].role === 'system' && r.messages[0].content === '你是助手', '原 system 保留', '');
  log(/摘要/.test(r.messages[1].content), '摘要消息', '');
  log(r.messages[2].content === '第 3 轮', '保留第 3 轮', `c=${r.messages[2].content}`);
  log(r.messages[5].content === '回复 4', '保留第 4 轮回复', `c=${r.messages[5].content}`);
  log(r.stats.savedTokens >= 0, 'savedTokens 非负', `s=${r.stats.savedTokens}`);
  log(r.stats.compressedTurns > 0, 'compressedTurns > 0', `t=${r.stats.compressedTurns}`);
}

async function test5_compressNotEnoughTurns() {
  console.log('\n[5] 轮数不够不压缩');
  const c = new ContextCompressor();
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
  ];
  const r = await c.compress(messages, async () => 'unused', { maxContextTokens: 100, keepRecentTurns: 6 });
  log(r.messages.length === 3, '未压缩', `n=${r.messages.length}`);
  log(r.stats.savedTokens === 0, 'savedTokens=0', '');
}

async function test6_summarizePrompt() {
  console.log('\n[6] SUMMARIZE_PROMPT 模板');
  log(/摘要/.test(SUMMARIZE_PROMPT) || /压缩/.test(SUMMARIZE_PROMPT), '含压缩提示', '');
  log(SUMMARIZE_PROMPT.length > 50, '非空', `len=${SUMMARIZE_PROMPT.length}`);
}

// ===== SubAgent =====
async function test7_subAgentBasic() {
  console.log('\n[7] SubAgent 基本跑通');
  const mgr = new SubAgentManager();
  let llmCalls = 0;
  const exec = {
    callLlm: async () => {
      llmCalls++;
      if (llmCalls === 1) {
        return { content: '我先调研一下', thinking: '', toolCalls: [
          { id: 'c1', name: 'read_file', arguments: { path: '/a.ts' } },
        ] };
      }
      return { content: '已完成调研，结果是 X', thinking: '', toolCalls: [] };
    },
    executeTool: async (name, args) => ({ success: true, output: `result of ${name}` }),
    getActiveApiConfig: () => ({ baseUrl: 'x', apiKey: 'k', model: 'm' }),
    getAvailableTools: () => [{ name: 'read_file' }, { name: 'write_to_file' }],
  };
  const r = await mgr.runTask({ description: '调研 a.ts', parentSessionId: 'p1' }, exec);
  log(r.success === true, '成功', `s=${r.success}`);
  log(r.output === '已完成调研，结果是 X', '输出正确', `o=${r.output}`);
  log(r.turns === 2, '跑了 2 轮', `t=${r.turns}`);
  log(r.toolCallCount === 1, '1 个工具调用', `tc=${r.toolCallCount}`);
}

async function test8_subAgentExploreDeny() {
  console.log('\n[8] explore 类型拒绝写工具');
  const mgr = new SubAgentManager();
  let llmCalls = 0;
  const executedTools = [];
  const exec = {
    callLlm: async () => {
      llmCalls++;
      if (llmCalls === 1) {
        return { content: '尝试写文件', toolCalls: [
          { id: 'c1', name: 'write_to_file', arguments: { path: '/a.ts', content: 'x' } },
        ] };
      }
      return { content: '完成', toolCalls: [] };
    },
    executeTool: async (name, args) => {
      executedTools.push(name);
      return { success: true, output: 'ok' };
    },
    getActiveApiConfig: () => ({ baseUrl: 'x', apiKey: 'k', model: 'm' }),
    getAvailableTools: () => [
      { name: 'read_file' }, { name: 'write_to_file' }, { name: 'apply_diff' },
    ],
  };
  const r = await mgr.runTask({ description: '探索', parentSessionId: 'p1', agentType: 'explore' }, exec);
  log(r.success === true, '成功完成（拒绝写）', `s=${r.success}`);
  log(executedTools.length === 0, 'executeTool 未被调用（写工具被拒）', `executed=${executedTools.join(',')}`);
}

async function test9_subAgentMaxTurns() {
  console.log('\n[9] SubAgent 达到 maxTurns 终止');
  const mgr = new SubAgentManager();
  let llmCalls = 0;
  const exec = {
    callLlm: async () => {
      llmCalls++;
      return { content: '继续', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: '/a' } }] };
    },
    executeTool: async () => ({ success: true, output: 'r' }),
    getActiveApiConfig: () => ({ baseUrl: 'x', apiKey: 'k', model: 'm' }),
    getAvailableTools: () => [{ name: 'read_file' }],
  };
  const r = await mgr.runTask({ description: 'd', parentSessionId: 'p', maxTurns: 3 }, exec);
  log(llmCalls === 3, 'llm 调用 3 次', `c=${llmCalls}`);
  log(r.success === true, '完成', '');
}

async function test10_subAgentAbort() {
  console.log('\n[10] SubAgent AbortSignal 取消');
  const mgr = new SubAgentManager();
  const ctrl = new AbortController();
  const exec = {
    callLlm: async () => {
      await delay(100);
      return { content: 'x', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] };
    },
    executeTool: async () => ({ success: true, output: 'r' }),
    getActiveApiConfig: () => ({ baseUrl: 'x', apiKey: 'k', model: 'm' }),
    getAvailableTools: () => [{ name: 'read_file' }],
  };
  setTimeout(() => ctrl.abort(), 50);
  const r = await mgr.runTask({ description: 'd', parentSessionId: 'p' }, exec, ctrl.signal);
  log(r.success === false && /取消|aborted/i.test(r.error || ''), '应取消', `s=${r.success} err=${r.error}`);
}

async function test11_subAgentConcurrencyLock() {
  console.log('\n[11] 同一 parentSessionId 并发互斥');
  const mgr = new SubAgentManager();
  const exec = {
    callLlm: async () => ({ content: 'ok', toolCalls: [] }),
    executeTool: async () => ({ success: true, output: 'r' }),
    getActiveApiConfig: () => ({ baseUrl: 'x', apiKey: 'k', model: 'm' }),
    getAvailableTools: () => [],
  };
  const p1 = mgr.runTask({ description: 'a', parentSessionId: 'same' }, exec);
  const p2 = mgr.runTask({ description: 'b', parentSessionId: 'same' }, exec);
  const [r1, r2] = await Promise.all([p1, p2]);
  const oneRejected = (r1.success && !r2.success) || (!r1.success && r2.success);
  log(oneRejected, '其中之一被拒', `r1=${r1.success} r2=${r2.success}`);
}

(async () => {
  console.log('=== W8 自动压缩 + SubAgent 测试 ===');
  test1_estimateChars();
  test2_estimateTokens();
  test3_shouldCompress();
  await test4_compress();
  await test5_compressNotEnoughTurns();
  await test6_summarizePrompt();
  await test7_subAgentBasic();
  await test8_subAgentExploreDeny();
  await test9_subAgentMaxTurns();
  await test10_subAgentAbort();
  await test11_subAgentConcurrencyLock();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
