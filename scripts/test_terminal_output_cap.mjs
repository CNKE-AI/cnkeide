/**
 * 验证 execute_command 的输出上限：
 * 之前 TerminalAdapter.exec 是 `stdout += chunk` 无限累积，全盘扫描类命令（几十万行）
 * 会把主进程内存撑爆、再把巨型字符串经 IPC 复制进渲染进程，最终整窗白屏。
 *
 * 断言：
 *   1) 6MB 级输出被截断，stdout 字符数不超过 400_000，且 truncated=true、droppedChars>0
 *   2) 正常小输出不受影响（truncated 不为 true）
 *   3) 截断后主进程内存没有暴涨（对比基线增量 < 200MB）
 *
 * 运行：npx tsx scripts/test_terminal_output_cap.mjs
 */
import assert from 'node:assert';
import { TerminalAdapter } from '../electron/adapter/TerminalAdapter.ts';

const MAX = 400_000;

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

const memBefore = process.memoryUsage().heapUsed + process.memoryUsage().external;
const adapter = new TerminalAdapter();

// ---------- 用例 1：巨量输出 ----------
// 20 万行 × 32 字符 ≈ 6.4MB 原始输出（全盘扫描量级）
const bigCmd =
  'powershell -NoProfile -Command "1..200000 | ForEach-Object { \'0123456789abcdef0123456789abcdef\' }"';
const t0 = Date.now();
const big = await adapter.exec(bigCmd, process.cwd(), 180000);
const bigMs = Date.now() - t0;

console.log(`[1] 大输出命令耗时 ${bigMs}ms  success=${big.success}`);
console.log(`    stdout 字符数=${big.stdout ? big.stdout.length : 0}  truncated=${big.truncated}  droppedChars=${big.droppedChars}`);
assert.equal(big.success, true, '命令本身应执行成功');
assert.ok(big.stdout && big.stdout.length <= MAX, `stdout 必须被截断到 ${MAX} 字符以内`);
assert.equal(big.truncated, true, '必须标记 truncated=true');
assert.ok((big.droppedChars ?? 0) > 1_000_000, `droppedChars 应达到 MB 量级，实得 ${big.droppedChars}`);
console.log('    ✓ 巨量输出被安全截断');

// ---------- 用例 2：普通输出 ----------
const small = await adapter.exec('echo cnke-ok', process.cwd(), 30000);
console.log(`[2] 小输出：success=${small.success} stdout=${JSON.stringify((small.stdout || '').trim())} truncated=${small.truncated}`);
assert.equal(small.success, true);
assert.ok((small.stdout || '').includes('cnke-ok'));
assert.notEqual(small.truncated, true, '小输出不应被标记截断');
console.log('    ✓ 正常输出不受影响');

// ---------- 用例 3：内存增量 ----------
const memAfter = process.memoryUsage().heapUsed + process.memoryUsage().external;
const delta = memAfter - memBefore;
console.log(`[3] 内存增量 ${mb(delta)}（基线 ${mb(memBefore)} → ${mb(memAfter)}）`);
assert.ok(delta < 200 * 1024 * 1024, `截断后内存增量不应超过 200MB，实得 ${mb(delta)}`);
console.log('    ✓ 内存未随输出量线性增长');

console.log('\n全部通过：execute_command 输出上限生效');
