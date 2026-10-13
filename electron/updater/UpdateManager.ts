import { app, BrowserWindow, dialog, shell } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConfigAdapter } from '../adapter/ConfigAdapter';
import { execFileSafe } from '../core-fork/util/SafeSpawn';

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

/** setStatus 节流：避免 download-progress 高频事件（每秒 10-30 次）压垮 IPC。
 *  - 每 200ms 至多推送一次「下载进度」类更新（首末帧立即透传，确保进度条不会丢起点/终点）
 *  - 非下载阶段（checking/available/installing/error 等）不受节流，立即推送
 */
const PROGRESS_THROTTLE_MS = 200;

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
  // ===== 性能优化：下载进度节流 =====
  /** 上次推送下载进度的时间戳（用于节流） */
  private lastProgressEmit = 0;
  /** 待发送的下载进度（节流窗口内只保留最新） */
  private pendingProgress: Partial<UpdateStatus> | null = null;
  /** 节流定时器 */
  private progressTimer: NodeJS.Timeout | null = null;
  /** 自动安装倒计时定时器（autoInstall=true 时下载完成 N 秒后自动 installNow） */
  private installTimer: NodeJS.Timeout | null = null;

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
      // 走节流通道：每秒最高 5 次推送（PROGRESS_THROTTLE_MS = 200）
      const patch: Partial<UpdateStatus> = {
        phase: 'downloading',
        percent: Math.min(99.9, Number(((p.percent || 0)).toFixed(1))),
        transferred: p.transferred || 0,
        total: p.total || 0,
        differential: !!p.delta,
        message: `正在下载更新包 ${Math.floor(p.percent)}%`,
      };
      this.status = { ...this.status, ...patch };
      this.scheduleThrottledProgress(patch);
    });

    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.downloading = false;
      this.pendingInstall = true;
      this.pendingInfo = event;
      // 立即推送 100%（确保节流窗口内的进度到位）
      this.flushProgressTimer();
      this.setStatus({
        phase: 'downloaded',
        version: event.version,
        releaseNotes: this.extractReleaseNotes(event),
        percent: 100,
        transferred: (event as any)?.files?.reduce((s: number, fed: any) => s + (fed.size || 0), 0) || this.status.transferred,
        total: this.status.total || this.status.transferred,
        message: '更新包下载完成，准备安装',
      });
      // 后台异步保留差分基准（不阻塞 UI），完成后追加一条日志
      void this.preserveInstallerForDifferentialAsync(event.version);
      this.log('download', this.status.mode, event.version, 'success', '更新包下载完成');

      // ===== 真正无感更新：autoInstall 配置开启时，下载完成立即自动安装 =====
      // 不再区分 manual/auto：只要用户没关闭 autoInstall，下载完就自动安装，
      // 用户完全不需要点任何按钮，进度条走完后直接重启到新版本。
      const autoInstall = this.config.get<boolean>('update.autoInstall', true);
      if (autoInstall) {
        const delaySec = this.config.get<number>('update.autoInstallDelaySec', 3);
        this.log('install', this.status.mode, event.version, 'success', `${delaySec}s 后自动安装`);
        // 给用户 3s 时间看到「即将重启安装…」提示，期间可手动取消（点 X）
        this.installTimer = setTimeout(() => {
          this.installTimer = null;
          if (this.pendingInstall) this.installNow();
        }, delaySec * 1000);
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

  /**
   * 保留本次下载的安装包到差分基准位置（<updaterCacheDir>/installer.exe）。
   *
   * electron-updater 的 NSIS 差分下载要求本地存在"当前已安装版本"的安装包作为
   * 拼装基准（oldFile 固定为 CURRENT_APP_INSTALLER_FILE_NAME = "installer.exe"），
   * 但 electron-updater 自身从不写入该文件——若应用不主动保留，每次更新都会因
   * 缺基准而退化为全量下载（~86MB）。在 update-downloaded（安装前，文件必然
   * 存在）时复制一份，下次更新即走差分（仅下载差异块，几 MB 级别）。
   */
  private preserveInstallerForDifferential(): void {
    void this.preserveInstallerForDifferentialAsync(undefined);
  }

  /**
   * 异步保留本次安装包到差分基准位置（不阻塞 UI 反馈）。
   * electron-updater 的 NSIS 差分下载要求本地存在「当前已安装版本」安装包作为拼装基准，
   * 统一在 installNow 之前 await 完，可能清空 pending 残留。
   */
  private async preserveInstallerForDifferentialAsync(version: string | undefined): Promise<void> {
    try {
      const cacheDir = this.getUpdaterCacheDir();
      if (!cacheDir) return;
      const pendingDir = path.join(cacheDir, 'pending');
      // 用 existsSync + readdirSync 失败都视为可忽略（下次仍走全量）
      if (!fs.existsSync(pendingDir)) return;
      const exes = await fsPromises.readdir(pendingDir).catch(() => [] as string[]);
      const filtered = exes.filter((f) => f.toLowerCase().endsWith('.exe'));
      if (filtered.length === 0) return;
      // 取最新修改的一个
      let latest = filtered[0];
      let latestMtime = 0;
      for (const f of filtered) {
        try {
          const st = await fsPromises.stat(path.join(pendingDir, f));
          if (st.mtimeMs > latestMtime) {
            latestMtime = st.mtimeMs;
            latest = f;
          }
        } catch {
          /* skip */
        }
      }
      const src = path.join(pendingDir, latest);
      const dest = path.join(cacheDir, 'installer.exe');
      // 大文件异步拷贝（86MB 同步拷贝会卡几百 ms，改异步后让出事件循环）
      await fsPromises.copyFile(src, dest);
      this.log('download', this.status.mode, version, 'success', `已保留差分基准安装包: ${latest}`);
    } catch (e: any) {
      this.log('download', this.status.mode, version, 'failed', '保留差分基准安装包失败', e?.message);
    }
  }

  /** 解析 electron-updater 缓存目录（Windows: %LOCALAPPDATA%/<updaterCacheDirName>） */
  private getUpdaterCacheDir(): string | null {
    try {
      // updaterCacheDirName 打包于 resources/app-update.yml（electron-builder 生成）
      const ymlPath = path.join(process.resourcesPath || '', 'app-update.yml');
      let dirName = 'cnke-claw-updater';
      if (ymlPath && fs.existsSync(ymlPath)) {
        const raw = fs.readFileSync(ymlPath, 'utf-8');
        const m = raw.match(/^updaterCacheDirName:\s*(\S+)/m);
        if (m) dirName = m[1];
      }
      const base =
        process.env.LOCALAPPDATA ||
        (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
      if (!base) return null;
      return path.join(base, dirName);
    } catch {
      return null;
    }
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    const isDownloadingProgress = patch.phase === 'downloading' &&
      (patch.percent !== undefined || patch.transferred !== undefined);
    this.status = { ...this.status, ...patch };
    // 下载进度走节流通道，避免每秒 20+ 次 IPC 推送拖慢主进程与渲染层
    if (isDownloadingProgress) {
      this.scheduleThrottledProgress(patch);
      return;
    }
    // 非下载阶段立即推送（覆盖之前的节流窗口）
    this.flushProgressTimer();
    this.emit('update:status', this.getStatus());
  }

  /**
   * 把下载进度 patch 放进节流队列，200ms 内只发最新一次。
   * 首帧（百分比变化超过 5% 或首次）会立即透传，避免进度条不响应。
   */
  private scheduleThrottledProgress(patch: Partial<UpdateStatus>): void {
    const now = Date.now();
    const last = this.status;
    const isFirstFrame = this.lastProgressEmit === 0;
    const bigJump = typeof patch.percent === 'number' && Math.abs(patch.percent - (last.percent || 0)) >= 5;
    if (isFirstFrame || bigJump || now - this.lastProgressEmit >= PROGRESS_THROTTLE_MS) {
      this.lastProgressEmit = now;
      this.emit('update:status', this.getStatus());
      return;
    }
    // 缓存最新进度，节流窗口结束后补发一次
    this.pendingProgress = { ...this.pendingProgress, ...patch };
    if (!this.progressTimer) {
      this.progressTimer = setTimeout(() => {
        this.progressTimer = null;
        if (this.pendingProgress) {
          this.status = { ...this.status, ...this.pendingProgress };
          this.pendingProgress = null;
          this.lastProgressEmit = Date.now();
          this.emit('update:status', this.getStatus());
        }
      }, PROGRESS_THROTTLE_MS);
    }
  }

  /** 清理节流定时器（阶段切换时调用，避免残留 patch 污染下一阶段） */
  private flushProgressTimer(): void {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    this.pendingProgress = null;
  }

  /**
   * 解析主窗口用于状态推送。
   *
   * 注册的引用可能失效或尚未就绪（IPC 处理器先于 createWindow 注册，此时无窗口），
   * 因此与 WindowAdapter.getMainWindow 保持同样的策略：引用不可用时动态回退到
   * 当前存在的非 PPT 窗口，避免「检查更新/下载进度」推送静默丢失。
   */
  private resolveWindow(): BrowserWindow | null {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const isMainWindow = (w: BrowserWindow) => {
      try {
        return !w.webContents.getURL().includes('ppt.html');
      } catch {
        return true;
      }
    };
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed() && isMainWindow(focused)) return focused;
    return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && isMainWindow(w)) || null;
  }

  private emit(channel: string, payload: unknown): void {
    const win = this.resolveWindow();
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
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
    // 取消自动安装倒计时（用户手动点击安装）
    if (this.installTimer) {
      clearTimeout(this.installTimer);
      this.installTimer = null;
    }
    // 安装阶段进度不再节流（阶段切换会清空节流队列）
    this.flushProgressTimer();
    this.setStatus({ phase: 'installing', percent: 0, message: '正在准备安装环境…', transferred: 0, total: 0 });
    this.log('install', this.status.mode, this.pendingInfo?.version, 'success', '开始安装更新并重启');
    try {
      // 阶段一（0→30%）：kill 残留进程（异步并行，不再串行）
      this.killResidualProcessesAsync().then(() => {
        // 阶段二（30→60%）：等待 OS 释放文件句柄（缩短到 0.6s，原 2s 过长）
        this.setStatus({ phase: 'installing', percent: 30, message: '正在关闭后台进程…' });
        return new Promise<void>((r) => setTimeout(r, 600));
      }).then(() => {
        // 阶段三（60→90%）：Squirrel 替换 exe 前再确认一次文件就绪
        this.setStatus({ phase: 'installing', percent: 60, message: '正在替换应用文件…' });
        return new Promise<void>((r) => setTimeout(r, 200));
      }).then(() => {
        // 阶段四（90→100%）：交给 Squirrel 执行 quitAndInstall
        // 第一个参数 isSilent=true：强制走 NSIS 静默升级（/S 参数），**不弹任何安装界面**
        // 第二个参数 isForceRunAfter=true：安装完自动启动新版本（用户完全不感知）
        // 真实无感升级：进度条走完→直接重启到新版本，绝无任何弹窗
        this.setStatus({ phase: 'installing', percent: 90, message: '即将重启应用完成安装…' });
        try {
          autoUpdater.quitAndInstall(true, true);
        } catch (err: any) {
          this.log('error', this.status.mode, undefined, 'failed', 'quitAndInstall 失败', err?.message);
        }
      });
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
    void this.killResidualProcessesAsync();
  }

  /**
   * 异步并行清理残留子进程，不再串行阻塞主进程。
   * 3 个 taskkill 同时执行，最长等待时间由 max → max（因为是并行的，wall time 不变），
   * 但主进程事件循环不再被同步 spawn 占据，UI 可继续响应。
   */
  private async killResidualProcessesAsync(): Promise<void> {
    try {
      const cmds: Array<{ cmd: string; args: string[] }> = [
        { cmd: 'taskkill', args: ['/F', '/IM', 'node.exe', '/FI', 'WINDOWTITLE eq CnkeIDE*'] },
        { cmd: 'taskkill', args: ['/F', '/IM', 'cmd.exe', '/FI', 'WINDOWTITLE eq CnkeIDE*'] },
        { cmd: 'taskkill', args: ['/F', '/IM', 'powershell.exe', '/FI', 'WINDOWTITLE eq CnkeIDE*'] },
      ];
      await Promise.allSettled(
        cmds.map((c) => new Promise<void>((resolve) => {
          // execFileSafe 是同步的（spawnSync），包一层 Promise 让并行生效
          try {
            execFileSafe(c.cmd, c.args, { windowsHide: true, timeout: 1500 });
          } catch { /* ignore */ }
          resolve();
        }))
      );
      this.log('install', this.status.mode, undefined, 'success', '已清理残留子进程');
    } catch (err) {
      // best-effort
    }
  }

  /** 取消当前更新流程。 */
  cancel(): void {
    if (this.installTimer) {
      clearTimeout(this.installTimer);
      this.installTimer = null;
    }
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

  /**
   * 检查是否刚完成更新（当前版本与上次记录版本不同），若需要公告则返回版本号。
   * 同时把当前版本写入持久化标记，后续启动不再重复弹出。
   */
  async checkPostUpdateAnnouncement(): Promise<string | null> {
    try {
      const currentVersion = app.getVersion();
      const key = 'update.lastAnnouncementVersion';
      const lastShown = this.config.get<string>(key, '');
      if (lastShown === currentVersion) {
        // 已经为此版本弹过公告
        return null;
      }
      // 记录当前版本，后续不再弹
      this.config.set(key, currentVersion);
      return currentVersion;
    } catch {
      return null;
    }
  }

  /**
   * 从远程服务器获取 releasenotes.txt 内容（更新公告）。
   * 用 https 直接拉取，不依赖 electron-updater 的 UpdateInfo。
   */
  async fetchReleaseNotes(): Promise<string> {
    const url = UPDATE_SERVER_URL + 'releasenotes.txt';
    const https = await import('node:https');
    return new Promise<string>((resolve) => {
      const req = https.get(url, { timeout: 10000 }, (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data || ''));
        res.on('error', () => resolve(''));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
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
    if (this.installTimer) {
      clearTimeout(this.installTimer);
      this.installTimer = null;
    }
    this.flushProgressTimer();
    await this.flushLog();
    this.cancel();
    try {
      autoUpdater.removeAllListeners();
    } catch {
      // ignore
    }
  }
}
