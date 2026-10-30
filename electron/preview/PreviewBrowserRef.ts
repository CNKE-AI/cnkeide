/**
 * 内置预览浏览器单例引用
 *
 * 主进程里有两处需要它：
 * - ipc/handlers.ts：响应渲染层「当前预览页信息」等查询；
 * - core-fork/agent：AgentManager 装配 browser_* 工具的适配器。
 *
 * 单独放一个极薄的模块，避免 agent 层反向 import electron/main.ts（会循环依赖）。
 */
import { PreviewBrowser } from './PreviewBrowser';

let instance: PreviewBrowser | null = null;

export function setPreviewBrowser(browser: PreviewBrowser | null): void {
  instance = browser;
}

/** 取内置预览浏览器；主窗口尚未创建时返回 null，调用方需自行降级 */
export function getPreviewBrowser(): PreviewBrowser | null {
  return instance;
}
