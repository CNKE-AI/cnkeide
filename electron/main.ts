import { app, BrowserWindow, ipcMain, Menu, dialog, shell, Tray, Notification, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { registerIpcHandlers } from './ipc/handlers';
import { initPptMaster } from './core-fork/pptmaster';
import { ConfigAdapter } from './adapter/ConfigAdapter';
import { createMenu } from './menu';

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
    },
  });

  const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    await mainWindow.loadURL(devUrl);
    // DevTools 仅在显式要求时弹出（设置环境变量 CNKE_DEVTOOLS=1），避免运行时弹额外窗口
    if (process.env.CNKE_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    // __dirname = <root>/renderer/dist-electron，产物 dist/ 在项目根：<root>/dist/index.html
    await mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // 立即显示窗口，避免 ready-to-show 不触发导致窗口永久隐藏
  mainWindow.show();

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 兜底：页面加载后强制显示，避免 ready-to-show 未触发导致窗口永久隐藏
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    }, 1000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 广播窗口最大化状态变化，供渲染进程切换「最大化/还原」按钮图标
  const broadcastMaximizeState = () => {
    mainWindow?.webContents.send('window:maximized-changed', mainWindow?.isMaximized() ?? false);
  };
  mainWindow.on('maximize', broadcastMaximizeState);
  mainWindow.on('unmaximize', broadcastMaximizeState);

  // 窗口控制 IPC
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
}

/** 创建独立的「生成 PPT」窗口 */
async function createPptWindow(): Promise<void> {
  // 已存在则聚焦复用
  if (pptWindow && !pptWindow.isDestroyed()) {
    pptWindow.show();
    pptWindow.focus();
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

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    await pptWindow.loadURL(`${devUrl}/ppt.html`);
  } else {
    // __dirname = <root>/renderer/dist-electron，产物 dist/ 在项目根：<root>/dist/ppt.html
    await pptWindow.loadFile(path.join(__dirname, '../../dist/ppt.html'));
  }

  pptWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
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

/** 显示/恢复主窗口 */
function showMainWindow() {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
  createMenu();
  await createWindow();
  createTray();

  // 注册所有IPC处理器
  appCleanup = registerIpcHandlers(configAdapter);

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
  ipcMain.on('agent:notify', (_event, payload: { type: 'done' | 'error'; title?: string; message?: string }) => {
    if (!payload) return;
    if (payload.type === 'done') {
      sendNotification(payload.title || '任务完成', payload.message || 'AI 已完成当前任务');
    } else if (payload.type === 'error') {
      sendNotification(payload.title || '任务异常', payload.message || 'AI 任务异常退出');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 打开 PPT 生成窗口（菜单 / 主窗口渲染进程均可触发）
ipcMain.on('ppt:open', () => {
  void createPptWindow();
});
// 菜单「文件 → 生成 PPT」通过 app 事件触发（避免 menu.ts 与 main.ts 循环依赖）
(app as any).on('open-ppt', () => {
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

// 安全设置：阻止创建额外的渲染进程
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});
