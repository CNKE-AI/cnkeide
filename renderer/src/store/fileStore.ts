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

interface FileState {
  tree: FileNode[];
  loading: boolean;
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
  loadTree: (rootPath: string) => Promise<void>;
  toggleExpand: (path: string) => void;
}

/** 拉取目录并转换为 FileNode[]（目录排前、字母序） */
async function fetchChildren(dirPath: string): Promise<FileNode[]> {
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

export const useFileStore = create<FileState>((set, get) => ({
  tree: [],
  loading: false,
  selectedPath: null,

  setSelectedPath: (path) => set({ selectedPath: path }),

  loadTree: async (rootPath) => {
    set({ loading: true });
    try {
      const tree = await fetchChildren(rootPath);
      set({ tree, loading: false });
    } catch {
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
}));

/** 深度查找节点 */
function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}
