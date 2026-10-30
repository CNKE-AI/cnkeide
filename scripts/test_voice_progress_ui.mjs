/** 语音模型首次下载进度 UI 实测：点击麦克风 → 截图进度条 → 校验百分比推进 */
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const SHOT = path.join(ROOT, 'scripts', 'voice-shots');
fs.mkdirSync(SHOT, { recursive: true });
const log = (...a) => console.log('[voice-ui]', ...a);

const app = await electron.launch({
  args: ['.'],
  cwd: ROOT,
  env: { ...process.env, CNKE_USER_DATA_DIR: path.join(os.tmpdir(), 'cnke-voice-ui-test') },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
await win.waitForFunction(() => !!window.cnke, null, { timeout: 30000 });
log('app ready');

// 触发下载（点击麦克风按钮；模型未就绪时即开始下载）
const mic = win.locator('button[title*="语音输入"]').first();
await mic.click({ timeout: 10000 });
log('clicked mic, waiting for progress UI...');

let sawProgress = false, lastPct = -1, lastMsg = '';
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const m = await win.evaluate(() => {
    const el = document.querySelector('[role="status"]');
    if (!el) return null;
    const text = el.textContent || '';
    const bar = el.querySelector('[style*="width"]');
    const width = bar ? bar.getAttribute('style') : '';
    return { text: text.trim().slice(0, 60), width };
  });
  if (m) {
    const pct = /(\d+)%/.exec(m.text)?.[1];
    if (pct != null && Number(pct) !== lastPct) {
      lastPct = Number(pct);
      sawProgress = true;
      log(`progress: ${lastPct}%  bar="${m.width}"`);
      if (lastPct === 2 || lastPct === 50 || lastPct === 98) {
        await win.screenshot({ path: path.join(SHOT, `progress-${lastPct}.png`) });
      }
    }
    lastMsg = m.text;
  }
  // 就绪标志：按钮 title 变为可听写状态 or 浮层消失且引擎 ready
  const ready = await win.evaluate(() => {
    const b = document.querySelector('button[title*="语音输入"]');
    return !document.querySelector('[role="status"]') && !!b;
  });
  if (sawProgress && ready) break;
}
await win.screenshot({ path: path.join(SHOT, 'final.png') });
log('lastMsg:', lastMsg);
log('verdict:', JSON.stringify({ sawProgress, lastPct, pageErrors: errors.length }));
await app.close();
fs.writeFileSync(path.join(SHOT, 'result.json'), JSON.stringify({ sawProgress, lastPct, lastMsg, errors }, null, 2));
process.exit(sawProgress && errors.length === 0 ? 0 : 1);
