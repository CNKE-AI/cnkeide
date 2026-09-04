import { app, BrowserWindow, dialog, shell } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConfigAdapter } from '../adapter/ConfigAdapter';

/**
 * UpdateManager - CnkeIDE 远程更新管理器
 *
 * 对接 https://ai.cnkes.cn/cnkeide/updates（electron-updater generic provider）。
 * 在 electron-updater（提供 latest.yml 解析 / 断点续传 / SHA512 完整性校验 / 差分更新）
 * 之上封装业务层能力：
 *   - 版本检测（本地 vs 远程，语义化版本比较）
 *   - 更新说明（releaseNotes）解析与透传
 *   - 下载进度 / 安装状态反馈（主进程 → 渲染层 IPC 推送）
 *   - 失败重试机制（可配置次数与间隔）
 *   - 更新日志（检测时间 / 下载结果 / 更新状态 / 错误信息）
 *   - 手动触发 + 静默后台自动检测两种模式
 *
 * 所有对外方法均返回结构化结果，事件通过 update:status 通道推送到渲染层。
 */

const UPDATE_SERVER_URL = 'https://ai.cnkes.cn/cnkeide/updates/';
const LOG_FILE = 'update-log.jsonl';
const LOG_MAX_LINES = 500;

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  mode: 'manual' | 'auto';
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
  /** 强制更新最低版本：当前版本低于此值时不可跳过更新 */
  minimumRunVersion?: string;
  /** 下载进度 0-100 */
  percent: number;
  /** 已下载字节 */
  transferred: number;
  /** 总字节 */
  total: number;
  /** 差分更新 true / 全量 false */
  differential: boolean;
  message?: string;
  error?: string;
}

export interface UpdateCheckResult {
  success: boolean;
  hasUpdate: boolean;
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
  /** 强制更新最低版本：当前版本低于此值时不可跳过更新 */
  minimumRunVersion?: string;
  error?: string;
}

export interface UpdateLogEntry {
  time: string;          // ISO 时间
  action: 'check' | 'download' | 'install' | 'error' | 'skip';
  mode: 'manual' | 'auto';
  version?: string;
  status: 'success' | 'failed' | 'cancelled';
  message?: string;
  error?: string;
}

interface RetryConfig {
  maxRetries: number;
  retryDelayMs: number;
}

export class UpdateManager {
  private win: BrowserWindow | null = null;
  private status: UpdateStatus = { phase: 'idle', mode: 'auto', percent: 0, transferred: 0, total: 0, differential: false };
  private logPath: string = '';
  private logQueue: UpdateLogEntry[] = [];
  private logWriteTimer: NodeJS.Timeout | null = null;

  // 下载重试配置（可通过 config 覆盖）
  private retryConfig: RetryConfig = { maxRetries: 3, retryDelayMs: 2000 };
  // 当前下载重试计数
  private downloadRetries = 0;
  // 是否正在下载（防并发）
  private downloading = false;
  // 待安装：已下载完成，等待用户确认安装
  private pendingInstall = false;
  private pendingInfo: UpdateDownloadedEvent | null = null;
  // 强制更新弹窗是否正在显示（防重复弹窗）
  private forcedPromptShowing = false;

  constructor(private config: ConfigAdapter) {
    this.logPath = path.join(app.getPath('userData'), 'logs', LOG_FILE);
    // 读取可配置的重试参数
    const maxRetries = this.config.get<number>('update.retry.maxRetries', 3);
    const retryDelayMs = this.config.get<number>('update.retry.retryDelayMs', 2000);
    this.retryConfig = { maxRetries, retryDelayMs };

    // autoUpdater 全局配置
    autoUpdater.autoDownload = false;   // 手动触发下载，便于控制重试与进度
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    // 差分/增量更新开关（blockmap 差异下载）
    autoUpdater.disableDifferentialDownload = !this.config.get<boolean>('update.differential', true);
    autoUpdater.logger = null;
    try {
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: UPDATE_SERVER_URL,
      });
    } catch (e: any) {
      this.log('error', 'auto', 'setFeedURL 失败', e?.message);
    }

    this.bindAutoUpdaterEvents();
  }

  /** 是否启用静默后台自动检测（读取配置 update.autoCheck）。 */
  isAutoCheckEnabled(): boolean {
    return this.config.get<boolean>('update.autoCheck', true);
  }

  /** 静默检测启动延迟（毫秒）。 */
  getAutoCheckDelay(): number {
    return this.config.get<number>('update.autoCheckDelayMs', 8000);
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.win = win;
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  // ============================================================
  // 事件绑定：electron-updater → 状态机 → IPC 推送
  // ============================================================
  private bindAutoUpdaterEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.setStatus({ phase: 'checking', message: '正在检查更新…' });
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.downloadRetries = 0;
      this.setStatus({
        phase: 'available',
        version: info.version,
        releaseNotes: this.extractReleaseNotes(info),
        releaseDate: (info as any)?.releaseDate,
        minimumRunVersion: (info as any)?.minimumRunVersion,
        message: `发现新版本 v${info.version}`,
      });
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.setStatus({ phase: 'not-available', version: info.version, message: '当前已是最新版本' });
    });

    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      this.setStatus({
        phase: 'downloading',
        percent: Math.min(99.9, Number(((p.percent || 0)).toFixed(1))),
        transferred: p.transferred || 0,
        total: p.total || 0,
        differential: !!p.delta,
        message: `正在下载更新包 ${Math.floor(p.percent)}%`,
      });
    });

    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.downloading = false;
      this.pendingInstall = true;
      this.pendingInfo = event;
      this.log('download', this.status.mode, event.version, 'success', '更新包下载完成');
      this.setStatus({
        phase: 'downloaded',
        version: event.version,
        releaseNotes: this.extractReleaseNotes(event),
        percent: 100,
        transferred: (event as any)?.files?.reduce((s: number, f: any) => s + (f.size || 0), 0) || this.status.transferred,
        total: this.status.total || this.status.transferred,
        message: '更新包下载完成，准备安装',
      });
      // W13 新增：自动模式（silent 启动时）5s 后自动安装
      // 手动模式（用户在设置里点更新）则等用户点击
      if (this.status.mode === 'auto') {
        this.log('install', this.status.mode, event.version, 'success', '5s 后自动安装');
        setTimeout(() => {
          if (this.pendingInstall) {
            this.installNow();
          }
        }, 5000);
      }
    });

    autoUpdater.on('error', (err: Error) => {
      this.handleDownloadError(err);
    });
  }

  private handleDownloadError(err: Error): void {
    this.downloading = false;
    // 仅在「正在下载」阶段做自动重试；检查阶段错误直接上报
    if (this.status.phase === 'downloading' && this.downloadRetries < this.retryConfig.maxRetries) {
      this.downloadRetries++;
      const delay = this.retryConfig.retryDelayMs * this.downloadRetries;
      this.setStatus({
        phase: 'downloading',
        percent: this.status.percent,
        transferred: this.status.transferred,
        total: this.status.total,
        message: `下载失败，${delay / 1000}s 后进行第 ${this.downloadRetries} 次重试（${this.downloadRetries}/${this.retryConfig.maxRetries}）`,
        error: err.message,
      });
      this.log('error', this.status.mode, undefined, 'failed', `下载失败，重试 ${this.downloadRetries}/${this.retryConfig.maxRetries}`, err.message);
      setTimeout(() => {
        void this.resumeDownload();
      }, delay);
      return;
    }

    this.log('error', this.status.mode, undefined, 'failed', '更新出错', err.message);
    this.setStatus({ phase: 'error', error: err.message, message: '更新失败' });
  }

  /** 断点续传：electron-updater 内部支持 range 续传，重试时直接调用 downloadUpdate */
  private async resumeDownload(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate();
    } catch (e: any) {
      this.handleDownloadError(e instanceof Error ? e : new Error(e?.message || String(e)));
    }
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('update:status', this.getStatus());
  }

  private emit(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  // ============================================================
  // 对外 API
  // ============================================================

  /** 检查更新（不下载）。返回是否可更新及版本信息。 */
  async checkForUpdates(mode: 'manual' | 'auto'): Promise<UpdateCheckResult> {
    this.status.mode = mode;
    this.log('check', mode, undefined, 'success', '开始检查更新');
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        this.setStatus({ phase: 'not-available', message: '当前已是最新版本' });
        return { success: true, hasUpdate: false };
      }
      const info = result.updateInfo;
      const hasUpdate = this.isNewerVersion(info.version, app.getVersion());
      const minimumRunVersion = (info as any)?.minimumRunVersion as string | undefined;
      this.log('check', mode, info.version, 'success', hasUpdate ? '发现新版本' : '已是最新');

      // 强制更新：远程配置了 minimumRunVersion 且当前版本低于它，弹出不可跳过的更新提示
      if (hasUpdate && minimumRunVersion && this.isNewerVersion(minimumRunVersion, app.getVersion())) {
        this.promptForcedUpdate(info.version, minimumRunVersion);
      }

      return {
        success: true,
        hasUpdate,
        version: info.version,
        releaseNotes: this.extractReleaseNotes(info),
        releaseDate: (info as any)?.releaseDate,
        minimumRunVersion,
      };
    } catch (err: any) {
      this.log('check', mode, undefined, 'failed', '检查更新失败', err?.message);
      this.setStatus({ phase: 'error', error: err?.message, message: '检查更新失败' });
      return { success: false, hasUpdate: false, error: err?.message };
    }
  }

  /** 强制更新提示：弹出系统对话框，用户必须选择「立即更新」，否则循环提示（不可跳过）。 */
  private promptForcedUpdate(version: string, minimumRunVersion: string): void {
    // 防重复弹窗
    if (this.forcedPromptShowing) return;
    this.forcedPromptShowing = true;
    const doPrompt = async () => {
      const res = await dialog.showMessageBox({
        type: 'warning',
        title: '强制更新',
        message: `检测到强制更新 v${version}`,
        detail: `当前版本过低（最低要求 v${minimumRunVersion}），为保障功能正常与安全，必须立即更新。`,
        buttons: ['立即更新', '稍后提醒'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (res.response === 0) {
        // 立即更新：直接下载并安装
        this.forcedPromptShowing = false;
        void this.downloadAndInstall('auto').then((r) => {
          if (!r.success) {
            // 下载失败则重新提示
            setTimeout(() => this.promptForcedUpdate(version, minimumRunVersion), 5000);
          }
        });
      } else {
        // 稍后提醒：30 秒后再次弹出（不可跳过，持续提醒）
        setTimeout(() => {
          this.forcedPromptShowing = false;
          this.promptForcedUpdate(version, minimumRunVersion);
        }, 30000);
      }
    };
    void doPrompt();
  }

  /** 下载并安装更新（含断点续传 + 重试）。 */
  async downloadAndInstall(mode: 'manual' | 'auto'): Promise<{ success: boolean; error?: string }> {
    if (this.downloading) {
      return { success: false, error: '已有下载任务进行中' };
    }
    this.downloading = true;
    this.downloadRetries = 0;
    this.status.mode = mode;
    try {
      await autoUpdater.downloadUpdate();
      // 下载完成由 update-downloaded 事件驱动；这里兜底返回
      return { success: true };
    } catch (err: any) {
      this.handleDownloadError(err instanceof Error ? err : new Error(err?.message || String(err)));
      return { success: false, error: err?.message };
    }
  }

  /** 立即安装已下载的更新包（重启应用完成安装）。 */
  installNow(): { success: boolean; error?: string } {
    if (!this.pendingInstall) {
      return { success: false, error: '尚未下载更新包' };
    }
    this.setStatus({ phase: 'installing', message: '正在安装更新，应用即将重启…' });
    this.log('install', this.status.mode, this.pendingInfo?.version, 'success', '开始安装更新并重启');
    try {
      // W13 改进：主动 kill 残留子进程避免文件被占用（1.2.1 教训）
      this.killResidualProcesses();
      // 给 2s 缓冲让 OS 释放文件句柄
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (err: any) {
          this.log('error', this.status.mode, undefined, 'failed', 'quitAndInstall 失败', err?.message);
        }
      }, 2000);
      return { success: true };
    } catch (err: any) {
      this.log('error', this.status.mode, undefined, 'failed', '安装准备失败', err?.message);
      return { success: false, error: err?.message };
    }
  }

  /**
   * W13 新增：清理可能占用 installer.exe 文件句柄的残留子进程
   * 1.2.1 教训：agent worker、sub agent、terminal 长任务可能仍持有 file handle，
   * 导致 Squirrel installer 替换时 Access denied
   */
  private killResidualProcesses(): void {
    try {
      const { exec } = require('node:child_process');
      // 杀掉所有 CnkeIDE 的子进程（agent worker 等）
      // taskkill /T 杀进程树，/F 强杀
      const cmds: Array<{ cmd: string; args: string[] }> = [
        // Windows: 杀所有 node 派生的子进程（CnkeIDE 自己用 child_process spawn 的）
        { cmd: 'taskkill', args: ['/F', '/IM', 'node.exe', '/FI', 'WINDOWTITLE eq CnkeIDE*'] },
        // 杀 cmd.exe / powershell.exe（agent 启动的 shell）
        { cmd: 'taskkill', args: ['/F', '/IM', 'cmd.exe', '/FI', 'WINDOWTITLE eq CnkeIDE*'] },
        { cmd: 'taskkill', args: ['/F', '/IM', 'powershell.exe', '/FI', 'WINDOWTITLE eq CnkeIDE*'] },
      ];
      for (const c of cmds) {
        try { exec(c.cmd, c.args, { windowsHide: true }); } catch { /* ignore */ }
      }
      this.log('install', this.status.mode, undefined, 'success', '已清理残留子进程');
    } catch (err) {
      // best-effort
    }
  }

  /** 取消当前更新流程。 */
  cancel(): void {
    if (this.downloading) {
      this.downloading = false;
      this.log('download', this.status.mode, undefined, 'cancelled', '用户取消下载');
    }
    this.pendingInstall = false;
    this.pendingInfo = null;
    this.setStatus({ phase: 'idle', message: '已取消更新' });
  }

  /** 是否已下载完成待安装。 */
  isPendingInstall(): boolean {
    return this.pendingInstall;
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /** 语义化版本比较：a > b 返回 true。 */
  isNewerVersion(a: string, b: string): boolean {
    const pa = (a || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = (b || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb) return true;
      if (na < nb) return false;
    }
    return false;
  }

  /** 提取更新说明：electron-updater 可能提供 releaseNotes 字符串或数组。 */
  private extractReleaseNotes(info: any): string {
    const rn = info?.releaseNotes;
    if (!rn) return '';
    if (typeof rn === 'string') return rn;
    if (Array.isArray(rn)) {
      return rn.map((item: any) => item?.note || item?.version || String(item)).filter(Boolean).join('\n\n');
    }
    return '';
  }

  // ============================================================
  // 更新日志（JSONL，异步写入，环形截断）
  // ============================================================
  private log(action: UpdateLogEntry['action'], mode: 'manual' | 'auto', version: string | undefined, status: UpdateLogEntry['status'], message?: string, error?: string): void {
    this.logQueue.push({
      time: new Date().toISOString(),
      action,
      mode,
      version,
      status,
      message,
      error,
    });
    // 防抖批量落盘，避免高频写日志阻塞主进程
    if (this.logWriteTimer) clearTimeout(this.logWriteTimer);
    this.logWriteTimer = setTimeout(() => void this.flushLog(), 500);
  }

  private async flushLog(): Promise<void> {
    if (this.logQueue.length === 0) return;
    const entries = this.logQueue.splice(0, this.logQueue.length);
    try {
      await fsPromises.mkdir(path.dirname(this.logPath), { recursive: true });
      let lines = '';
      for (const e of entries) lines += JSON.stringify(e) + '\n';
      await fsPromises.appendFile(this.logPath, lines, 'utf-8');
      await this.trimLog();
    } catch {
      // 日志写入失败不影响更新流程
    }
  }

  private async trimLog(): Promise<void> {
    try {
      const raw = await fsPromises.readFile(this.logPath, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length > LOG_MAX_LINES) {
        await fsPromises.writeFile(this.logPath, lines.slice(-LOG_MAX_LINES).join('\n') + '\n', 'utf-8');
      }
    } catch {
      // ignore
    }
  }

  /** 读取更新日志（渲染层查看）。 */
  async getUpdateLogs(limit = 100): Promise<UpdateLogEntry[]> {
    try {
      const raw = await fsPromises.readFile(this.logPath, 'utf-8');
      const entries = raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try { return JSON.parse(l) as UpdateLogEntry; } catch { return null; }
        })
        .filter((e): e is UpdateLogEntry => !!e);
      return entries.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  /** 清理资源（退出前落盘日志）。 */
  async dispose(): Promise<void> {
    if (this.logWriteTimer) {
      clearTimeout(this.logWriteTimer);
      this.logWriteTimer = null;
    }
    await this.flushLog();
    this.cancel();
    try {
      autoUpdater.removeAllListeners();
    } catch {
      // ignore
    }
  }
}
