/**
 * PPT 远程模板客户端
 *
 * 职责：
 * - fetch 索引 JSON
 * - 下载模板 .pptx 到 userData/templates/{id}.pptx
 * - 缓存命中：已下载过则直接返回本地路径，不再下载
 *
 * 服务器 URL 默认指向本地 mock（端口 7788），生产环境可改为真实地址。
 */

import { app } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface TemplateMeta {
  id: string;
  name: string;
  category: string;
  pageCount: number;
  style: string;
  description: string;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
  size: number;
  updatedAt: string;
}

export interface TemplateIndex {
  version: string;
  updatedAt: string;
  /** 当前页条目数 */
  templates: TemplateMeta[];
  /** 分页字段（可选，老版不带） */
  total?: number;
  page?: number;
  pageSize?: number;
  categories?: string[];
}

export interface FetchIndexOptions {
  page?: number;
  pageSize?: number;
  category?: string;
  keyword?: string;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  ratio: number;
}

export interface DownloadResult {
  success: boolean;
  path?: string;
  error?: string;
  fromCache?: boolean;
}

/** 默认云端模板服务器地址（生产） */
const DEFAULT_BASE_URL = 'https://ai.cnkes.cn/ppt-templates';

export class PptTemplateClient {
  private baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  /** 拉取索引（支持分页/筛选） */
  async fetchIndex(opts: FetchIndexOptions = {}): Promise<TemplateIndex> {
    const params = new URLSearchParams();
    if (opts.page) params.set('page', String(opts.page));
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
    if (opts.category) params.set('category', opts.category);
    if (opts.keyword) params.set('keyword', opts.keyword);
    const qs = params.toString();
    const url = `${this.baseUrl}/api/templates${qs ? '?' + qs : ''}`;
    const r = await this.fetchWithTimeout(url);
    if (!r.ok) throw new Error(`拉取模板索引失败：HTTP ${r.status}`);
    return (await r.json()) as TemplateIndex;
  }

  /** 缓存目录：userData/templates/ */
  getCacheDir(): string {
    return path.join(app.getPath('userData'), 'templates');
  }

  /**
   * 模板 ID → 安全文件名
   *
   * 服务端 ID 可能是中文/括号/空格（如 "中国风格(01)"），直接做文件名会因
   * Windows 保留字符、超长路径、大小写不敏感碰撞而出问题，因此：
   * - 去除路径分隔符与 Windows 非法字符
   * - 追加短哈希，保证不同 ID 不会映射到同一文件
   */
  private safeFileName(id: string): string {
    const cleaned = id
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 80);
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    }
    const suffix = hash.toString(36);
    const base = cleaned || 'template';
    return `${base}-${suffix}.pptx`;
  }

  /** 单模板本地路径 */
  getCachedPath(id: string): string {
    return path.join(this.getCacheDir(), this.safeFileName(id));
  }

  /** 是否已缓存 */
  async isCached(id: string): Promise<boolean> {
    try {
      await fsp.access(this.getCachedPath(id));
      return true;
    } catch {
      return false;
    }
  }

  /** 下载模板（命中缓存直接返回） */
  async downloadTemplate(
    id: string,
    onProgress?: (p: DownloadProgress) => void,
  ): Promise<DownloadResult> {
    const cachePath = this.getCachedPath(id);
    if (await this.isCached(id)) {
      // 缓存命中：先报 0 再报 1，保证 UI 收到完整的开始→结束，
      // 不会因为「没有中间态」而一直卡在 loading
      onProgress?.({ downloaded: 0, total: 1, ratio: 0 });
      onProgress?.({ downloaded: 1, total: 1, ratio: 1 });
      return { success: true, path: cachePath, fromCache: true };
    }

    // ID 可能含中文/括号/空格，必须 percent-encode，否则服务器按原字节路由会 404/444
    const encodedId = encodeURIComponent(id);
    const url = `${this.baseUrl}/templates/${encodedId}.pptx`;
    let res: Response;
    try {
      // 模板可达几十 MB，8s 默认超时太短，这里放宽到 120s
      res = await this.fetchWithTimeout(url, 120000);
    } catch (e: any) {
      return { success: false, error: `无法连接模板服务器（${this.baseUrl}）：${e?.message || e}` };
    }
    if (!res.ok) {
      return { success: false, error: `下载失败：HTTP ${res.status}` };
    }

    const total = Number(res.headers.get('content-length') || 0);
    await fsp.mkdir(this.getCacheDir(), { recursive: true });

    // 先发一个 0 进度，让 UI 立刻进入「下载中」状态
    onProgress?.({ downloaded: 0, total, ratio: 0 });

    const reader = res.body?.getReader();

    if (!reader) {
      // 环境不支持流式读取：只能一次性拿完，进度就是 0 → 1
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(cachePath, buf);
      onProgress?.({ downloaded: buf.length, total: buf.length, ratio: 1 });
      return { success: true, path: cachePath };
    }

    const chunks: Uint8Array[] = [];
    let downloaded = 0;
    let lastRatio = 0;      // 上次上报的比例
    let lastEmitMs = 0;     // 上次上报的时间戳
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        downloaded += value.length;
        const now = Date.now();
        if (total > 0) {
          // 有总长度：按 1% 或 100ms 节流，避免高频 IPC 洪泛
          const ratio = downloaded / total;
          if (ratio - lastRatio >= 0.01 || now - lastEmitMs >= 100) {
            lastRatio = ratio;
            lastEmitMs = now;
            onProgress?.({ downloaded, total, ratio: Math.min(ratio, 1) });
          }
        } else if (now - lastEmitMs >= 200) {
          // 无 Content-Length（gzip/chunked）：按时间节流上报已下载字节数
          lastEmitMs = now;
          onProgress?.({ downloaded, total: 0, ratio: 0 });
        }
      }
    }
    const final = Buffer.concat(chunks);
    await fsp.writeFile(cachePath, final);
    onProgress?.({
      downloaded: total || final.length,
      total: total || final.length,
      ratio: 1,
    });
    return { success: true, path: cachePath };
  }

  /** 索引接口：返回所有模板（服务端默认全量，这里显式传大 pageSize 防御旧版本默认 12） */
  async listTemplatesViaApi(): Promise<TemplateIndex> {
    const url = `${this.baseUrl}/api/templates?pageSize=1000`;
    const r = await this.fetchWithTimeout(url, 15000);
    if (!r.ok) throw new Error(`拉取模板索引失败：HTTP ${r.status}`);
    return (await r.json()) as TemplateIndex;
  }

  private async fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
