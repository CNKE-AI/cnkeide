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
  // NSIS 使用 $LOCALAPPDATA\cnkeide-updater\pending 形式，反斜杠或正斜杠均可
  log(/pending/i.test(content), '含 pending 路径', '');
  log(/cnkeide-updater.{0,20}pending/i.test(content), '清理 cnkeide-updater/pending', '');
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
  console.log('\n[6] UpdateManager.ts 清理残留进程');
  const src = await fs.readFile('electron/updater/UpdateManager.ts', 'utf-8');
  log(/killResidualProcessesAsync/.test(src), '含异步清理方法', '');
  log(/taskkill/i.test(src), '使用 taskkill', '');
  log(/Promise\.allSettled/.test(src), '并行执行清理命令', '');
}

async function test7_updateManagerAutoInstall() {
  console.log('\n[7] UpdateManager 可配置自动安装');
  const src = await fs.readFile('electron/updater/UpdateManager.ts', 'utf-8');
  log(/update\.autoInstall/.test(src), '读取 autoInstall 配置', '');
  log(/update\.autoInstallDelaySec/.test(src), '读取自动安装延迟配置', '');
  log(/delaySec \* 1000/.test(src), '延迟以秒配置并换算毫秒', '');
  log(/this\.pendingInstall/.test(src), '防重入检查', '');
}

async function test8_installNowFlow() {
  console.log('\n[8] installNow 流程');
  const src = await fs.readFile('electron/updater/UpdateManager.ts', 'utf-8');
  const match = src.match(/installNow\(\):[^{]*\{([\s\S]*?)\n  \}/);
  if (match) {
    const body = match[1];
    log(/killResidualProcessesAsync/.test(body), '先异步清理残留进程', '');
    log(/setTimeout/.test(body), '安装前包含释放句柄延时', '');
    log(/quitAndInstall/.test(body), '调用 quitAndInstall', '');
    log(/setTimeout\(r, 600\)/.test(body) && /setTimeout\(r, 200\)/.test(body), '使用短暂分阶段延时', '');
  } else {
    log(false, '未找到 installNow 方法', '');
  }
}

// ===== 9) package.json version =====
async function test9_packageVersion() {
  console.log('\n[9] package.json 与锁文件版本一致');
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf-8'));
  const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf-8'));
  log(/^\d+\.\d+\.\d+$/.test(pkg.version), 'package.json 使用语义化版本', `v=${pkg.version}`);
  log(lock.version === pkg.version && lock.packages?.['']?.version === pkg.version, 'package-lock 版本与 package.json 一致', `lock=${lock.version}`);
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
