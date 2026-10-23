/**
 * PlaywrightTools - 浏览器自动化接口（W12）
 *
 * 设计：
 * - 不强制依赖 playwright（避免 200MB+ 打包膨胀）
 * - 通过 PlaywrightAdapter 接口暴露能力
 * - 用户运行 `npm install playwright` 后可启用真实实现
 * - 默认 mock 实现：返回"未安装 playwright"错误，提示用户安装
 *
 * 真实实现思路（用户启用时）：
 *   import { chromium } from 'playwright';
 *   this.browser = await chromium.launch({ headless: true });
 *   this.page = await this.browser.newPage();
 */

export interface PlaywrightAdapter {
  readonly available: boolean;
  navigate(url: string): Promise<{ url: string; title: string; status: number }>;
  screenshot(path?: string): Promise<{ path: string; base64?: string; width: number; height: number }>;
  click(selector: string): Promise<{ success: boolean; error?: string }>;
  input(selector: string, text: string): Promise<{ success: boolean; error?: string }>;
  extract(selector: string, attr?: 'text' | 'html'): Promise<{ value: string }>;
  close(): Promise<void>;
  /** 用于诊断 */
  getStatus(): { available: boolean; currentUrl?: string; pageTitle?: string };
}

/** 默认实现：未启用（用户未安装 playwright） */
export class MockPlaywrightAdapter implements PlaywrightAdapter {
  readonly available = false;

  navigate(_url: string): Promise<{ url: string; title: string; status: number }> {
    return Promise.reject(new Error('Playwright 未启用。请先运行：npm install playwright && npx playwright install chromium'));
  }
  screenshot(_path?: string): Promise<{ path: string; base64?: string; width: number; height: number }> {
    return Promise.reject(new Error('Playwright 未启用'));
  }
  click(_selector: string): Promise<{ success: boolean; error?: string }> {
    return Promise.reject(new Error('Playwright 未启用'));
  }
  input(_selector: string, _text: string): Promise<{ success: boolean; error?: string }> {
    return Promise.reject(new Error('Playwright 未启用'));
  }
  extract(_selector: string, _attr?: 'text' | 'html'): Promise<{ value: string }> {
    return Promise.reject(new Error('Playwright 未启用'));
  }
  close(): Promise<void> { return Promise.resolve(); }
  getStatus() { return { available: false }; }
}

/**
 * 真实实现（用户在 ToolManager 构造时可选注入）
 * 这部分代码只在用户安装 playwright 后才会执行
 */
export async function createRealPlaywrightAdapter(): Promise<PlaywrightAdapter | null> {
  try {
    // 原生动态 import —— playwright 是可选依赖，不存在时 catch 返回 null
    const playwright: unknown = await import('playwright').catch(() => null);
    if (!playwright || typeof playwright !== 'object') return null;
    const pw = playwright as Record<string, unknown>;
    const chromium = pw.chromium as Record<string, unknown> | undefined;
    if (!chromium) return null;
    const browser = await (chromium.launch as (opts: Record<string, unknown>) => Promise<unknown>)({ headless: true });
    if (!browser || typeof browser !== 'object') return null;
    const br = browser as Record<string, unknown>;
    const context = await (br.newContext as (opts: Record<string, unknown>) => Promise<unknown>)({ viewport: { width: 1280, height: 720 } });
    if (!context || typeof context !== 'object') return null;
    const ctx = context as Record<string, unknown>;
    const page = await (ctx.newPage as () => Promise<unknown>)();
    if (!page || typeof page !== 'object') return null;
    const pg = page as Record<string, unknown>;

    return {
      available: true,
      async navigate(url) {
        const resp = await (pg.goto as (u: string, opts: Record<string, unknown>) => Promise<unknown>)(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const got = resp as Record<string, unknown> | null | undefined;
        return {
          url: (pg.url as () => string)(),
          title: await (pg.title as () => Promise<string>)(),
          status: (got?.status as () => number | undefined)?.() ?? 0,
        };
      },
      async screenshot(path) {
        const buf = await (pg.screenshot as (opts: Record<string, unknown>) => Promise<unknown>)({ fullPage: false, type: 'png' });
        if (path) {
          const fs = await import('node:fs/promises');
          await (fs.writeFile as (p: string, data: unknown) => Promise<void>)(path, buf);
        }
        const bufStr = typeof buf === 'object' && buf && typeof (buf as Buffer).toString === 'function'
          ? (buf as Buffer).toString('base64')
          : '';
        return { path: path || '', base64: bufStr, width: 1280, height: 720 };
      },
      async click(selector) {
        try {
          await (pg.click as (s: string, opts: Record<string, unknown>) => Promise<unknown>)(selector, { timeout: 10_000 });
          return { success: true };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { success: false, error: msg };
        }
      },
      async input(selector, text) {
        try {
          await (pg.fill as (s: string, t: string, opts: Record<string, unknown>) => Promise<unknown>)(selector, text, { timeout: 10_000 });
          return { success: true };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { success: false, error: msg };
        }
      },
      async extract(selector, attr) {
        const locator = (pg.locator as (s: string) => Record<string, unknown>)(selector);
        const value = attr === 'html'
          ? await (locator.innerHTML as () => Promise<string>)()
          : await (locator.innerText as () => Promise<string>)();
        return { value };
      },
      async close() {
        await (br.close as () => Promise<unknown>)();
      },
      getStatus() {
        return { available: true, currentUrl: (pg.url as () => string)(), pageTitle: '' };
      },
    };
  } catch {
    return null;
  }
}
