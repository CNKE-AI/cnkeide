/**
 * HeadlessWindowAdapter - CLI 环境的窗口适配层
 *
 * 刻意不继承 WindowAdapter：后者模块顶层 `import { app, BrowserWindow, dialog, Notification, shell } from 'electron'`，
 * 在纯 Node 进程里会直接加载 electron 包（全局安装的 CLI 根本没有该依赖）。
 * 这里只实现同名方法，结构与 WindowAdapter 兼容，由 bootstrap 处断言传入 AgentManager。
 */

export type HeadlessLogLevel = 'info' | 'warning' | 'error';

export interface HeadlessWindowAdapterOptions {
  /** 日志输出（默认写 stderr，避免污染 stdout 的 NDJSON 协议流） */
  log?: (message: string, level: HeadlessLogLevel) => void;
  /** 交互式提问能力；未提供时所有确认类调用返回「取消」 */
  confirm?: (title: string, message: string, buttons: string[]) => Promise<number>;
  prompt?: (title: string, message: string) => Promise<string | null>;
}

export class HeadlessWindowAdapter {
  private readonly log: (message: string, level: HeadlessLogLevel) => void;
  private readonly confirmImpl?: (title: string, message: string, buttons: string[]) => Promise<number>;
  private readonly promptImpl?: (title: string, message: string) => Promise<string | null>;
  private title = '';

  constructor(options: HeadlessWindowAdapterOptions = {}) {
    this.log = options.log ?? ((message, level) => {
      process.stderr.write(`[cnkeide:${level}] ${message}\n`);
    });
    this.confirmImpl = options.confirm;
    this.promptImpl = options.prompt;
  }

  setMainWindow(_win: unknown): void {
    /* headless 无窗口 */
  }

  getMainWindow(): null {
    return null;
  }

  notify(title: string, body: string, type: HeadlessLogLevel = 'info'): void {
    this.log(body ? `${title}: ${body}` : title, type);
  }

  async showError(title: string, message: string): Promise<void> {
    this.log(`${title}: ${message}`, 'error');
  }

  async showInfo(title: string, message: string): Promise<void> {
    this.log(`${title}: ${message}`, 'info');
  }

  async showConfirm(title: string, message: string, buttons: string[] = ['确认', '取消']): Promise<number> {
    if (this.confirmImpl) return this.confirmImpl(title, message, buttons);
    this.log(`${title}: ${message}（无交互终端，按「取消」处理）`, 'warning');
    return buttons.length > 1 ? 1 : 0;
  }

  async showOpenFolder(): Promise<string | null> {
    if (this.promptImpl) return this.promptImpl('选择目录', '请输入目录路径');
    return null;
  }

  async showOpenFile(): Promise<string | null> {
    if (this.promptImpl) return this.promptImpl('选择文件', '请输入文件路径');
    return null;
  }

  async showSaveDialog(defaultName?: string): Promise<string | null> {
    if (this.promptImpl) return this.promptImpl('保存文件', `请输入保存路径（默认 ${defaultName || ''}）`);
    return null;
  }

  async openExternal(url: string): Promise<void> {
    this.log(`打开链接: ${url}`, 'info');
  }

  async openPath(targetPath: string): Promise<void> {
    this.log(`打开路径: ${targetPath}`, 'info');
  }

  setTitle(title: string): void {
    this.title = title;
  }

  getTitle(): string {
    return this.title;
  }
}
