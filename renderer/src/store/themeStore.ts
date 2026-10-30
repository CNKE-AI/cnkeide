import { create } from 'zustand';

export const THEMES = [
  { id: 'dark', label: '经典深色', description: '石墨灰与柔和紫色', background: '#141416', accent: '#9970f5', secondary: '#67e8f9', foreground: '#f7f7f7', scheme: 'dark' },
  { id: 'light', label: '清透浅色', description: '明亮背景与清晰层次', background: '#f9f9fb', accent: '#7040e8', secondary: '#0b7285', foreground: '#19191f', scheme: 'light' },
  { id: 'aurora', label: '极光青', description: '深海蓝底 · 青绿极光', background: '#0e1923', accent: '#5eead4', secondary: '#93c5fd', foreground: '#e5f0f0', scheme: 'dark' },
  { id: 'cyber', label: '量子蓝', description: '午夜蓝 · 电光蓝 · 冰青', background: '#0b1224', accent: '#82b4ff', secondary: '#67e8f9', foreground: '#e6edf9', scheme: 'dark' },
  { id: 'muse', label: '陶光', description: '暖瓷白 · 桑葚紫 · 玉石绿', background: '#faf6f0', accent: '#864064', secondary: '#27695e', foreground: '#352d38', scheme: 'light' },
  { id: 'nebula', label: '星云紫', description: '深空紫 · 星光粉 · 冰青', background: '#171222', accent: '#d8b4fe', secondary: '#99e5df', foreground: '#f3eafa', scheme: 'dark' },
  { id: 'forest', label: '森境', description: '墨绿 · 鼠尾草 · 香槟金', background: '#101c18', accent: '#a3d9ad', secondary: '#e4cc95', foreground: '#e8f2e9', scheme: 'dark' },
  { id: 'amber', label: '琥珀夜', description: '暖炭黑 · 琥珀金 · 雾青', background: '#211810', accent: '#f5ca88', secondary: '#9edbd0', foreground: '#f5eee3', scheme: 'dark' },
  { id: 'glacier', label: '冰川', description: '冰白 · 钴蓝 · 冰湖绿', background: '#f1f7fc', accent: '#24559b', secondary: '#176766', foreground: '#24354a', scheme: 'light' },
  { id: 'sakura', label: '樱雾', description: '樱白 · 玫瑰红 · 鸢尾紫', background: '#fff5f7', accent: '#963c60', secondary: '#65518e', foreground: '#412c38', scheme: 'light' },
] as const;

export type ThemeMode = (typeof THEMES)[number]['id'];

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEMES.some((theme) => theme.id === value);
}

export function nextTheme(theme: ThemeMode): ThemeMode {
  return THEMES[(THEMES.findIndex((item) => item.id === theme) + 1) % THEMES.length].id;
}

interface ThemeState {
  theme: ThemeMode;
  toggleTheme: () => void;
  setTheme: (t: ThemeMode) => void;
}

const STORAGE_KEY = 'cnke.theme';

function initialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isThemeMode(saved)) return saved;
  } catch {
    /* ignore */
  }
  return 'dark';
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme(),
  toggleTheme: () =>
    set((s) => {
      const next = nextTheme(s.theme);
      applyTheme(next);
      return { theme: next };
    }),
  setTheme: (t) => {
    applyTheme(t);
    set({ theme: t });
  },
}));

/** 将主题应用到 DOM（根元素 class + localStorage 持久化） */
export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  const selected = THEMES.find((item) => item.id === theme)!;
  for (const item of THEMES) {
    root.classList.toggle(item.id, item.id === 'light' ? selected.scheme === 'light' : item.id === theme);
  }
  root.dataset.theme = theme;
  root.style.colorScheme = selected.scheme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}
