/**
 * PPT PDF 导出引擎
 *
 * 思路：把 AI 渲染好的 HTML（含 @media print 分页样式）加载进一个隐藏的
 * BrowserWindow，用 webContents.printToPDF 输出 16:9 PDF。
 *
 * 关键点：
 * - about:blank + document.write 加载完整 HTML（避开 data URL 2MB 长度限制）
 * - preferCSSPageSize: true 采用 HTML 里 @page 13.333in x 7.5in 的 16:9 页面
 * - printBackground: true 保留渐变/色块背景
 * - @media print 里 .slide 全部 display:flex + page-break-after，每页一屏
 */

import { BrowserWindow } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface PdfExportResult {
  success: boolean;
  path?: string;
  /** PDF 页数（按 buffer 无法直接算，这里返回大致值） */
  error?: string;
}

export async function exportHtmlToPdf(html: string, savePath: string): Promise<PdfExportResult> {
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    await win.loadURL('about:blank');
    // document.write 同步写入完整文档（含 <style> / <script>，都会执行）
    await win.webContents.executeJavaScript(
      `document.open(); document.write(${JSON.stringify(html)}); document.close(); true`,
      true,
    );

    // 等待布局/字体渲染稳定
    await new Promise((r) => setTimeout(r, 600));

    const pdfBuffer = await win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    await fsp.mkdir(path.dirname(savePath), { recursive: true });
    await fsp.writeFile(savePath, pdfBuffer);

    return { success: true, path: savePath };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}