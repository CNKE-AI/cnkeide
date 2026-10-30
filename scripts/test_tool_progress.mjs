/**
 * 验证长任务进度反馈链路（PROGRESS 约定 + 实时输出回调 + 可配置输出上限）。
 *
 * 背景：全盘扫描 / 批量清理跑几分钟时，界面此前只有转圈，用户容易误判为卡死。
 * 现在模型可在脚本里输出 `PROGRESS n/m` 或 `PROGRESS 45%`，主进程实时解析后
 * 通过 tool_progress 事件推给前端画进度条。
 *
 * 断言：
 *   1) parseProgress 正确解析比例/百分比、取最后一次、拒绝非法值
 *   2) TerminalAdapter.exec 的 onChunk 能实时收到输出，配合尾部窗口可解析出进度
 *   3) 设置项传入的 maxChars 能真正压低输出上限
 *
 * 运行：npx tsx scripts/test_tool_progress.mjs
 */
import assert from 'node:assert';
import { parseProgress } from '../electron/core-fork/tools/progress.ts';
import { TerminalAdapter } from '../electron/adapter/TerminalAdapter.ts';

// ---------- 用例 1：进度解析 ----------
assert.deepEqual(parseProgress('PROGRESS 3/10'), { current: 3, total: 10, percent: 30 });
assert.deepEqual(parseProgress('PROGRESS 45%'), { current: 45, total: 100, percent: 45 });
// 多行取最后一次（最新进度）
assert.deepEqual(parseProgress('PROGRESS 1/10\nxx\nPROGRESS 7/10'), { current: 7, total: 10, percent: 70 });
// 没有标记时不应瞎猜
assert.equal(parseProgress('hello world'), null);
assert.equal(parseProgress(''), null);
// total=0 不能除零
assert.equal(parseProgress('PROGRESS 5/0'), null);
// 百分比越界收敛到 100
assert.deepEqual(parseProgress('PROGRESS 190%'), { current: 100, total: 100, percent: 100 });
console.log('[1] ✓ 进度解析正确（比例/百分比/取最新/非法值）');

// ---------- 用例 2：实时输出回调 ----------
const adapter = new TerminalAdapter();
const seen = [];
let tail = '';
let chunks = 0;
const r = await adapter.exec(
  '1..5 | ForEach-Object { "PROGRESS $_/5" }',
  process.cwd(),
  60000,
  undefined,
  {
    onChunk: (text) => {
      chunks += 1;
      // 与 ToolManager 保持一致：只看尾部窗口，避免无限累积
      tail = (tail + text).slice(-4096);
      const p = parseProgress(tail);
      if (p) seen.push(p);
    },
  },
);
console.log(`[2] onChunk 触发 ${chunks} 次，解析到进度 ${seen.length} 次，最后一次=${JSON.stringify(seen[seen.length - 1])}`);
assert.equal(r.success, true, '命令应执行成功');
assert.ok(chunks > 0, 'onChunk 必须被调用');
assert.ok(seen.length > 0, '应解析出至少一次进度');
assert.equal(seen[seen.length - 1].percent, 100, '最后一次进度应为 100%');
console.log('[3] ✓ 实时进度可被解析');

// ---------- 用例 3：可配置输出上限 ----------
const big = await adapter.exec(
  "1..20000 | ForEach-Object { '0123456789abcdef0123456789abcdef' }",
  process.cwd(),
  180000,
  undefined,
  { maxChars: 10000 },
);
console.log(`[4] maxChars=10000：stdout=${big.stdout ? big.stdout.length : 0} 字符 truncated=${big.truncated}`);
assert.equal(big.success, true);
assert.equal(big.truncated, true, '应被截断');
assert.ok((big.stdout || '').length <= 10000, '设置项上限必须生效');
console.log('[5] ✓ 输出上限可按设置调整');

console.log('\n全部通过：长任务进度反馈与输出上限链路正常');
