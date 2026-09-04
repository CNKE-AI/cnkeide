import { create } from 'zustand';

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
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activePath: null,

  openFile: async (path, name) => {
    const { tabs } = get();
    // 已打开则仅激活
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      set({ activePath: path });
      return;
    }
    const res = await window.cnke.fs.readFile(path);
    if (!res.success) {
      alert(res.error || '读取文件失败');
      return;
    }
    const fileName = name ?? window.cnke.path.basename(path);
    const tab: EditorTab = { path, name: fileName, content: res.content ?? '', dirty: false };
    set((s) => ({ tabs: [...s.tabs, tab], activePath: path }));
  },

  closeTab: (path) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === path);
      const tabs = s.tabs.filter((t) => t.path !== path);
      let activePath = s.activePath;
      if (s.activePath === path) {
        // 激活相邻标签
        activePath = tabs.length > 0 ? tabs[Math.min(idx, tabs.length - 1)].path : null;
      }
      return { tabs, activePath };
    });
  },

  closeAll: () => set({ tabs: [], activePath: null }),

  updateContent: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, content } : t)),
    }));
  },

  saveFile: async (path) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return false;
    const res = await window.cnke.fs.writeFile(path, tab.content);
    if (res.success) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.path === path ? { ...t, dirty: false } : t)),
      }));
      return true;
    }
    alert(res.error || '保存失败');
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
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, dirty } : t)),
    }));
  },
}));
