/**
 * 白屏修复实测（事件重放版）：
 * 以 CNKE_FLOOD_TEST=1 启动应用，通过门控通道重放真实形状的 agent 事件：
 *   start → tool_call(扫描命令) → tool_result(400KB 大输出 + \r 进度条) → done
 * 同时驱动两条渲染链路：聊天区 ToolCallView 气泡 与 终端 Agent 活动区。
 * 验证：界面存活、DOM/内存受控、无渲染错误。
 * 运行：npx tsx scripts/test_flood_ui.mjs
 */
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOT_DIR = path.join(ROOT, 'scripts', 'flood-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log('[flood-test]', ...a);

const app = await electron.launch({
  args: ['.'],
  cwd: ROOT,
  env: { ...process.env, CNKE_FLOOD_TEST: '1' },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
win.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 200)}`); });
await win.waitForFunction(() => !!window.cnke, null, { timeout: 30000 });

const hasChannel = await win.evaluate(() =>
  typeof window.cnke?.agent?.testPushEvent === 'function'
);
if (!hasChannel) { log('FAIL: 测试通道未注册'); await app.close(); process.exit(1); }
log('test channel ready');

await win.screenshot({ path: path.join(SHOT_DIR, '01-initial.png') });
const metrics = () => win.evaluate(() => ({
  mem: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
  domNodes: document.querySelectorAll('*').length,
  bodyChars: document.body.innerText.length,
}));
const before = await metrics();
log('before:', JSON.stringify(before));

// 构造 400KB 扫描输出（与主进程 400KB 截断上限一致）：
// 前 300 行长行（每行 3000 字符，触发单行截断闸门）+ 2000 帧 \r 进度条（触发重绘合并）+ 尾部正常行
const longLines = Array.from({ length: 300 }, (_, i) => `L${i} ${'x'.repeat(3000)}`).join('\n');
const progress = Array.from({ length: 2000 }, (_, i) => `\r${Math.round((i / 2000) * 100)}%`).join('');
const tail = '\nFLOOD-DONE tail-line-ok\n';
const bigOutput = (longLines + progress + tail).slice(0, 400 * 1024);

const push = (event) => win.evaluate((e) => window.cnke.agent.testPushEvent(e), event);
await push({ type: 'start', sessionId: 'flood-test-1' });
await push({ type: 'tool_call', data: { id: 't1', name: 'execute_command', args: { command: 'Get-ChildItem C:\\ -Recurse' } } });
await push({ type: 'tool_result', data: { toolCallId: 't1', result: { success: true, output: bigOutput } } });
await push({ type: 'done', data: {} });
log('events replayed, settling...');

await new Promise((r) => setTimeout(r, 6000)); // 渲染稳定
await win.screenshot({ path: path.join(SHOT_DIR, '02-after-flood.png') });
const after = await metrics();
log('after:', JSON.stringify(after));

// 断言：聊天气泡出现中文工具名与完成态；点开气泡展开 400KB 输出后仍存活；界面可交互
const ui = { hasToolBubble: false, hasDoneMark: false, hasFloodTail: false, expandedChars: 0, buttons: 0 };
{
  const t0 = await win.evaluate(() => document.body.innerText);
  ui.hasToolBubble = t0.includes('执行命令');
  ui.hasDoneMark = t0.includes('运行完成') || t0.includes('完成');
  // 展开最后一个含本次扫描命令的气泡（t1 挂在最后的 assistant 消息上）
  const target = win.getByText('Get-ChildItem C:\\ -Recurse').last();
  try {
    await target.click({ timeout: 5000 });
    await new Promise((r) => setTimeout(r, 3000)); // 让 400KB 输出完成渲染
  } catch { log('bubble click failed (may be collapsed by default)'); }
  const t1 = await win.evaluate(() => document.body.innerText);
  ui.hasFloodTail = t1.includes('tail-line-ok');
  ui.expandedChars = t1.length - t0.length;
  ui.buttons = await win.evaluate(() => document.querySelectorAll('button').length);
}
log('ui:', JSON.stringify(ui));
await win.screenshot({ path: path.join(SHOT_DIR, '03-alive.png') });

const verdict = {
  pageAlive: ui.buttons > 0,
  bubbleRendered: ui.hasToolBubble,
  doneMarkVisible: ui.hasDoneMark,
  domUnderControl: after.domNodes < 40000,
  heapGrowthMB: after.mem - before.mem,
  pageErrors: errors.length,
};
log('verdict:', JSON.stringify(verdict, null, 1));
await app.close();

const ok = verdict.pageAlive && verdict.bubbleRendered && verdict.doneMarkVisible &&
  verdict.domUnderControl && verdict.heapGrowthMB < 500 && verdict.pageErrors === 0;
fs.writeFileSync(path.join(SHOT_DIR, 'result.json'), JSON.stringify({ verdict, before, after, ui, errors: errors.slice(0, 10) }, null, 2));
log(ok ? 'PASS: 扫描级输出下界面存活且指标受控' : 'FAIL: 见上方指标');
process.exit(ok ? 0 : 1);
