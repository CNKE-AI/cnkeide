import { create } from 'zustand';
import { useAgentActivityStore } from './agentActivityStore';

import { toast } from '../utils/toast';
/** 编辑器打开的单个文件标签 */
export interface EditorTab {
  /** 文件绝对路径（作为唯一 key） */
  path: string;
  /** 文件名（用于标签显示） */
  name: string;
  /** 已读取的文件内容 */
  content: string;
  /** 是否有未保存的修改 */
  dirty: boolean;
  /** 磁盘上的内容已被外部（Agent / 终端等）修改，本地内容已过期 */
  stale: boolean;
  /** 外部修改时间戳，用于提示条动画/排序 */
  staleAt: number;
}

interface EditorState {
  /** 打开的文件标签列表 */
  tabs: EditorTab[];
  /** 当前激活标签路径（null 表示无打开文件） */
  activePath: string | null;
  /** 打开文件（若已打开则激活，否则读取并新增标签） */
  openFile: (path: string, name?: string) => Promise<void>;
  /** 关闭标签（不保存） */
  closeTab: (path: string) => void;
  /** 关闭所有标签 */
  closeAll: () => void;
  /** 更新某文件内容（编辑器输入时同步） */
  updateContent: (path: string, content: string) => void;
  /** 保存当前文件到磁盘 */
  saveFile: (path: string) => Promise<boolean>;
  /** 保存全部 */
  saveAll: () => Promise<void>;
  /** 标记为未保存 */
  markDirty: (path: string, dirty: boolean) => void;
  /**
   * 外部（Agent / 终端 / 其他工具）改动了磁盘文件。
   * - 未打开的标签：忽略；
   * - 已打开且无本地修改：自动重新加载，做到"实时跟随"；
   * - 已打开且有本地修改：标记 stale，提示用户手动处理，避免覆盖用户编辑。
   */
  noteExternalChange: (path: string) => Promise<void>;
  /** 重新加载指定文件（用户点击"重新加载"时调用） */
  reloadFile: (path: string) => Promise<void>;
  /** 清除 stale 标记 */
  clearStale: (path: string) => void;
  /**
   * 关闭所有不属于指定工作区根目录的标签。
   * 切换/打开新工作区时调用，避免旧工作区的文件残留在编辑器里
   * 造成"换了文件夹还是显示旧文件"的错觉。
   * 返回被关闭的标签数。
   */
  closeTabsOutsideRoot: (rootPath: string) => number;
}

/** 路径规范化比较（Windows 大小写不敏感 + 分隔符统一） */
function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activePath: null,

  openFile: async (path, name) => {
    const { tabs } = get();
    const existing = tabs.find((t) => samePath(t.path, path));
    // 已打开则仅激活（同时清掉 stale，视为用户主动查看最新状态）
    if (existing) {
      set((s) => ({
        activePath: existing.path,
        tabs: s.tabs.map((t) => (samePath(t.path, path) ? { ...t, stale: false } : t)),
      }));
      return;
    }
    const res = await window.cnke.fs.readFile(path);
    if (!res.success) {
      toast.error(res.error || '读取文件失败');
      return;
    }
    const fileName = name ?? window.cnke.path.basename(path);
    const tab: EditorTab = {
      path,
      name: fileName,
      content: res.content ?? '',
      dirty: false,
      stale: false,
      staleAt: 0,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activePath: path }));
  },

  closeTab: (path) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => samePath(t.path, path));
      const tabs = s.tabs.filter((t) => !samePath(t.path, path));
      let activePath = s.activePath;
      if (s.activePath && samePath(s.activePath, path)) {
        // 激活相邻标签
        activePath = tabs.length > 0 ? tabs[Math.min(idx, tabs.length - 1)].path : null;
      }
      return { tabs, activePath };
    });
  },

  closeAll: () => set({ tabs: [], activePath: null }),

  updateContent: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (samePath(t.path, path) ? { ...t, content } : t)),
    }));
  },

  saveFile: async (path) => {
    const tab = get().tabs.find((t) => samePath(t.path, path));
    if (!tab) return false;
    const res = await window.cnke.fs.writeFile(tab.path, tab.content);
    if (res.success) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          samePath(t.path, path) ? { ...t, dirty: false, stale: false, staleAt: 0 } : t
        ),
      }));
      // 保存后同步清除 Agent 活动面板里的"已修改"标记
      useAgentActivityStore.getState().clearModified(tab.path);
      // 用户手动保存 = 接受当前内容，撤销记录随之失效
      useAgentActivityStore.getState().clearAgentEdit(tab.path);
      return true;
    }
    toast.error(res.error || '保存失败');
    return false;
  },

  saveAll: async () => {
    const { tabs } = get();
    for (const t of tabs) {
      if (t.dirty) await get().saveFile(t.path);
    }
  },

  markDirty: (path, dirty) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (samePath(t.path, path) ? { ...t, dirty } : t)),
    }));
  },

  noteExternalChange: async (path) => {
    const tab = get().tabs.find((t) => samePath(t.path, path));
    if (!tab) return; // 未打开的文件无需处理

    // 无本地修改：自动重新加载，实现编辑器实时跟随 Agent 输出
    if (!tab.dirty) {
      const res = await window.cnke.fs.readFile(tab.path);
      if (res.success) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            samePath(t.path, path)
              ? { ...t, content: res.content ?? '', stale: false, staleAt: 0 }
              : t
          ),
        }));
      }
      return;
    }

    // 有本地修改：标记 stale，保留用户编辑不动
    set((s) => ({
      tabs: s.tabs.map((t) =>
        samePath(t.path, path) ? { ...t, stale: true, staleAt: Date.now() } : t
      ),
    }));
  },

  reloadFile: async (path) => {
    const tab = get().tabs.find((t) => samePath(t.path, path));
    if (!tab) return;
    const res = await window.cnke.fs.readFile(tab.path);
    if (!res.success) return;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        samePath(t.path, path)
          ? { ...t, content: res.content ?? '', dirty: false, stale: false, staleAt: 0 }
          : t
      ),
    }));
  },

  clearStale: (path) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (samePath(t.path, path) ? { ...t, stale: false, staleAt: 0 } : t)),
    }));
  },

  closeTabsOutsideRoot: (rootPath) => {
    const normRoot = (rootPath || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    if (!normRoot) return 0;

    const { tabs, activePath } = get();
    // 仅保留位于新工作区内的文件；不同工作区的标签一律关闭
    const kept = tabs.filter((t) => {
      const p = t.path.replace(/\\/g, '/').toLowerCase();
      return p === normRoot || p.startsWith(normRoot + '/');
    });
    const removed = tabs.length - kept.length;
    if (removed === 0 && (activePath === null || kept.some((t) => samePath(t.path, activePath)))) {
      return 0;
    }

    // 激活标签若被关闭，则回退到保留列表的最后一个（无则置空）
    let nextActive = activePath;
    if (activePath && !kept.some((t) => samePath(t.path, activePath))) {
      nextActive = kept.length > 0 ? kept[kept.length - 1].path : null;
    }

    set({ tabs: kept, activePath: nextActive });
    return removed;
  },
}));
