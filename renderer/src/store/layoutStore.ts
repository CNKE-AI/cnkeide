import { create } from 'zustand';

/**
 * 面板可见性状态（编辑器 / 预览 / 终端 / 资源管理器）。
 *
 * 之所以独立成 store 而不是放在 MainLayout 的 useState 中：
 * 各面板头部自己的 × 按钮（EditorPanel / PreviewPanel / TerminalPanel / FileTree）也需要读写可见性，
 * 通过 props 逐层透传会让组件耦合且易漏；同时这里做了 localStorage 持久化，
 * 刷新或重启后保持用户上次的面板布局。
 */
interface LayoutState {
  /** 编辑器面板（中间上部）可见 */
  editorVisible: boolean;
  /** 预览面板（中间中部）可见 */
  previewVisible: boolean;
  /** 终端面板（中间下部）可见 */
  terminalVisible: boolean;
  /** 资源管理器面板（最右）可见 */
  explorerVisible: boolean;
  /** 对话面板（最左）可见 */
  chatVisible: boolean;
  /** 切换某个面板的可见性 */
  togglePanel: (panel: PanelKey) => void;
  /** 显式设置某个面板可见性 */
  setPanelVisible: (panel: PanelKey, visible: boolean) => void;
}

export type PanelKey = 'chat' | 'editor' | 'preview' | 'terminal' | 'explorer';

const STORAGE_KEY = 'cnke.layout.panels';

interface PersistedFlags {
  editorVisible: boolean;
  previewVisible: boolean;
  terminalVisible: boolean;
  explorerVisible: boolean;
  chatVisible: boolean;
}

const DEFAULTS: PersistedFlags = {
  editorVisible: true,
  // 预览默认关闭：不主动占屏，用户需要时从折叠条恢复
  previewVisible: false,
  terminalVisible: true,
  explorerVisible: true,
  chatVisible: true,
};

function loadFlags(): PersistedFlags {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    // 逐字段兜底：老版本数据缺字段时不至于把面板判成隐藏
    return {
      editorVisible: parsed?.editorVisible !== false,
      previewVisible: parsed?.previewVisible === true,
      terminalVisible: parsed?.terminalVisible !== false,
      explorerVisible: parsed?.explorerVisible !== false,
      chatVisible: parsed?.chatVisible !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(flags: PersistedFlags) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch {
    /* ignore */
  }
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  ...loadFlags(),

  togglePanel: (panel) => get().setPanelVisible(panel, !get()[keyOf(panel)]),

  setPanelVisible: (panel, visible) => {
    const key = keyOf(panel);
    set({ [key]: visible });
    const s = get();
    persist({
      editorVisible: s.editorVisible,
      previewVisible: s.previewVisible,
      terminalVisible: s.terminalVisible,
      explorerVisible: s.explorerVisible,
      chatVisible: s.chatVisible,
    });
  },
}));

function keyOf(panel: PanelKey): keyof PersistedFlags {
  switch (panel) {
    case 'editor': return 'editorVisible';
    case 'preview': return 'previewVisible';
    case 'terminal': return 'terminalVisible';
    case 'explorer': return 'explorerVisible';
    case 'chat': return 'chatVisible';
  }
}
