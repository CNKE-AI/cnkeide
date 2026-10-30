/**
 * 内置预览浏览器控制器
 *
 * 目标：让 Agent 的 browser_* 工具操作**软件里那个预览面板**，而不是另起一个
 * headless chromium。用户能实时看到 Agent 在点什么、页面长什么样。
 *
 * 实现要点：
 * - webview 的 guest webContents 由主进程在 `did-attach-webview` 时捕获，
 *   有了它就能 loadURL / executeJavaScript / capturePage，无需渲染层配合；
 * - 导航、点击、输入、取值、截图**全部在主进程完成**，渲染层只负责把面板显示出来；
 * - 面板默认是关闭的，Agent 首次调用时自动打开，避免"操作了一个看不见的浏览器"。
 *
 * 与 PlaywrightTools 的 PlaywrightAdapter 保持同一契约，因此 ToolManager 无需感知差异。
 */
import { BrowserWindow, WebContents } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PlaywrightAdapter } from '../core-fork/tools/PlaywrightTools';

/** 归一化 URL：缺协议时补 http://，便于模型只给 localhost:5173 */
export function normalizePreviewUrl(input: string): string {
  const value = String(input ?? '').trim();
  if (!value) return '';
  if (/^(https?|file):\/\//i.test(value)) return value;
  return `http://${value}`;
}

/**
 * 内置预览浏览器的单例持有者。
 *
 * 生命周期：主窗口创建时 register()，窗口销毁时 detach()。
 * guest 会被 webview 重建（如 src 变化、面板重新挂载）而失效，因此每次使用前
 * 都通过 isAlive() 校验，失效则重新请求渲染层挂载。
 */
export class PreviewBrowser {
  private win: BrowserWindow | null = null;
  private guest: WebContents | null = null;

  setWindow(win: BrowserWindow | null): void {
    this.win = win;
  }

  /** 由 main.ts 的 did-attach-webview 调用，登记当前预览页 webContents */
  attachGuest(guest: WebContents): void {
    this.guest = guest;
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  /** 由 main.ts 的 webview destroyed 事件调用，避免持有已销毁的引用 */
  detachGuest(guest: WebContents): void {
    if (this.guest === guest) this.guest = null;
  }

  /** guest 是否仍然可用 */
  private alive(): WebContents | null {
    const g = this.guest;
    if (!g || g.isDestroyed()) {
      this.guest = null;
      return null;
    }
    return g;
  }

  /**
   * 确保有一个可用的预览页。
   *
   * 面板默认不可见（layoutStore.previewVisible=false），Agent 一调用浏览器工具
   * 用户就看到界面里"凭空多了个预览面板"是合理的——这正是内置预览浏览器的意义，
   * 而不是偷偷在后台跑。若 webview 还没挂载，等待 dom-ready 事件。
   */
  private async ensureGuest(timeoutMs = 15_000): Promise<WebContents> {
    const existing = this.alive();
    if (existing) return existing;

    const win = this.win;
    if (!win || win.isDestroyed()) throw new Error('主窗口不可用，无法使用内置预览浏览器');

    // 让渲染层把预览面板显示出来（若尚未显示）
    win.webContents.send('preview:show');

    return new Promise<WebContents>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('内置预览浏览器未就绪（预览面板可能尚未完成加载）'));
      }, timeoutMs);

      const onEvent = () => {
        const g = this.alive();
        if (g) {
          cleanup();
          resolve(g);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        win.webContents.removeListener('did-attach-webview', handler);
        clearInterval(poller);
      };

      // did-attach-webview 由 main.ts 转发，这里同时轮询兜底（事件可能早于注册）
      const handler = (_e: unknown, guest: WebContents) => {
        this.attachGuest(guest);
        onEvent();
      };
      const poller = setInterval(onEvent, 120);
      win.webContents.on('did-attach-webview', handler);
    });
  }

  /** 等待页面加载完成（dom-ready 或超时后继续，不阻塞工具） */
  private async waitReady(guest: WebContents, timeoutMs = 20_000): Promise<void> {
    if (!guest.isLoading()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        guest.removeListener('dom-ready', done);
        resolve();
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        guest.removeListener('dom-ready', done);
        resolve();
      };
      guest.once('dom-ready', done);
    });
  }

  async navigate(url: string): Promise<{ url: string; title: string; status: number }> {
    const target = normalizePreviewUrl(url);
    if (!target) throw new Error('缺少 URL');
    const guest = await this.ensureGuest();
    await guest.loadURL(target).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // 站点自身 4xx/5xx 也会让 loadURL reject；此时页面已显示，交由后续取值判断
      if (!/ERR_ABORTED/i.test(msg)) throw new Error(msg);
    });
    await this.waitReady(guest);
    return {
      url: guest.getURL(),
      title: guest.getTitle(),
      status: 200,
    };
  }

  async screenshot(saveDir: string): Promise<{ path: string; width: number; height: number; dataUrl: string }> {
    const guest = await this.ensureGuest();
    const image = await guest.capturePage();
    if (image.isEmpty()) throw new Error('截图失败：页面内容为空');
    const { width, height } = image.getSize();
    const png = image.toPNG();
    await fs.mkdir(saveDir, { recursive: true });
    const target = path.join(saveDir, `preview-${Date.now()}.png`);
    await fs.writeFile(target, png);
    return { path: target, width, height, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  }

  async click(selector: string): Promise<void> {
    const guest = await this.ensureGuest();
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      if (typeof el.click === 'function') { try { el.click(); } catch (e) {} }
      return 'OK';
    })()`;
    const result = await guest.executeJavaScript(code, true);
    if (result === 'NOT_FOUND') throw new Error(`未找到元素：${selector}`);
  }

  async input(selector: string, text: string): Promise<void> {
    const guest = await this.ensureGuest();
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      el.focus();
      const value = ${JSON.stringify(text)};
      if ('value' in el) {
        el.value = value;
      } else if (el.isContentEditable) {
        el.textContent = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK';
    })()`;
    const result = await guest.executeJavaScript(code, true);
    if (result === 'NOT_FOUND') throw new Error(`未找到元素：${selector}`);
  }

  async extract(selector: string, attr?: 'text' | 'html'): Promise<string> {
    const guest = await this.ensureGuest();
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      return ${attr === 'html' ? 'el.innerHTML' : '(el.innerText || el.textContent || "")'};
    })()`;
    const result = await guest.executeJavaScript(code, true);
    if (result === null || result === undefined) throw new Error(`未找到元素：${selector}`);
    return String(result);
  }

  status(): { available: boolean; currentUrl?: string; pageTitle?: string } {
    const guest = this.alive();
    if (!guest) return { available: false };
    return { available: true, currentUrl: guest.getURL(), pageTitle: guest.getTitle() };
  }
}

/**
 * 把 PreviewBrowser 适配成 PlaywrightAdapter 契约。
 *
 * 这样 ToolManager 里 6 个 browser_* case 完全不用改，只需换一个适配器实例。
 * `available` 恒为 true：内置预览浏览器不依赖 playwright 安装，随时可用。
 */
export class PreviewBrowserAdapter implements PlaywrightAdapter {
  readonly available = true;

  constructor(
    private browser: PreviewBrowser,
    private screenshotDir: string,
    private lastShot: { path: string; dataUrl: string; width: number; height: number } | null = null,
  ) {}

  async navigate(url: string) {
    return this.browser.navigate(url);
  }

  async screenshot() {
    const r = await this.browser.screenshot(this.screenshotDir);
    this.lastShot = r;
    return { path: r.path, base64: r.dataUrl.split(',')[1] || '', width: r.width, height: r.height };
  }

  /** 最近一次截图（供聊天窗口直接显示，不进 LLM 上下文） */
  takeLastScreenshot() {
    const shot = this.lastShot;
    this.lastShot = null;
    return shot;
  }

  async click(selector: string) {
    try {
      await this.browser.click(selector);
      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async input(selector: string, text: string) {
    try {
      await this.browser.input(selector, text);
      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async extract(selector: string, attr?: 'text' | 'html') {
    try {
      return { value: await this.browser.extract(selector, attr) };
    } catch (e: unknown) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  }

  /** 内置预览不关闭：它同时是用户自己的预览面板，关掉会打断用户工作 */
  async close(): Promise<void> {
    return;
  }

  getStatus() {
    return this.browser.status();
  }
}
