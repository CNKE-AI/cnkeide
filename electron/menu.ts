import { Menu, BrowserWindow, shell, app } from 'electron';

/** CnkeIDE 官网首页地址 */
const OFFICIAL_WEBSITE_URL = 'https://github.com/CNKE-AI/cnkeide';

export function createMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'CnkeIDE',
      submenu: [
        { role: 'about' as const, label: '关于 CnkeIDE' },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const, label: '退出 CnkeIDE' },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '打开文件夹...', accelerator: 'CmdOrCtrl+O', click: () => BrowserWindow.getFocusedWindow()?.webContents.send('menu:openFolder') },
        { label: '保存文件', accelerator: 'CmdOrCtrl+S', click: () => BrowserWindow.getFocusedWindow()?.webContents.send('menu:saveFile') },
        { type: 'separator' },
        { label: '生成 PPT...', accelerator: 'CmdOrCtrl+Shift+P', click: () => app.emit('open-ppt') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '置于顶层' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 CnkeIDE', click: () => BrowserWindow.getFocusedWindow()?.webContents.send('menu:about') },
        { label: '官网首页', click: () => { void shell.openExternal(OFFICIAL_WEBSITE_URL); } },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
