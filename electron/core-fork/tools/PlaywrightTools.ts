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

  async navigate(url: string): Promise<{ url: string; title: string; status: number }> {
    throw new Error('Playwright 未启用。请先运行：npm install playwright && npx playwright install chromium');
  }
  async screenshot(): Promise<any> {
    throw new Error('Playwright 未启用');
  }
  async click(): Promise<{ success: boolean; error?: string }> {
    throw new Error('Playwright 未启用');
  }
  async input(): Promise<{ success: boolean; error?: string }> {
    throw new Error('Playwright 未启用');
  }
  async extract(): Promise<{ value: string }> {
    throw new Error('Playwright 未启用');
  }
  async close(): Promise<void> { /* noop */ }
  getStatus() { return { available: false }; }
}

/**
 * 真实实现（用户在 ToolManager 构造时可选注入）
 * 这部分代码只在用户安装 playwright 后才会执行
 */
export async function createRealPlaywrightAdapter(): Promise<PlaywrightAdapter | null> {
  try {
    // 动态 import：避免强制依赖（用 Function 包裹避免 Vite/Rollup 静态分析）
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    // @ts-ignore - 可选依赖
    const playwright = await dynamicImport('playwright').catch(() => null);
    if (!playwright) return null;
    // @ts-ignore
    const { chromium } = playwright;
    // @ts-ignore
    const browser = await chromium.launch({ headless: true });
    // @ts-ignore
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    // @ts-ignore
    const page = await context.newPage();

    return {
      available: true,
      async navigate(url) {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return {
          url: page.url(),
          title: await page.title(),
          status: resp?.status() ?? 0,
        };
      },
      async screenshot(path) {
        // @ts-ignore
        const buf = await page.screenshot({ fullPage: false, type: 'png' });
        if (path) {
          // @ts-ignore
          const fs = await import('node:fs/promises');
          await fs.writeFile(path, buf);
        }
        return { path: path || '', base64: buf.toString('base64'), width: 1280, height: 720 };
      },
      async click(selector) {
        try {
          // @ts-ignore
          await page.click(selector, { timeout: 10_000 });
          return { success: true };
        } catch (e: any) {
          return { success: false, error: e.message || String(e) };
        }
      },
      async input(selector, text) {
        try {
          // @ts-ignore
          await page.fill(selector, text, { timeout: 10_000 });
          return { success: true };
        } catch (e: any) {
          return { success: false, error: e.message || String(e) };
        }
      },
      async extract(selector, attr) {
        // @ts-ignore
        const value = attr === 'html' ? await page.locator(selector).innerHTML() : await page.locator(selector).innerText();
        return { value };
      },
      async close() {
        await browser.close();
      },
      getStatus() {
        return { available: true, currentUrl: page.url(), pageTitle: '' };
      },
    };
  } catch {
    return null;
  }
}
