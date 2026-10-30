import { create } from 'zustand';

/**
 * 内置预览浏览器的地址状态
 *
 * 原实现把 URL 放在 PreviewPanel 的私有 useState 里，主进程无从感知，
 * 因此 Agent 的 browser_navigate 只能另起 headless 浏览器。
 * 提升到 store 后：
 * - 面板地址栏始终反映真实页面（Agent 导航后用户立刻看到地址变化）；
 * - 主进程可同步查询当前地址。
 */
const URL_KEY = 'cnke.preview.url';
export const DEFAULT_PREVIEW_URL = 'http://localhost:5173';

interface PreviewState {
  /** 当前 webview 的 src */
  url: string;
  /** 地址栏草稿（用户输入中、尚未提交） */
  draft: string;
  setUrl: (url: string) => void;
  setDraft: (draft: string) => void;
  /** 提交地址栏：缺协议补 http:// 并持久化 */
  commit: (next?: string) => void;
}

function loadUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_PREVIEW_URL;
  } catch {
    return DEFAULT_PREVIEW_URL;
  }
}

function persistUrl(url: string): void {
  try {
    localStorage.setItem(URL_KEY, url);
  } catch {
    /* ignore */
  }
}

/** 与地址栏一致的归一化规则 */
export function normalizePreviewUrl(input: string): string {
  const value = String(input ?? '').trim();
  if (!value) return '';
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  url: loadUrl(),
  draft: loadUrl(),

  setUrl: (url) => {
    const normalized = normalizePreviewUrl(url);
    if (!normalized) return;
    persistUrl(normalized);
    set({ url: normalized, draft: normalized });
  },

  setDraft: (draft) => set({ draft }),

  commit: (next) => {
    const target = normalizePreviewUrl(next ?? get().draft);
    if (!target) return;
    get().setUrl(target);
  },
}));
