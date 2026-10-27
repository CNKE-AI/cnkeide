/**
 * 极简全局 Toast。
 *
 * 替代原生 alert：alert 是阻塞式模态，会打断渲染、暂停动画，样式也与 IDE 完全脱节；
 * 而对话流程里绝大多数提示（"最多上传 6 个"、"复制失败"）都不需要用户确认。
 * 需要用户决策的（删除会话、回滚文件）仍走 confirm。
 */
export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<(list: ToastItem[]) => void>();

function emit(): void {
  for (const fn of listeners) fn(items);
}

/** 订阅 Toast 列表（ToastHost 使用）；订阅时会立刻收到当前快照 */
export function subscribeToast(fn: (list: ToastItem[]) => void): () => void {
  listeners.add(fn);
  fn(items);
  return () => {
    listeners.delete(fn);
  };
}

function push(kind: ToastKind, text: string | null | undefined, duration = 3600): void {
  // 大量调用点来自 IPC 返回的 `res.error || '默认文案'`，类型上是 string | undefined；
  // 这里统一兜住空值（空提示没有意义，直接丢弃）
  if (!text) return;
  const id = ++seq;
  // 同时最多堆 4 条，避免批量报错时糊满屏幕
  items = [...items, { id, kind, text }].slice(-4);
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, duration);
}

export const toast = {
  info: (text: string | null | undefined) => push('info', text),
  success: (text: string | null | undefined) => push('success', text),
  error: (text: string | null | undefined) => push('error', text),
};
