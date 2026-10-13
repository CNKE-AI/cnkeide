import { EventEmitter } from 'node:events';
import { watch, FSWatcher, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** 文件变更事件（相对于工作区根目录） */
export interface WorkspaceChange {
  /** 变更类型：rename 包含新增/删除（Node fs.watch 无法区分） */
  type: 'rename' | 'change';
  /** 绝对路径 */
  absolutePath: string;
  /** 相对工作区根的路径（POSIX 分隔符，便于前端比较） */
  relativePath: string;
  /** 变更所在目录绝对路径（用于判断是否需要刷新某个已展开的目录） */
  dir: string;
  /** 事件时间戳 */
  at: number;
}

/** 默认忽略的目录/文件（避免 node_modules 等引发的事件风暴） */
const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  'coverage',
  '.turbo',
];

/** 忽略的文件模式（临时/日志/锁文件） */
const IGNORE_FILE_RE = /(\.swp|\.swx|~|\.tmp|\.log|\.DS_Store|\.lock)$/i;

/**
 * 单个工作区根目录的递归监听器。
 *
 * Node 的 fs.watch 在 Windows 上不支持 recursive，因此这里采用
 * 「自维护目录树 + 按需补挂」策略：
 * - 启动时递归扫描目录（跳过忽略项），每个目录挂一个 watcher；
 * - 收到 rename 事件时，若是新建目录则补挂 watcher，若是删除则清理；
 * - 事件按 debounce 窗口合并后通过 EventEmitter 抛出，避免高频写入时洪泛。
 */
class RootWatcher {
  private watchers: Map<string, FSWatcher> = new Map();
  private pending: Map<string, WorkspaceChange> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private root: string,
    private onChanges: (changes: WorkspaceChange[]) => void,
    private debounceMs: number = 120,
  ) {
    this.attachDir(root);
    this.scanSubdirs(root);
  }

  /** 判断路径是否应被忽略 */
  private ignored(absPath: string): boolean {
    const rel = path.relative(this.root, absPath);
    if (!rel) return false;
    const segs = rel.split(/[\\/]/);
    for (const s of segs) {
      if (DEFAULT_IGNORE.includes(s)) return true;
    }
    return IGNORE_FILE_RE.test(path.basename(absPath));
  }

  /** 为单个目录挂 watcher（已在监听则跳过） */
  private attachDir(dir: string): void {
    if (this.disposed || this.watchers.has(dir)) return;
    if (this.ignored(dir)) return;
    try {
      const w = watch(dir, { persistent: true }, (_eventType, filename) => {
        this.handle(dir, filename ? String(filename) : '');
      });
      w.on('error', () => {
        // 目录被删除 / 权限变化：静默解绑，避免进程崩溃
        this.detachDir(dir);
      });
      this.watchers.set(dir, w);
    } catch {
      /* 目录不可读时跳过 */
    }
  }

  private detachDir(dir: string): void {
    const w = this.watchers.get(dir);
    if (w) {
      try { w.close(); } catch { /* ignore */ }
      this.watchers.delete(dir);
    }
  }

  /** 递归扫描子目录并挂载（上限保护，避免超大仓库阻塞主进程启动） */
  private scanSubdirs(dir: string, depth: number = 0): void {
    if (this.disposed || depth > 8 || this.watchers.size > 1500) return;
    let names: string[];
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      if (this.ignored(full)) continue;
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      this.attachDir(full);
      this.scanSubdirs(full, depth + 1);
    }
  }

  /** 处理单次 fs 事件：合并到 pending，debounce 后统一抛出 */
  private handle(dir: string, filename: string): void {
    if (this.disposed || !filename) return;
    const abs = path.join(dir, filename);
    if (this.ignored(abs)) return;

    // 新建目录：补挂 watcher 并扫描其子目录（覆盖整目录粘贴/解压场景）
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        this.attachDir(abs);
        this.scanSubdirs(abs, 9);
      } else if (!existsSync(abs)) {
        // 目录被删除：解绑自身及所有子孙 watcher
        for (const key of Array.from(this.watchers.keys())) {
          if (key === abs || key.startsWith(abs + path.sep)) this.detachDir(key);
        }
      }
    } catch {
      /* ignore */
    }

    const change: WorkspaceChange = {
      type: 'change',
      absolutePath: abs,
      relativePath: path.relative(this.root, abs).split(path.sep).join('/'),
      dir,
      at: Date.now(),
    };
    // 同一路径的连续事件只保留最后一次
    this.pending.set(abs, change);

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const changes = Array.from(this.pending.values());
        this.pending.clear();
        if (changes.length > 0 && !this.disposed) this.onChanges(changes);
      }, this.debounceMs);
    }
    void filename;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const dir of Array.from(this.watchers.keys())) this.detachDir(dir);
    this.pending.clear();
  }
}

/**
 * WorkspaceWatcher - 工作区文件变更监听
 *
 * 对外表现为「单一根目录监听」，切换工作区时先释放旧监听。
 * 变更经 debounce 合并后以 'changes' 事件抛出（批量），由 IPC 层广播给渲染进程，
 * 使资源管理器 / 编辑器 / 终端三个视图无需手动刷新即可保持一致。
 */
export class WorkspaceWatcher extends EventEmitter {
  private current: RootWatcher | null = null;
  private currentRoot: string | null = null;

  /** 是否正在监听 */
  get watching(): boolean {
    return this.current !== null;
  }

  get root(): string | null {
    return this.currentRoot;
  }

  /** 开始监听指定目录（重复调用同一路径为空操作；切换路径自动释放旧监听） */
  watch(rootPath: string): { success: boolean; error?: string } {
    if (!rootPath || !existsSync(rootPath)) {
      return { success: false, error: '目录不存在' };
    }
    if (this.currentRoot === rootPath && this.current) return { success: true };

    this.unwatch();

    try {
      this.current = new RootWatcher(rootPath, (changes) => {
        this.emit('changes', { root: rootPath, changes });
      });
      this.currentRoot = rootPath;
      return { success: true };
    } catch (err: any) {
      this.current = null;
      this.currentRoot = null;
      return { success: false, error: err?.message || String(err) };
    }
  }

  /** 停止监听 */
  unwatch(): void {
    if (this.current) {
      this.current.dispose();
      this.current = null;
    }
    this.currentRoot = null;
  }

  dispose(): void {
    this.unwatch();
    this.removeAllListeners();
  }
}
