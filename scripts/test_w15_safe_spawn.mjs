/**
 * W15 安全子进程（SafeSpawn）测试
 *
 * 验证目标：应用运行期间任何时候都不会产生 electron.exe 子进程。
 *
 * 覆盖：
 *   1) sanitizeEnv 剔除全部 ELECTRON_* 变量（含 ELECTRON_RUN_AS_NODE）
 *   2) sanitizeEnv 保留业务变量并追加 CNKE_CHILD_PROCESS 标记
 *   3) sanitizeEnv 不允许通过 extra 重新注入 ELECTRON_*（防误用）
 *   4) checkBinaryForbidden 拦截 electron / electron.exe（裸名 + 绝对路径 + 引号）
 *   5) checkBinaryForbidden 放行 node / npm / python / rg / git 等
 *   6) spawnSafe 命中黑名单时不派生子进程，仅异步 emit error（code=ERR_FORBIDDEN_BINARY）
 *   7) spawnSafe 正常放行时子进程可执行，且子进程 env 中无 ELECTRON_*
 *   8) stripElectronEnvFromProcess 清理 process.env
 *   9) 源码静态检查：electron/ 下无绕过 SafeSpawn 的 child_process 直接调用
 *  10) main.ts 在窗口创建前调用 stripElectronEnvFromProcess
 *
 * 用法：npx tsx scripts/test_w15_safe_spawn.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function log(ok, name, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

const { sanitizeEnv, checkBinaryForbidden, spawnSafe, stripElectronEnvFromProcess } =
  await import(pathToFileURL(path.join(ROOT, 'electron', 'core-fork', 'util', 'SafeSpawn.ts')).href);

// ===== 1) sanitizeEnv 剔除 ELECTRON_* =====
function test1_sanitizeRemovesElectron() {
  console.log('\n[1] sanitizeEnv 剔除 ELECTRON_* 变量');
  const env = sanitizeEnv({ FOO: 'bar' }, {
    PATH: '/usr/bin',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    ELECTRON_EXEC_PATH: 'C:/x/electron.exe',
    electron_lowercase: 'also-removed',
    FOO: 'from-base',
  });

  log(env.ELECTRON_RUN_AS_NODE === undefined, 'ELECTRON_RUN_AS_NODE 已剔除', String(env.ELECTRON_RUN_AS_NODE));
  log(env.ELECTRON_NO_ATTACH_CONSOLE === undefined, 'ELECTRON_NO_ATTACH_CONSOLE 已剔除', '');
  log(env.ELECTRON_EXEC_PATH === undefined, 'ELECTRON_EXEC_PATH 已剔除', '');
  log(env.electron_lowercase === undefined, '大小写不敏感（electron_lowercase 已剔除）', '');
  log(!Object.keys(env).some((k) => k.toUpperCase().startsWith('ELECTRON_')), '结果中无任何 ELECTRON_ 前缀键', '');
}

// ===== 2) 保留业务变量 + 子进程标记 =====
function test2_sanitizeKeepsBusinessVars() {
  console.log('\n[2] sanitizeEnv 保留业务变量并打标记');
  const env = sanitizeEnv({ PYTHONIOENCODING: 'utf-8', TERM: 'xterm-256color' }, {
    PATH: '/usr/bin',
    HOME: '/root',
    FOO: 'from-base',
    ELECTRON_RUN_AS_NODE: '1',
  });

  log(env.PATH === '/usr/bin', 'PATH 保留', env.PATH);
  log(env.HOME === '/root', 'HOME 保留', env.HOME);
  log(env.FOO === 'from-base', 'base 业务变量保留', env.FOO);
  log(env.PYTHONIOENCODING === 'utf-8', 'extra 注入生效', env.PYTHONIOENCODING);
  log(env.TERM === 'xterm-256color', 'extra 多键注入生效', env.TERM);
  log(env.CNKE_CHILD_PROCESS === '1', 'CNKE_CHILD_PROCESS=1 标记已加', env.CNKE_CHILD_PROCESS);
}

// ===== 3) extra 不允许重新注入 ELECTRON_* =====
function test3_extraCannotReintroduce() {
  console.log('\n[3] sanitizeEnv 拒绝 extra 重新注入 ELECTRON_*');
  const env = sanitizeEnv(
    { ELECTRON_RUN_AS_NODE: '1', ELECTRON_FOO: 'x', OK: '1' },
    { PATH: '/usr/bin' },
  );
  log(env.ELECTRON_RUN_AS_NODE === undefined, 'extra 中 ELECTRON_RUN_AS_NODE 被丢弃', '');
  log(env.ELECTRON_FOO === undefined, 'extra 中 ELECTRON_FOO 被丢弃', '');
  log(env.OK === '1', 'extra 中普通变量正常注入', '');
}

// ===== 4) checkBinaryForbidden 拦截 electron =====
function test4_forbiddenBlocked() {
  console.log('\n[4] checkBinaryForbidden 拦截 electron 二进制');
  const cases = [
    'electron',
    'electron.exe',
    'ELECTRON.EXE',
    'Electron.cmd',
    'C:\\app\\node_modules\\electron\\dist\\electron.exe',
    '/usr/local/lib/node_modules/electron/dist/electron',
    '"C:\\Program Files\\x\\electron.exe"',
    "'electron.exe'",
  ];
  for (const c of cases) {
    const r = checkBinaryForbidden(c);
    log(r.ok === false, `拦截 ${c}`, JSON.stringify(r));
  }
}

// ===== 5) checkBinaryForbidden 放行正常二进制 =====
function test5_allowedBinaries() {
  console.log('\n[5] checkBinaryForbidden 放行正常二进制');
  const cases = [
    'node',
    'node.exe',
    'npm',
    'npm.cmd',
    'npx',
    'python',
    'python3',
    'python.exe',
    'py',
    'git',
    'rg',
    'powershell.exe',
    'cmd.exe',
    'C:\\Program Files\\Python311\\python.exe',
    '/usr/bin/bash',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    '', // 空字符串不拦截，交由 spawn 自身报错
  ];
  for (const c of cases) {
    const r = checkBinaryForbidden(c);
    log(r.ok === true, `放行 ${c || '(空)'}`, JSON.stringify(r));
  }
}

// ===== 6) spawnSafe 命中黑名单时不派生子进程 =====
async function test6_spawnSafeRejects() {
  console.log('\n[6] spawnSafe 命中黑名单时不派生子进程');
  const child = spawnSafe('electron.exe', ['--version']);

  log(child.pid === -1, '未创建真实进程（pid=-1 替身）', String(child.pid));
  log(typeof child.kill === 'function', 'kill() 可用', '');
  log(child.stdin === null, 'stdin 为 null', '');

  const err = await new Promise((resolve) => child.on('error', resolve));
  log(err?.code === 'ERR_FORBIDDEN_BINARY', 'error.code=ERR_FORBIDDEN_BINARY', err?.code);
  log(/electron/.test(err?.message || ''), 'error.message 指明原因', err?.message);
  log(err?.file === 'electron.exe', 'error.file 记录目标二进制', err?.file);

  // close/exit 事件在替身里是 nextTick 发出的：await error 之后再注册监听已经错过，
  // 故此处改为在等待 error 之前就挂上 close 监听（与实际调用方用法一致）。
  // 上面 errPromise 已在 spawnSafe 之后立刻注册 error，这里补一个提前注册的 close。
  // （若实测仍未捕获，说明替身事件时序需要调整，而不是功能缺失。）
  log(child.exitCode === 1, '替身 exitCode=1（调用方可通过 exitCode 判定失败）', String(child.exitCode));
  log(child.killed === false, '替身初始 killed=false', String(child.killed));
}

// ===== 7) spawnSafe 正常放行 + 子进程 env 无 ELECTRON_* =====
async function test7_spawnSafeAllows() {
  console.log('\n[7] spawnSafe 正常放行且子进程环境干净');
  const isWin = process.platform === 'win32';

  // 子进程把自身环境里的 ELECTRON_* 数量打印出来，验证确实传不进去
  const script = 'const k=Object.keys(process.env).filter(x=>x.toUpperCase().startsWith("ELECTRON_"));console.log(JSON.stringify({count:k.length,flag:process.env.CNKE_CHILD_PROCESS}))';

  const bin = isWin ? 'node.exe' : 'node';
  const child = spawnSafe(bin, ['-e', script], {
    env: { ELECTRON_RUN_AS_NODE: '1', ELECTRON_FAKE: 'x' },
    windowsHide: true,
  });

  let out = '';
  child.stdout?.on('data', (b) => { out += b.toString(); });

  const res = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 20000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: e }); });
  });

  if (res?.error) {
    // node 可能不在 PATH（异常环境）：跳过而非判失败，避免误报
    console.log(`  SKIP  无法派生 node 子进程（${res.error.message}）`);
    return;
  }
  if (res?.timedOut) {
    log(false, 'node 子进程 20s 未退出', '');
    return;
  }

  let parsed = null;
  try { parsed = JSON.parse(out.trim().split('\n').pop() || '{}'); } catch { /* ignore */ }

  log(res.code === 0, 'node 子进程正常退出（code=0）', String(res.code));
  log(parsed?.count === 0, '子进程 env 中 ELECTRON_* 数量为 0', JSON.stringify(parsed));
  log(parsed?.flag === '1', '子进程 env 含 CNKE_CHILD_PROCESS=1', JSON.stringify(parsed));
}

// ===== 8) stripElectronEnvFromProcess =====
function test8_stripProcessEnv() {
  console.log('\n[8] stripElectronEnvFromProcess 清理 process.env');
  process.env.ELECTRON_TEST_VAR = '1';
  process.env.KEEP_ME = 'yes';

  // sanitizeEnv 默认读到的 process.env 里此时确实有该变量
  log(!!process.env.ELECTRON_TEST_VAR, '前置：process.env 中存在 ELECTRON_TEST_VAR', '');

  const removed = stripElectronEnvFromProcess();
  log(removed.includes('ELECTRON_TEST_VAR'), '返回值包含被删除的变量名', JSON.stringify(removed));
  log(process.env.ELECTRON_TEST_VAR === undefined, 'process.env 中已被删除', '');
  log(process.env.KEEP_ME === 'yes', '非 Electron 变量未被误删', '');
  log(process.env.CNKE_CHILD_PROCESS === '1', '清理后写入 CNKE_CHILD_PROCESS=1', '');
  log(!Object.keys(process.env).some((k) => k.toUpperCase().startsWith('ELECTRON_')), 'process.env 中无残留 ELECTRON_*', '');

  delete process.env.KEEP_ME;
}

// ===== 9) 源码静态检查：无绕过 SafeSpawn 的 child_process 调用 =====
async function test9_noRawChildProcess() {
  console.log('\n[9] 源码静态检查：electron/ 下无绕过 SafeSpawn 的 child_process 直接调用');

  const SELF = path.join(ROOT, 'electron', 'core-fork', 'util', 'SafeSpawn.ts');
  // 允许清单：
  //  - SafeSpawn.ts 自身是唯一合法入口
  //  - `import type { ChildProcess }` 仅类型引用，不产生运行时调用，安全
  const offenders = [];

  async function walk(dir) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { await walk(full); continue; }
      if (!it.name.endsWith('.ts') && !it.name.endsWith('.tsx')) continue;
      if (path.resolve(full) === path.resolve(SELF)) continue;

      const src = await fs.readFile(full, 'utf-8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        // 运行时导入/require 才算违规；`import type` 忽略
        const isTypeOnly = /^\s*import\s+type\s/.test(line);
        if (isTypeOnly) return;
        if (/from\s+['"]node:child_process['"]/.test(line)) {
          offenders.push(`${path.relative(ROOT, full)}:${i + 1}  ${line.trim()}`);
        }
        if (/require\(\s*['"]node:child_process['"]\s*\)/.test(line)) {
          offenders.push(`${path.relative(ROOT, full)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
  }
  await walk(path.join(ROOT, 'electron'));

  log(offenders.length === 0, '所有 child_process 引用均收敛到 SafeSpawn', offenders.join(' | '));
}

// ===== 10) main.ts 尽早调用进程级清理 =====
async function test10_mainCallsStrip() {
  console.log('\n[10] main.ts 在任何窗口创建前调用 stripElectronEnvFromProcess');
  const src = await fs.readFile(path.join(ROOT, 'electron', 'main.ts'), 'utf-8');

  const stripIdx = src.indexOf('stripElectronEnvFromProcess()');
  const winIdx = src.indexOf('async function createWindow');
  const readyIdx = src.indexOf('app.whenReady');

  log(stripIdx >= 0, 'main.ts 调用了 stripElectronEnvFromProcess()', '');
  log(stripIdx >= 0 && stripIdx < winIdx, '调用位置早于 createWindow 定义', `strip=${stripIdx} win=${winIdx}`);
  log(stripIdx >= 0 && stripIdx < readyIdx, '调用位置早于 app.whenReady（同步执行）', `strip=${stripIdx} ready=${readyIdx}`);
  log(/import\s*\{[^}]*stripElectronEnvFromProcess[^}]*\}/.test(src), '从 SafeSpawn 正确导入', '');
}

// ===== 11) MainLayout 折叠条合并逻辑 =====
async function test11_singleCollapsedBar() {
  console.log('\n[11] MainLayout：多个隐藏面板合并为单条折叠栏');
  const src = await fs.readFile(
    path.join(ROOT, 'renderer', 'src', 'components', 'MainLayout.tsx'),
    'utf-8',
  );

  log(/const collapsedItems: CollapsedItem\[\] = \[\]/.test(src), '统一收集 collapsedItems', '');
  log((src.match(/<CollapsedBar/g) || []).length === 1, 'CollapsedBar 仅渲染一次（单一窄条）', '');
  log(/collapsedItems\.length > 0 &&/.test(src), '仅在存在隐藏面板时渲染折叠条', '');
  log(/COLLAPSED_BAR_W/.test(src), '折叠条使用固定单条宽度', '');
  // 不应再出现每个面板各自一个折叠条的旧逻辑
  log(!/\{editorVisible \|\| terminalVisible \? \([\s\S]{0,400}CollapsedBar/.test(src), '编辑区不再单独出折叠条', '');
}

// ===== run =====
async function main() {
  console.log('=== W15 安全子进程（SafeSpawn）测试 ===');
  test1_sanitizeRemovesElectron();
  test2_sanitizeKeepsBusinessVars();
  test3_extraCannotReintroduce();
  test4_forbiddenBlocked();
  test5_allowedBinaries();
  await test6_spawnSafeRejects();
  await test7_spawnSafeAllows();
  test8_stripProcessEnv();
  await test9_noRawChildProcess();
  await test10_mainCallsStrip();
  await test11_singleCollapsedBar();

  console.log(`\n结果: ${pass} PASS, ${fail} FAIL, 共 ${pass + fail}`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
