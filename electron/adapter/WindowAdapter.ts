import { app, BrowserWindow, dialog, Notification, shell } from 'electron';
import path from 'node:path';

/**
 * WindowAdapter - 窗口/通知适配层
 * 替换 VSCode window / notifications API
 * 通过 IPC 推送前端弹窗和系统通知
 */
export class WindowAdapter {
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win;
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null;
  }

  /**
   * 发送通知到渲染进程
   */
  notify(title: string, body: string, type: 'info' | 'warning' | 'error' = 'info'): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('app:notify', { title, body, type });
    }
    // 系统通知仅在窗口失焦/最小化时发送：
    // Windows toast 出现会短暂抢占焦点，导致输入法上下文被停用、正在打字时键盘无响应。
    const focused = this.mainWindow && !this.mainWindow.isDestroyed()
      && !this.mainWindow.isMinimized() && this.mainWindow.isFocused();
    if (!focused && Notification.isSupported()) {
      const notif = new Notification({ title, body });
      notif.show();
    }
  }

  /**
   * 显示错误对话框
   */
  async showError(title: string, message: string): Promise<void> {
    await dialog.showMessageBox({
      type: 'error',
      title,
      message,
    });
  }

  /**
   * 显示信息对话框
   */
  async showInfo(title: string, message: string): Promise<void> {
    await dialog.showMessageBox({
      type: 'info',
      title,
      message,
    });
  }

  /**
   * 显示确认对话框
   */
  async showConfirm(title: string, message: string, buttons: string[] = ['确定', '取消']): Promise<number> {
    const result = await dialog.showMessageBox({
      type: 'question',
      title,
      message,
      buttons,
      defaultId: 0,
      cancelId: 1,
    });
    return result.response;
  }

  /**
   * 打开文件夹选择对话框
   */
  async showOpenFolder(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  }

  /**
   * 打开文件选择对话框
   */
  async showOpenFile(filters?: Electron.FileFilter[]): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: filters || [{ name: '所有文件', extensions: ['*'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  }

  /**
   * 显示保存对话框
   */
  async showSaveDialog(defaultName?: string, filters?: Electron.FileFilter[]): Promise<string | null> {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: filters || [{ name: '所有文件', extensions: ['*'] }],
    });
    if (result.canceled) return null;
    return result.filePath;
  }

  /**
   * 在外部浏览器打开 URL
   */
  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  /**
   * 在文件管理器中打开路径
   */
  async openPath(targetPath: string): Promise<void> {
    await shell.openPath(targetPath);
  }

  /**
   * 设置窗口标题
   */
  setTitle(title: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setTitle(title);
    }
  }
}
