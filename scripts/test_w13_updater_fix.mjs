/**
 * W13 更新器 BUG 修复测试
 * 验证：1) killResidualProcesses 调用 taskkill  2) NSIS installer.nsh 包含清理逻辑
 *        3) installNow 流程正确  4) 自动模式 5s 倒计时
 *
 * 用法：npx tsx scripts/test_w13_updater_fix.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

// ===== 1) NSIS 脚本 =====
async function test1_nsisExists() {
  console.log('\n[1] build/installer.nsh 存在');
  const f = path.join('build', 'installer.nsh');
  try {
    const content = await fs.readFile(f, 'utf-8');
    log(true, '文件存在', `len=${content.length}`);
  } catch (e) {
    log(false, '文件不存在', e.message);
  }
}

async function test2_nsisCleanOldUpdater() {
  console.log('\n[2] NSIS 清理旧 cnke-claw-updater');
  const content = await fs.readFile('build/installer.nsh', 'utf-8');
  log(/cnke-claw-updater/.test(content), '含 cnke-claw-updater 路径', '');
  log(/RMDir/i.test(content), '使用 RMDir 删除', '');
  log(/customInstall/.test(content), '在 customInstall 宏里', '');
}

async function test3_nsisCleanPending() {
  console.log('\n[3] NSIS 清理 pending');
  const content = await fs.readFile('build/installer.nsh', 'utf-8');
  log(/pending/.test(content), '含 pending 路径', '');
  log(/cnkeide-updater\\pending/.test(content) || /cnkeide-updater.{0,10}pending/.test(content), '清理 cnkeide-updater/pending', '');
}

async function test4_nsisUninstallCleanup() {
  console.log('\n[4] NSIS 卸载时清理');
  const content = await fs.readFile('build/installer.nsh', 'utf-8');
  log(/customUnInstall/.test(content), '含 customUnInstall 宏', '');
  log(/cnkeide-updater/.test(content) && /RMDir/i.test(content), '卸载时也清 cnkeide-updater', '');
}

async function test5_electronBuilderInclude() {
  console.log('\n[5] electron-builder.json 引用 installer.nsh');
  const eb = JSON.parse(await fs.readFile('electron-builder.json', 'utf-8'));
  log(eb.nsis?.include === 'build/installer.nsh', 'nsis.include 已配置', `v=${eb.nsis?.include}`);
}

// ===== 6) UpdateManager 代码层 =====
async function test6_updateManagerSource() {
  console.log('\n[6] UpdateManager.ts 包含 killResidualProcesses');
  const src = await fs.readFile('electron/updater/UpdateManager.ts', 'utf-8');
  log(/killResidualProcesses/.test(src), '含 killResidualProcesses 方法', '');
  log(/taskkill/i.test(src), '使用 taskkill', '');
  // 允许跨行：setTimeout 在前，2000 在后（中间可能有其它字符）
  log(/setTimeout[\s\S]{0,500}2000/.test(src), 'setTimeout 2000ms', '');
}

async function test7_updateManagerAutoInstall() {
  console.log('\n[7] UpdateManager auto 模式 5s 倒计时');
  const src = await fs.readFile('electron/updater/UpdateManager.ts', 'utf-8');
  log(/5000/.test(src), '含 5s 自动安装', '');
  log(/this\.status\.mode === 'auto'/.test(src), '仅 auto 模式自动装', '');
  log(/this\.pendingInstall/.test(src), '防重入检查', '');
}

async function test8_installNowFlow() {
  console.log('\n[8] installNow 流程');
  const src = await fs.readFile('electron/updater/UpdateManager.ts', 'utf-8');
  // 找 installNow 方法体
  const match = src.match(/installNow\(\):[^{]*\{([\s\S]*?)\n  \}/);
  if (match) {
    const body = match[1];
    log(/killResidualProcesses/.test(body), '先调 killResidualProcesses', '');
    log(/setTimeout/.test(body), 'setTimeout 延时', '');
    log(/quitAndInstall/.test(body), '调用 quitAndInstall', '');
    log(/2000/.test(body), '2s 延时', '');
  } else {
    log(false, '未找到 installNow 方法', '');
  }
}

// ===== 9) package.json version =====
async function test9_packageVersion() {
  console.log('\n[9] package.json 版本 1.2.2');
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf-8'));
  log(pkg.version === '1.2.2', 'version=1.2.2', `v=${pkg.version}`);
}

(async () => {
  console.log('=== W13 更新器 BUG 修复测试 ===');
  await test1_nsisExists();
  await test2_nsisCleanOldUpdater();
  await test3_nsisCleanPending();
  await test4_nsisUninstallCleanup();
  await test5_electronBuilderInclude();
  await test6_updateManagerSource();
  await test7_updateManagerAutoInstall();
  await test8_installNowFlow();
  await test9_packageVersion();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
