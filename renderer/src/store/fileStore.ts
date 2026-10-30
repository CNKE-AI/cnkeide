import { create } from 'zustand';

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  expanded?: boolean;
}

interface ListResult {
  success: boolean;
  entries?: { name: string; path: string; isDirectory: boolean }[];
}

/** 目录刷新事件（订阅者：资源管理器、编辑器、终端等任意视图） */
export type DirRefreshListener = (dirPath: string) => void;

interface FileState {
  /** 当前工作区根目录 */
  rootPath: string | null;
  tree: FileNode[];
  loading: boolean;
  selectedPath: string | null;
  /** 是否有过变更（用于视图显示"已同步"提示） */
  lastChangeAt: number;
  /** 最近一次同步命中的文件相对路径（用于高亮闪烁） */
  lastChangedPaths: string[];
  setSelectedPath: (path: string | null) => void;
  loadTree: (rootPath: string) => Promise<void>;
  toggleExpand: (path: string) => void;
  /** 重新拉取某个目录的子节点并就地更新（保留展开状态） */
  refreshDir: (dirPath: string) => Promise<void>;
  /** 展开到指定文件（父链自动展开 + 选中） */
  revealPath: (filePath: string) => Promise<void>;
  /** 记录一次变更（供各视图订阅后统一展示） */
  noteChange: (paths: string[]) => void;
}

/** 拉取目录并转换为 FileNode[]（目录排前、字母序） */
export async function fetchChildren(dirPath: string): Promise<FileNode[]> {
  const result: ListResult = await window.cnke.fs.listDir(dirPath);
  if (!result.success || !result.entries) return [];
  return result.entries
    .map((e) => ({
      name: e.name,
      path: e.path,
      isDirectory: e.isDirectory,
      children: e.isDirectory ? [] : undefined,
      expanded: false,
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
}

/** 递归更新树中指定路径的节点 */
function updateNode(
  nodes: FileNode[],
  path: string,
  patch: (n: FileNode) => FileNode
): FileNode[] {
  return nodes.map((n) => {
    if (n.path === path) return patch(n);
    if (n.children && n.children.length) {
      return { ...n, children: updateNode(n.children, path, patch) };
    }
    return n;
  });
}

/** 深度查找节点 */
export function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

// ===== 跨视图同步：目录刷新订阅总线 =====
// 资源管理器、编辑器、终端等任意视图都可以订阅，实现"一处变更、处处同步"
const dirRefreshListeners = new Set<DirRefreshListener>();

/** 订阅目录刷新事件，返回取消订阅函数 */
export function onDirRefresh(listener: DirRefreshListener): () => void {
  dirRefreshListeners.add(listener);
  return () => dirRefreshListeners.delete(listener);
}

function emitDirRefresh(dirPath: string): void {
  for (const listener of dirRefreshListeners) {
    try {
      listener(dirPath);
    } catch {
      /* 单个订阅者异常不影响其他视图 */
    }
  }
}

/**
 * 规范化路径用于比较：统一分隔符 + 去尾斜杠 + 小写（Windows 大小写不敏感）
 */
function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

export const useFileStore = create<FileState>((set, get) => ({
  rootPath: null,
  tree: [],
  loading: false,
  selectedPath: null,
  lastChangeAt: 0,
  lastChangedPaths: [],

  setSelectedPath: (path) => set({ selectedPath: path }),

  noteChange: (paths) => set({ lastChangeAt: Date.now(), lastChangedPaths: paths }),

  loadTree: async (rootPath) => {
    set({ loading: true, rootPath });
    try {
      const tree = await fetchChildren(rootPath);
      // 竞态守卫：加载期间若工作区已被切换，丢弃这次结果，
      // 避免旧工作区的文件树覆盖新工作区（表现为"打开新文件夹还是旧的"）。
      if (normalizePath(get().rootPath || '') !== normalizePath(rootPath)) return;
      set({ tree, loading: false });
    } catch {
      if (normalizePath(get().rootPath || '') !== normalizePath(rootPath)) return;
      set({ tree: [], loading: false });
    }
  },

  toggleExpand: (path) => {
    const node = findNode(get().tree, path);
    if (!node || !node.isDirectory) return;
    const willExpand = !node.expanded;

    // 折叠：直接切换
    if (!willExpand) {
      set((s) => ({ tree: updateNode(s.tree, path, (n) => ({ ...n, expanded: false })) }));
      return;
    }

    // 展开：若未加载过子节点则先拉取
    if (!node.children || node.children.length === 0) {
      fetchChildren(path).then((children) => {
        set((s) => ({
          tree: updateNode(s.tree, path, (n) => ({ ...n, children, expanded: true })),
        }));
      });
    } else {
      set((s) => ({ tree: updateNode(s.tree, path, (n) => ({ ...n, expanded: true })) }));
    }
  },

  /**
   * 重新拉取某个目录的子节点并就地更新树。
   * 关键点：保留已有子节点的 expanded 状态与被展开子树的 children，
   * 避免文件变更后已展开的层级被重置导致视图跳动。
   */
  refreshDir: async (dirPath) => {
    const state = get();
    const root = state.rootPath;
    if (!root) return;

    const normDir = normalizePath(dirPath);
    const normRoot = normalizePath(root);

    // 根目录：整体重新加载
    if (normDir === normRoot) {
      const tree = await fetchChildren(root);
      set({ tree });
      return;
    }

    // 该目录未被加载过（父节点未展开）：无需刷新
    const existing = findNode(state.tree, dirPath) ||
      findNodeByNormalizedPath(state.tree, normDir);
    if (!existing || !existing.isDirectory) return;
    if (!existing.expanded && (!existing.children || existing.children.length === 0)) return;

    const fresh = await fetchChildren(dirPath);
    // 合并旧状态：同名同路径的旧节点，保留其 expanded / children
    const merged = fresh.map((n) => {
      const prev = (existing.children || []).find((c) => c.path === n.path);
      if (prev && prev.isDirectory && n.isDirectory) {
        return { ...n, expanded: prev.expanded, children: prev.children };
      }
      return n;
    });

    set((s) => ({
      tree: updateNode(s.tree, existing.path, (n) => ({ ...n, children: merged, expanded: true })),
    }));
  },

  /**
   * 展开到指定文件：从根到目标的父链逐级展开并拉取子节点，最后选中。
   * 用于终端点击报错路径 / 搜索结果点击时联动资源管理器。
   */
  revealPath: async (filePath) => {
    const root = get().rootPath;
    if (!root) return;
    const normRoot = normalizePath(root);
    const normFile = normalizePath(filePath);
    if (!normFile.startsWith(normRoot)) return;

    // 计算相对路径的各层级
    const rel = filePath.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length).replace(/^\//, '');
    const segs = rel.split('/').filter(Boolean);
    if (segs.length === 0) {
      set({ selectedPath: root });
      return;
    }

    // 逐级展开父目录
    let current = root;
    for (let i = 0; i < segs.length - 1; i++) {
      current = `${current}/${segs[i]}`.replace(/\//g, root.includes('\\') ? '\\' : '/');
      const node = findNode(get().tree, current) || findNodeByNormalizedPath(get().tree, normalizePath(current));
      if (node && node.isDirectory && !node.expanded) {
        get().toggleExpand(node.path);
        // 等待子节点加载完成
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    const target = findNode(get().tree, filePath) || findNodeByNormalizedPath(get().tree, normFile);
    set({ selectedPath: target ? target.path : filePath });
  },
}));

/** 按规范化路径查找节点（兼容分隔符 / 大小写差异） */
function findNodeByNormalizedPath(nodes: FileNode[], normPath: string): FileNode | null {
  for (const n of nodes) {
    if (normalizePath(n.path) === normPath) return n;
    if (n.children) {
      const found = findNodeByNormalizedPath(n.children, normPath);
      if (found) return found;
    }
  }
  return null;
}

// ===== 主进程文件变更 → 自动同步 =====
// 只在模块加载时订阅一次；变更按目录聚合后只刷新受影响的目录，
// 避免整树重载带来的视图跳动与性能损耗。
let watcherBound = false;
/** 常驻监听器的注销句柄：只在应用退出 / 显式解绑时使用 */
let watcherDispose: (() => void) | null = null;

/** 绑定工作区文件监听：由 AppProvider 在工作区就绪后调用 */
export function bindWorkspaceWatcher(rootPath: string): () => void {
  // 每次调用都让主进程把监听根目录切到当前工作区
  void window.cnke.fs.watchWorkspace(rootPath);

  // 监听器是模块级单例，切换工作区时只需要换主进程的监听根目录。
  // 这里必须返回空清理函数：上一版首次返回了真正的 dispose，
  // AppProvider 的 effect 在 workspacePath 变化时执行旧 cleanup 会把监听器摘掉，
  // 表现为「换过一次工作区之后文件树再也不自动刷新」（任务改名后就踩到了）。
  if (watcherBound) return () => {};
  watcherBound = true;

  watcherDispose = window.cnke.fs.onChanged(async (payload) => {
    const state = useFileStore.getState();
    const root = state.rootPath;
    if (!root || !payload?.changes?.length) return;

    // 切换工作区瞬间，旧监听的 debounce 事件可能仍在途中：
    // 只处理根目录与当前工作区一致的事件，避免旧工作区的变更污染新文件树。
    if (payload.root && normalizePath(payload.root) !== normalizePath(root)) return;

    // 收集需要刷新的目录（变更文件所在目录 + 其父目录，覆盖新增/删除目录场景）
    const dirs = new Set<string>();
    const changedPaths: string[] = [];
    for (const c of payload.changes) {
      dirs.add(c.dir);
      changedPaths.push(c.relativePath);
      // 路径中任一层的父目录也刷新，确保新增/删除的子目录层级正确
      const rel = c.relativePath.split('/');
      if (rel.length > 1) {
        dirs.add(c.dir);
      }
    }

    // 记录变更（各视图可订阅展示 / 高亮）
    state.noteChange(changedPaths);

    // 刷新受影响的目录 + 广播给其他视图（编辑器/终端）
    for (const d of dirs) {
      await state.refreshDir(d);
      emitDirRefresh(d);
    }
  });

  // 不返回真实 dispose：见函数开头说明（cleanup 会摘掉常驻监听器）
  return () => {};
}

/** 解绑（应用退出时调用；切换工作区不需要解绑，换监听根目录即可） */
export function unbindWorkspaceWatcher(): void {
  watcherDispose?.();
  watcherDispose = null;
  watcherBound = false;
  void window.cnke.fs.unwatchWorkspace();
}
