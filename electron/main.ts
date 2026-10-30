import { app, BrowserWindow, ipcMain, Menu, dialog, shell, Tray, Notification, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { registerIpcHandlers } from './ipc/handlers';
import { initPptMaster } from './core-fork/pptmaster';
import { ConfigAdapter } from './adapter/ConfigAdapter';
import { createMenu } from './menu';
import { stripElectronEnvFromProcess } from './core-fork/util/SafeSpawn';

// ===== 硬约束：应用运行期间不得产生 electron.exe 子进程 =====
// 必须在任何窗口创建 / 任何子进程派生之前执行：
// 移除 process.env 里 Electron 注入的 ELECTRON_* 变量（ELECTRON_RUN_AS_NODE 等），
// 避免它们被透传给子进程后，某个被子进程（node/npm/python）被解析成 electron.exe
// 并以 Node 模式启动，在任务管理器里多出 electron.exe。
// 之后所有走 SafeSpawn 的派生还会做二进制黑名单二次拦截；此处的进程级清理
// 是兜底，覆盖直接调用 child_process 的第三方库。
const removedElectronEnv = stripElectronEnvFromProcess();
if (removedElectronEnv.length > 0) {
  console.log('[SafeSpawn] 已移除 Electron 注入环境变量，杜绝 electron.exe 子进程:', removedElectronEnv.join(', '));
}

// 全局未捕获异常守卫：吞掉原生句柄销毁等竞态错误，避免主进程崩溃弹窗
// 典型场景：关闭应用时子进程 ChildProcess._handle.onexit 触发，前端 BrowserWindow/webContents
// 已销毁，事件回调里访问 webContents.send 会抛 "Object has been destroyed"，
// 进一步导致渲染进程 IPC 消息丢失，loading 状态卡死、输入框无法输入。
process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  // 原生句柄销毁 / 已关闭窗口导致的访问错误：可恢复，静默吞掉
  if (/Object has been destroyed|Object has been released|webContents destroyed/i.test(msg)) {
    console.warn('[uncaughtException] swallowed:', msg);
    return;
  }
  // 其它未处理异常：打印到日志（Crashpad 会同时上报），不静默
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  const msg = (reason as Error)?.message || String(reason);
  if (/Object has been destroyed|Object has been released|webContents destroyed/i.test(msg)) {
    console.warn('[unhandledRejection] swallowed:', msg);
    return;
  }
  console.error('[unhandledRejection]', reason);
});

let mainWindow: BrowserWindow | null = null;
let pptWindow: BrowserWindow | null = null;
let appCleanup: { dispose: () => void } | null = null;
let tray: Tray | null = null;
const configAdapter = new ConfigAdapter();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 页面加载失败时的兜底页。
 *
 * 不兜底的话 Electron 会显示内置错误页：纯深色背景、没有任何文字，
 * 用户看到的就是「整个窗口全黑但程序没崩」，根本无从判断是代码坏了还是
 * 开发服务器没起来（W19 验证时就踩过一次）。这里给一句人话 + 可点的重试链接。
 */
async function showLoadFailurePage(win: BrowserWindow, err: unknown, retryUrl: string): Promise<void> {
  const msg = escapeHtml(err instanceof Error ? err.message : String(err));
  const isDevUrl = /^https?:\/\//.test(retryUrl);
  const hint = isDevUrl
    ? `开发服务器没有响应。请在项目根目录运行 <code>npm run dev</code> 后点下方重试。`
    : `这是安装包内的资源加载失败，建议重新安装或把下面的错误信息反馈给开发者。`;

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>启动失败</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0a0a; color:#e5e5e5;
         font:14px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .card { max-width:560px; padding:28px 32px; border:1px solid #2a2a2a; border-radius:12px; background:#111; }
  h1 { margin:0 0 12px; font-size:17px; color:#f87171; }
  p { margin:0 0 10px; color:#a3a3a3; }
  code { padding:1px 5px; border-radius:4px; background:#1f1f1f; color:#d4d4d4; }
  pre { margin:12px 0 0; padding:10px 12px; border-radius:8px; background:#0d0d0d;
        border:1px solid #242424; color:#fca5a5; font-size:12px; white-space:pre-wrap; word-break:break-all; }
  a { display:inline-block; margin-top:16px; color:#c4b5fd; }
</style></head>
<body><div class="card">
  <h1>页面加载失败</h1>
  <p>${hint}</p>
  <p>目标地址：<code>${escapeHtml(retryUrl)}</code></p>
  <pre>${msg}</pre>
  <a href="${escapeHtml(retryUrl)}">重试</a>
</div></body></html>`;

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.show();
  } catch {
    /* 连兜底页都加载不了就只能放弃，保留原始控制台错误 */
  }
}

/** 渲染层错误 / 崩溃日志的最大字节数，超过后轮转一份 .1 */
const RENDERER_LOG_MAX_BYTES = 1024 * 1024;

/**
 * 把渲染层错误与崩溃原因落盘到 <userData>/logs/renderer-error.log。
 *
 * 为什么需要：界面白屏之后用户根本没法打开 DevTools，事后没有任何线索可查，
 * 只能"重启试试"。把崩溃原因和渲染层的 console.error 记下来，才有得定位。
 */
function appendRendererLog(text: string): void {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'renderer-error.log');
    try {
      if (fs.statSync(file).size > RENDERER_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* 首次写入：文件还不存在 */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {
    /* 写日志失败绝不能影响主流程 */
  }
}

// ===== 调试端口 =====
// 开发期可选开启 CDP（只在显式设置 CNKE_DEBUG_PORT 时生效），便于自动化验收界面。
// 平时不设置环境变量就完全不会监听，不影响正常使用与安全面。
if (process.env.CNKE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.CNKE_DEBUG_PORT));
}

// ===== 调试用 userData 隔离 =====
// 打包版与开发版共用同一个 userData 目录，而单实例锁按 userData 加锁：
// 用户在用的安装版一旦在跑，`npm run dev` 会被锁直接 app.quit()，开发版根本起不来。
// 显式设置 CNKE_USER_DATA_DIR 时改用独立目录（配置为空，只用于界面/渲染层调试）。
if (process.env.CNKE_USER_DATA_DIR) {
  try {
    app.setPath('userData', process.env.CNKE_USER_DATA_DIR);
    console.log('[debug] userData 已切换到', process.env.CNKE_USER_DATA_DIR);
  } catch (e) {
    console.warn('[debug] 切换 userData 失败:', e);
  }
}

// ===== 单实例锁 =====
// 必须放在任何窗口创建之前。第二个实例启动时直接退出，并把已有窗口唤到前台，
// 避免同一 userData 目录被两个进程同时读写（配置/会话/索引）导致数据错乱。
// CNKE_USER_DATA_DIR：测试/多开场景指定独立数据目录，从而绕开单实例锁（产品运行不设置，零影响）。
if (process.env.CNKE_USER_DATA_DIR) {
  app.setPath('userData', process.env.CNKE_USER_DATA_DIR);
}
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  // 已有实例在运行：立即退出本进程（不弹窗、不建窗口）
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户重复双击图标：把已有窗口唤到前台
    if (pptWindow && !pptWindow.isDestroyed() && pptWindow.isFocused()) {
      return;
    }
    showMainWindow();
    if (pptWindow && !pptWindow.isDestroyed()) {
      pptWindow.show();
      pptWindow.focus();
    }
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    show: true,
    title: 'CnkeIDE',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      // 预览面板需要内嵌用户本地 dev server（跨源 iframe 无法注入脚本，只能用 webview）
      webviewTag: true,
    },
  });

  // ===== 麦克风权限：语音输入（内置离线识别）需要 getUserMedia =====
  // Electron 默认拒绝媒体权限请求，必须显式放行；仅允许 'media'，
  // webview/iframe 内第三方页面（预览站点等）不自动放行。
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  // ===== 崩溃自愈：白屏兜底 =====
  // 跑重负载任务（典型：让 Agent 全盘扫描 / 清理 C 盘）时，渲染进程可能被 OOM 杀掉，
  // 或 GPU 合成进程崩溃。这两种情况下 Electron 只是把窗口内容丢掉：不报错、不自动恢复，
  // 用户看到的就是"整窗一片白，只能强杀重启"。这里统一兜底：
  //   崩溃落盘 → 自动 reload（限频，避免"必崩状态"造成无限重载死循环）
  //   短时间反复崩溃 → 显示可读的错误页，绝不静默白屏。
  const crashTimestamps: number[] = [];
  const CRASH_WINDOW_MS = 10 * 60 * 1000;
  const CRASH_MAX_RELOADS = 3;

  const recoverFromCrash = (kind: string, reason: string): void => {
    const line = `[crash] ${kind} gone: ${reason}`;
    console.error(line);
    appendRendererLog(line);
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const now = Date.now();
    while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CRASH_WINDOW_MS) crashTimestamps.shift();
    crashTimestamps.push(now);

    const target = mainWindow.webContents.getURL();
    if (crashTimestamps.length > CRASH_MAX_RELOADS) {
      void showLoadFailurePage(
        mainWindow,
        new Error(
          `界面在 10 分钟内连续 ${crashTimestamps.length} 次崩溃，已停止自动重载以免陷入死循环。\n` +
            `最近一次崩溃：${kind} / ${reason}\n` +
            '常见诱因：单条命令输出体量过大（如全盘递归扫描）、或内存被占满。\n' +
            '重启后建议把命令范围缩小（限定目录、加 -Depth/-First/过滤条件）再重试。',
        ),
        target,
      );
      return;
    }
    // 崩溃后立刻 reload 有时会撞上还没销毁干净的 webContents，稍等片刻再恢复
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[crash] 正在自动恢复界面…');
        mainWindow.reload();
      }
    }, 500);
  };

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    recoverFromCrash('renderer', `${details.reason} (exitCode=${details.exitCode})`);
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[crash] 渲染进程无响应（长任务 / 大输出时常见），等待其恢复…');
    appendRendererLog('[crash] renderer unresponsive');
  });
  mainWindow.webContents.on('responsive', () => {
    console.log('[crash] 渲染进程已恢复响应');
    appendRendererLog('[crash] renderer responsive again');
  });

  // GPU 进程崩溃不会触发 render-process-gone，但同样表现成白屏
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') recoverFromCrash('gpu', details.reason);
    else console.error(`[crash] ${details.type} gone: ${details.reason}`);
  });

  // 渲染层未捕获异常落盘（白屏后用户无法打开 DevTools，只能靠日志回溯）
  mainWindow.webContents.on('console-message', ((...args: any[]) => {
    const second = args[1];
    const info =
      second && typeof second === 'object'
        ? second
        : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
    const level = typeof info.level === 'string' ? info.level : info.level >= 3 ? 'error' : 'info';
    if (level !== 'error') return;
    appendRendererLog(
      `[renderer:error] ${String(info.message).slice(0, 4000)} (${String(info.sourceId)}:${String(info.lineNumber)})`,
    );
  }) as never);

  // 预览 webview 的安全护栏：无论页面怎么声明，都强制关闭 Node 集成与外部 preload，
  // 避免用户在内嵌预览里打开的任意站点拿到主进程能力
  mainWindow.webContents.on('will-attach-webview', (_e, webPreferences) => {
    delete (webPreferences as { preload?: string }).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
  });
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    // 加载失败不能直接抛：那样窗口保持隐藏/空白，用户只会看到一个黑窗
    try {
      await mainWindow.loadURL(devUrl);
    } catch (err) {
      console.error('[startup] 开发服务器加载失败:', err);
      await showLoadFailurePage(mainWindow, err, devUrl);
    }
    // DevTools 仅在显式要求时弹出（设置环境变量 CNKE_DEVTOOLS=1），避免运行时弹额外窗口
    if (process.env.CNKE_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    // __dirname = <root>/renderer/dist-electron，产物 dist/ 在项目根：<root>/dist/index.html
    const indexFile = path.join(__dirname, '../../dist/index.html');
    try {
      await mainWindow.loadFile(indexFile);
    } catch (err) {
      console.error('[startup] 应用资源加载失败:', err);
      await showLoadFailurePage(mainWindow, err, indexFile);
    }
  }

  // 立即显示窗口，避免 ready-to-show 不触发导致窗口永久隐藏
  mainWindow.show();

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 窗口保护（任务执行期防误最小化 / 尺寸护栏）
  attachWindowGuards(mainWindow, { minWidth: 1000, minHeight: 600 });

  // 任务进行中关闭主窗口 → 二次确认，避免误触导致任务中断且窗口消失
  mainWindow.on('close', (event) => {
    if (!agentBusy) return;
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['继续执行', '仍要关闭'],
      defaultId: 0,
      cancelId: 0,
      title: 'AI 任务正在执行',
      message: 'AI 任务尚未完成，关闭窗口会中断当前任务。',
      detail: '确定要关闭吗？',
      noLink: true,
    });
    if (choice === 0) {
      event.preventDefault();
      notifyBusyGuard('AI 任务执行中，已取消关闭');
    }
  });

  // 兜底：页面加载后强制显示，避免 ready-to-show 未触发导致窗口永久隐藏
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    }, 1000);
  });

  // 可见性看门狗：任务执行期间每 2s 检查一次，被外部手段（系统快捷键 / 任务栏 /
  // 第三方窗口管理器）最小化或隐藏时立即拉回，保证长任务跑完时窗口一定在眼前。
  const guardTimer = setInterval(() => {
    if (!agentBusy || !mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
      notifyBusyGuard('检测到窗口被最小化，已自动恢复');
    } else if (!mainWindow.isVisible()) {
      mainWindow.show();
      notifyBusyGuard('检测到窗口被隐藏，已自动恢复');
    }
  }, 2000);
  mainWindow.on('closed', () => clearInterval(guardTimer));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 广播窗口最大化状态变化，供渲染进程切换「最大化/还原」按钮图标
  const broadcastMaximizeState = () => {
    mainWindow?.webContents.send('window:maximized-changed', mainWindow?.isMaximized() ?? false);
  };
  mainWindow.on('maximize', broadcastMaximizeState);
  mainWindow.on('unmaximize', broadcastMaximizeState);
}

/**
 * 窗口保护
 *
 * 目标：AI 任务执行期间，窗口不应被误最小化 / 误关闭后「消失不见」，
 * 同时阻止窗口被清零尺寸或拖出可视区域导致再也点不到。
 *
 * 策略：
 *  1) 记录「任务进行中」状态（由渲染进程通过 IPC 同步）。
 *  2) 任务进行中收到 minimize → 不真正最小化，改为提示并返回（拦截）。
 *  3) 任务进行中收到 close → 弹确认框，用户确认才关闭。
 *  4) 兜底：若窗口被外部手段（系统快捷键 / 任务栏右键）最小化，立即 restore 还原。
 *  5) 尺寸护栏：resize 后若宽度/高度过小，自动抬回最小值。
 */
let agentBusy = false;

/** 标记 AI 任务是否正在执行（用于窗口保护） */
export function setAgentBusy(busy: boolean): void {
  agentBusy = busy;
}

/** 任务进行中：拦截最小化，并提示用户 */
function notifyBusyGuard(reason: string): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:guard-notice', { reason });
      mainWindow.flashFrame(true);
      setTimeout(() => {
        try {
          mainWindow?.flashFrame(false);
        } catch {
          /* 窗口可能已销毁 */
        }
      }, 1500);
    }
  } catch {
    /* 忽略竞态 */
  }
}

/** 装配窗口保护：拦截 + 兜底还原 + 尺寸护栏 */
function attachWindowGuards(win: BrowserWindow, opts: { minWidth: number; minHeight: number }): void {
  // 兜底：被外部手段最小化后立即还原（任务进行中才生效）
  // 注：minimize 事件的 preventDefault 在部分平台上不阻止最小化，
  // 因此这里额外 restore + show 做双保险。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win.on('minimize' as any, (event: any) => {
    if (!agentBusy) return;
    event.preventDefault?.();
    win.restore();
    win.show();
    notifyBusyGuard('AI 任务执行中，窗口已保持在前台');
  });

  // 尺寸护栏：防止被压成 0 尺寸 / 极端窄条后无法操作
  win.on('resize', () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
    const [w, h] = win.getSize();
    const needW = Math.max(w, opts.minWidth);
    const needH = Math.max(h, opts.minHeight);
    if (needW !== w || needH !== h) {
      win.setSize(needW, needH, false);
    }
  });
}

/** 创建独立的「生成 PPT」窗口 */
async function createPptWindow(topic?: string): Promise<void> {
  // 已存在则聚焦复用，并将新主题发送给页面。
  if (pptWindow && !pptWindow.isDestroyed()) {
    pptWindow.show();
    pptWindow.focus();
    if (topic) pptWindow.webContents.send('ppt:prefill-topic', topic);
    return;
  }

  pptWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    show: true,
    title: '生成 PPT - CnkeIDE',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;

  // 窗口保护：PPT 窗口同样不允许被压成 0 尺寸
  attachWindowGuards(pptWindow, { minWidth: 800, minHeight: 600 });

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    await pptWindow.loadURL(`${devUrl}/ppt.html`);
  } else {
    // __dirname = <root>/renderer/dist-electron，产物 dist/ 在项目根：<root>/dist/ppt.html
    await pptWindow.loadFile(path.join(__dirname, '../../dist/ppt.html'));
  }

  if (topic) pptWindow.webContents.send('ppt:prefill-topic', topic);

  pptWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 窗口控制 IPC（关闭时仅销毁本窗口）
  ipcMain.on('ppt:close', () => {
    if (pptWindow && !pptWindow.isDestroyed()) {
      pptWindow.close();
    }
  });
  ipcMain.on('ppt:minimize', () => pptWindow?.minimize());

  // 开发期兜底：Ctrl+R / Cmd+R 手动 reload PPT 窗口（解决 vite-plugin-electron
  // 对独立 entry (ppt.html) 热更新不及时、窗口变黑 / 卡死的问题）
  const wc = pptWindow.webContents;
  wc.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r' && input.type === 'keyDown') {
      event.preventDefault();
      wc.reload();
    }
  });

  pptWindow.on('closed', () => {
    pptWindow = null;
  });
}

/** 解析托盘图标路径：开发模式用 build/icon.png，打包后用 resources 内打包的资源 */
function resolveTrayIconPath(): string {
  const candidates = [
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../build/icon.png'),
    path.join(process.resourcesPath, 'icon.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // 兜底：electron 默认图标
  return path.join(__dirname, 'icon.png');
}

/** 创建系统托盘图标 */
function createTray() {
  if (tray) return;
  try {
    const iconPath = resolveTrayIconPath();
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      // 找不到图标文件时跳过，避免空白托盘图标崩溃
      return;
    }
    // Windows 托盘图标建议 16x16（高 DPI 下会自动缩放），用 resize 保证尺寸
    if (process.platform === 'win32') {
      image = image.resize({ width: 16, height: 16 });
    }
    tray = new Tray(image);
    tray.setToolTip('CnkeIDE');
    const contextMenu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch (e) {
    console.error('[tray] 创建托盘失败:', e);
  }
}

/**
 * 显示/恢复主窗口
 *
 * 覆盖三种「窗口不见了」的现场：已销毁、已最小化、已隐藏。
 * 由托盘点击、重复启动（second-instance）、系统通知点击共用。
 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  // 任务执行中恢复窗口：顺便提示用户任务仍在跑
  if (agentBusy) notifyBusyGuard('窗口已恢复显示（AI 任务执行中）');
}

/** 发送系统通知（任务结束 / 异常退出） */
function sendNotification(title: string, body: string) {
  try {
    if (!Notification.isSupported()) return;
    // 窗口处于前台时跳过系统通知：
    // Windows toast 出现会短暂抢占焦点，导致输入法上下文被停用、正在打字时键盘无响应。
    // 用户正在使用应用无需打扰；仅在失焦/最小化（人不在应用前）时才弹通知。
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized() && mainWindow.isFocused()) {
      return;
    }
    const n = new Notification({
      title,
      body,
      icon: resolveTrayIconPath(),
      silent: false,
    });
    n.on('click', () => showMainWindow());
    n.show();
  } catch (e) {
    console.error('[notify] 发送通知失败:', e);
  }
}

app.whenReady().then(async () => {
  await configAdapter.init();

  // 配置写盘失败的用户可见通道。
  // 过去 ConfigAdapter.persist 里是空 catch：磁盘满 / 文件被占用时，用户改的设置
  // 不会保存且界面零提示，下次启动回到旧值，表现为"设置莫名其妙失效"。
  // 这里把它接到通知上，并同时打到控制台便于 Crashpad 上报。
  configAdapter.setWriteFailureHandler((message) => {
    console.error('[config] ' + message);
    // 不能用 sendNotification：它在主窗口前台时会被抑制（避免抢占焦点），
    // 而配置写失败恰恰发生在用户正操作设置时，提示会永远看不到。
    // 窗口存在时用对话框保证可见；仅在窗口未建/已毁时退回系统通知。
    if (mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '设置保存失败',
        message: '配置写入失败，本次修改可能未被保存',
        detail: message,
        buttons: ['确定'],
        noLink: true,
      });
    } else {
      sendNotification('设置保存失败', message);
    }
  });

  createMenu();
  createTray();

  // 注册所有IPC处理器。
  //
  // 必须在 createWindow() 之前：渲染层在 React 挂载时（App.tsx 的 UpdateAnnouncement）
  // 就会 invoke('update:checkAnnouncement') 等通道，窗口加载完成早于此处注册会导致
  // "No handler registered for 'update:check'" 这类启动竞态报错。
  //
  // 这里显式捕获异常：registerIpcHandlers 内部会一次性注册上百个通道，任一模块
  // 加载失败（历史问题：RagManager 运行期 require 相对路径）都会让后续所有
  // ipcMain.handle 一个都不注册，表现为「窗口能开但全部 IPC 报 No handler registered」。
  // 捕获后至少保证窗口正常创建，并把真实原因打到主进程日志，便于定位。
  try {
    appCleanup = registerIpcHandlers(configAdapter);
  } catch (e) {
    console.error('[main] registerIpcHandlers 失败，IPC 将不可用:', e);
  }

  await createWindow();

  // 初始化 PPT Master 集成（定位 skill 包 + 探测 Python，失败不阻断启动）
  void initPptMaster(configAdapter)
    .then((r) => {
      if (!r.ok) {
        console.error('[pptmaster] 初始化未完成：未找到 skills/ppt-master 技能包');
      } else if (!r.pythonFound) {
        console.warn('[pptmaster] 未找到 Python 3.9+，PPTX 生成将不可用（可在设置中指定路径）');
      }
    })
    .catch((e) => console.error('[pptmaster] 初始化异常:', e));

  // 监听 Agent 任务结束/异常，弹出系统通知
  ipcMain.on('agent:notify', (_event, payload: { type: 'done' | 'error' | 'info'; title?: string; message?: string }) => {
    if (!payload) return;
    if (payload.type === 'done') {
      sendNotification(payload.title || '任务完成', payload.message || 'AI 已完成当前任务');
    } else if (payload.type === 'error') {
      sendNotification(payload.title || '任务异常', payload.message || 'AI 任务异常退出');
    } else if (payload.type === 'info') {
      // 一般性提示（如用户主动中止任务）——过去 type 不在白名单里会被静默丢弃
      sendNotification(payload.title || '提示', payload.message || '');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
}).catch((e) => {
  console.error('[main] 启动初始化失败:', e);
});

// 打开 PPT 生成窗口（菜单 / 主窗口渲染进程均可触发）
ipcMain.on('ppt:open', (_event, topic?: string) => {
  void createPptWindow(typeof topic === 'string' ? topic.trim() : undefined);
});

// ===== 窗口控制 IPC（模块级仅注册一次） =====
// 注意：不能放在 createWindow() 内——窗口销毁重建（托盘唤起 / macOS activate）
// 会重复注册同名通道，消息被多次处理（典型症状：重建后点「最大化」无反应，
// toggle 逻辑被执行两次互相抵消）。
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('window:isMaximized', (event) => {
  event.returnValue = mainWindow?.isMaximized() ?? false;
});
// AI 任务进行中状态同步：渲染进程在 agent:run / 结束时通知，用于窗口保护策略
ipcMain.on('window:set-agent-busy', (_e, busy: boolean) => {
  setAgentBusy(!!busy);
});
// 菜单「文件 → 生成 PPT」通过 app 事件触发（避免 menu.ts 与 main.ts 循环依赖）
// 自定义事件，不在 Electron 类型定义里
app.on('open-ppt' as Parameters<typeof app.on>[0], () => {
  void createPptWindow();
});

app.on('before-quit', () => {
  // 清理 MCP 连接与子进程等资源
  appCleanup?.dispose();
  appCleanup = null;
  tray?.destroy();
  tray = null;
  if (pptWindow && !pptWindow.isDestroyed()) {
    pptWindow.close();
  }
  pptWindow = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 安全设置：阻止普通窗口创建额外的渲染进程。主窗口的预览 webview 由专用护栏处理。
app.on('web-contents-created', (_event, contents) => {
  if (contents === mainWindow?.webContents) return;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});
