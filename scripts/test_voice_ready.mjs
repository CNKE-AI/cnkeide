/** 引擎就绪快检：模型已在本地 → status 应迅速返回 ready，且喂入静音不异常 */
import { _electron as electron } from 'playwright';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const app = await electron.launch({
  args: ['.'],
  cwd: ROOT,
  env: { ...process.env, CNKE_USER_DATA_DIR: path.join(os.tmpdir(), 'cnke-voice-ui-test') },
});
const win = await app.firstWindow();
await win.waitForFunction(() => !!window.cnke, null, { timeout: 30000 });
const t0 = Date.now();
const st = await win.evaluate(() => window.cnke.voice.status());
log('elapsed', Date.now() - t0, 'ms');
console.log(JSON.stringify(st));
// 引擎就绪后喂 1 秒静音验证 IPC 管道
const feedOk = await win.evaluate(() => {
  try {
    for (let i = 0; i < 4; i++) window.cnke.voice.feed(new Array(16000).fill(0));
    return true;
  } catch (e) { return 'ERR: ' + e.message; }
});
console.log('feed-1s-silence:', feedOk);
const fin = await win.evaluate(() => window.cnke.voice.finalize());
console.log('finalize:', JSON.stringify(fin));
await app.close();
function log(...a) { console.log('[ready]', ...a); }
