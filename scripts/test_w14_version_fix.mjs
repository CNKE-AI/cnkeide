/**
 * W14 版本号动态读取 BUG 修复测试
 * 验证：1) preload 暴露 appApi  2) global.d.ts 类型  3) handlers 注册 IPC
 *        4) SettingsSheet 用 appVersion  5) package.json 1.2.3
 *
 * 用法：npx tsx scripts/test_w14_version_fix.mjs
 */
import fs from 'node:fs/promises';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

// ===== 1) preload 暴露 =====
async function test1_preloadExposes() {
  console.log('\n[1] preload.ts 暴露 appApi');
  const src = await fs.readFile('electron/preload.ts', 'utf-8');
  log(/const appApi = \{/.test(src), '定义 appApi', '');
  log(/getVersion: \(\) => ipcRenderer\.invoke\('app:getVersion'\)/.test(src), 'getVersion IPC', '');
  log(/getPlatform: \(\) => ipcRenderer\.invoke\('app:getPlatform'\)/.test(src), 'getPlatform IPC', '');
  log(/app: appApi/.test(src), 'contextBridge 暴露', '');
}

// ===== 2) global.d.ts 类型 =====
async function test2_globalDTs() {
  console.log('\n[2] global.d.ts 声明 app 接口');
  const src = await fs.readFile('renderer/src/global.d.ts', 'utf-8');
  log(/app: \{/.test(src), '声明 app 命名空间', '');
  log(/getVersion: \(\) => Promise<string>/.test(src), 'getVersion 类型', '');
  log(/getPlatform: \(\) => Promise<string>/.test(src), 'getPlatform 类型', '');
}

// ===== 3) handlers 注册 =====
async function test3_handlersRegister() {
  console.log('\n[3] handlers.ts 注册 app:getVersion / app:getPlatform');
  const src = await fs.readFile('electron/ipc/handlers.ts', 'utf-8');
  log(/import \{[^}]*\bapp\b[^}]*\} from 'electron'/.test(src), 'import app from electron', '');
  log(/ipcMain\.handle\('app:getVersion'/.test(src), 'app:getVersion handler', '');
  log(/app\.getVersion\(\)/.test(src), '调 app.getVersion()', '');
  log(/ipcMain\.handle\('app:getPlatform'/.test(src), 'app:getPlatform handler', '');
  log(/process\.platform/.test(src), '调 process.platform', '');
}

// ===== 4) SettingsSheet 不再硬编码 =====
async function test4_settingsSheet() {
  console.log('\n[4] SettingsSheet.tsx 动态读版本');
  const src = await fs.readFile('renderer/src/components/SettingsSheet.tsx', 'utf-8');
  log(/const \[appVersion, setAppVersion\] = useState<string>/.test(src), '声明 appVersion state', '');
  log(/window\.cnke\.app\.getVersion\(\)/.test(src), '调 window.cnke.app.getVersion()', '');
  log(/版本 \{appVersion\}/.test(src), '渲染动态版本', '');
  // 不应再硬编码 "版本 1.2.x" 字面量
  const hardcodedLines = src.split('\n').filter((l) => /版本\s*1\.\d+(\.\d+)?['"`]/.test(l));
  log(hardcodedLines.length === 0, '无硬编码版本字面量', `found=${hardcodedLines.length}: ${hardcodedLines.join(' | ')}`);
}

// ===== 5) package.json 版本 =====
async function test5_packageVersion() {
  console.log('\n[5] package.json 版本 1.2.3');
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf-8'));
  log(pkg.version === '1.2.3', 'version=1.2.3', `v=${pkg.version}`);
}

// ===== 6) 扫整个 renderer 看是否还有硬编码 =====
async function test6_noHardcoded() {
  console.log('\n[6] 整个 renderer 无版本硬编码（排除 useState 初始占位）');
  const files = [
    'renderer/src/components/SettingsSheet.tsx',
    'renderer/src/App.tsx',
    'renderer/src/main.tsx',
  ];
  for (const f of files) {
    const src = await fs.readFile(f, 'utf-8');
    // 排除：注释行、useState 初值（合理占位）
    const lines = src.split('\n');
    const realMatches = lines.filter((l) => {
      if (/^\s*\/\//.test(l)) return false; // 注释
      if (/useState<[^>]+>\(['"`]1\.[2-3]/.test(l)) return false; // useState 占位
      if (/['"`]v?1\.[2-3]\.\d+['"`]/.test(l)) return true;
      return false;
    });
    log(realMatches.length === 0, `${f} 无真实硬编码`, `lines=${realMatches.length}: ${realMatches.join(' | ').slice(0, 100)}`);
  }
}

(async () => {
  console.log('=== W14 版本号 BUG 修复测试 ===');
  await test1_preloadExposes();
  await test2_globalDTs();
  await test3_handlersRegister();
  await test4_settingsSheet();
  await test5_packageVersion();
  await test6_noHardcoded();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
