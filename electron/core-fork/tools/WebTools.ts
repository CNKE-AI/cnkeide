/**
 * WebTools - 联网搜索与页面抓取（W4）
 *
 * web_search: 多引擎降级搜索（DuckDuckGo HTML → Bing），无需 API keys，国内可访问
 * web_fetch: 走 fetch + 简单 HTML→文本提取
 *
 * 优化点：
 * - 多引擎自动降级（DuckDuckGo 失败/空结果时切换 Bing）
 * - 内置结果缓存（TTL 5 分钟，避免重复请求）
 * - 网络抖动自动重试（最多 2 次，指数退避）
 * - 更强的 HTML 解析（兼容 DuckDuckGo/Bing 不同结构）
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebFetchResult {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FETCH_MAX_BYTES = 200_000; // 200KB
const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_MAX_RESULTS = 8;
const SEARCH_TIMEOUT_MS = 12_000;
const SEARCH_RETRY = 2;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

/** 结果缓存：query → { at, results } */
const searchCache = new Map<string, { at: number; results: WebSearchResult[] }>();
const CACHE_MAX_ENTRIES = 100;

function cacheGet(query: string): WebSearchResult[] | null {
  const hit = searchCache.get(query);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    searchCache.delete(query);
    return null;
  }
  return hit.results;
}

function cacheSet(query: string, results: WebSearchResult[]): void {
  if (searchCache.size >= CACHE_MAX_ENTRIES) {
    // 淘汰最旧的一条
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
  searchCache.set(query, { at: Date.now(), results });
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  if (signal) return signal;
  return AbortSignal.timeout(ms);
}

/** 指数退避 sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 联网搜索：DuckDuckGo → Bing 降级
 * 返回前 N 条结果的 title/url/snippet
 */
export async function webSearch(
  query: string,
  options: { maxResults?: number; signal?: AbortSignal } = {}
): Promise<{ success: boolean; results?: WebSearchResult[]; error?: string }> {
  const max = options.maxResults ?? SEARCH_MAX_RESULTS;
  if (!query || !query.trim()) {
    return { success: false, error: 'query 不能为空' };
  }
  const q = query.trim();

  // 命中缓存直接返回
  const cached = cacheGet(q);
  if (cached) {
    return { success: true, results: cached.slice(0, max) };
  }

  // 引擎顺序：Bing 优先（国内可直连，DuckDuckGo 在国内常被墙导致连接超时）
  // 失败/空结果再降级 DuckDuckGo
  const engines: Array<() => Promise<WebSearchResult[]>> = [
    () => searchBing(q, max, options.signal),
    () => searchDuckDuckGo(q, max, options.signal),
  ];

  let lastError = '';
  for (const engine of engines) {
    try {
      const results = await engine();
      if (results.length > 0) {
        cacheSet(q, results);
        return { success: true, results: results.slice(0, max) };
      }
    } catch (err: any) {
      lastError = err?.message || String(err);
    }
  }

  if (lastError) {
    return { success: false, error: lastError };
  }
  return { success: true, results: [] };
}

/** DuckDuckGo HTML 搜索（带重试） */
async function searchDuckDuckGo(query: string, max: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
  for (let attempt = 0; attempt <= SEARCH_RETRY; attempt++) {
    try {
      const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
        },
        // DuckDuckGo 国内常被墙导致连接超时，单独用更短超时避免拖慢降级
        signal: withTimeout(signal, 5000),
      });
      if (!resp.ok) {
        throw new Error(`DuckDuckGo 返回 ${resp.status}`);
      }
      const html = await resp.text();
      const results = parseDuckDuckGoHtml(html, max);
      // 检测验证码/拦截页：有 HTML 但无结果时视为引擎失败，触发降级
      if (results.length === 0 && /(anomaly|captcha|challenge)/i.test(html)) {
        throw new Error('DuckDuckGo 触发反爬拦截');
      }
      return results;
    } catch (err: any) {
      // 用户主动取消则不重试
      if (signal?.aborted) throw err;
      if (attempt === SEARCH_RETRY) throw err;
      await sleep(400 * Math.pow(2, attempt));
    }
  }
  return [];
}

/** Bing 搜索（降级引擎） */
async function searchBing(query: string, max: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query);
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Bing 返回 ${resp.status}`);
  }
  const html = await resp.text();
  return parseBingHtml(html, max);
}

/**
 * DuckDuckGo HTML 解析（不引入 cheerio）
 * - 兼容两种结构：result__a / result__snippet，以及新版的 result__body
 */
function parseDuckDuckGoHtml(html: string, max: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // 结构 A：<a class="result__a">title</a> ... <a class="result__snippet">snippet</a>
  const blockA = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,2500}?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockA.exec(html)) !== null) {
    if (results.length >= max) break;
    const href = decodeHtmlEntities(m[1]);
    const title = stripHtml(m[2]).trim();
    const snippet = stripHtml(m[3]).trim();
    if (!isValidResultUrl(href)) continue;
    if (!title) continue;
    results.push({ title, url: href, snippet });
  }

  // 结构 B：新版 DuckDuckGo 用 result__body 包裹
  if (results.length === 0) {
    const blockB = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const links: Array<{ href: string; title: string }> = [];
    while ((m = blockB.exec(html)) !== null) {
      const href = decodeHtmlEntities(m[1]);
      const title = stripHtml(m[2]).trim();
      if (isValidResultUrl(href) && title) links.push({ href, title });
    }
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets: string[] = [];
    while ((m = snippetRe.exec(html)) !== null) {
      snippets.push(stripHtml(m[1]).trim());
    }
    links.slice(0, max).forEach((l, i) => {
      results.push({ title: l.title, url: l.href, snippet: snippets[i] || '' });
    });
  }

  return results;
}

/** Bing HTML 解析 */
function parseBingHtml(html: string, max: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Bing 结果：<li class="b_algo"><h2><a href="...">title</a></h2><p>snippet</p></li>
  const blockRe = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    if (results.length >= max) break;
    const href = decodeHtmlEntities(m[1]);
    const title = stripHtml(m[2]).trim();
    const snippet = stripHtml(m[3]).trim();
    if (!isValidResultUrl(href)) continue;
    if (!title) continue;
    results.push({ title, url: href, snippet });
  }
  return results;
}

/** 结果 URL 校验：过滤掉搜索引擎自身链接与广告 */
function isValidResultUrl(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  if (/duckduckgo\.com|bing\.com|microsoft\.com\/search|msn\.com/i.test(href)) return false;
  return true;
}

/** 抓取 URL 文本（HTML 简单转文本） */
export async function webFetch(
  url: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {}
): Promise<{ success: boolean; result?: WebFetchResult; error?: string }> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { success: false, error: 'url 必须是 http(s)://' };
  }
  const max = options.maxBytes ?? FETCH_MAX_BYTES;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'text/html,text/plain,application/json' },
      signal: options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    const ct = resp.headers.get('content-type') || '';
    const reader = resp.body?.getReader();
    if (!reader) return { success: false, error: '无法读取响应流' };

    const decoder = new TextDecoder('utf-8');
    let received = 0;
    let text = '';
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (received >= max) {
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
    try { reader.releaseLock(); } catch { /* ignore */ }

    // 简单 HTML→文本：去 script/style，再去标签
    if (ct.includes('html')) {
      text = htmlToText(text);
    }
    return {
      success: true,
      result: {
        url,
        status: resp.status,
        contentType: ct,
        text: text.trim(),
        truncated,
      },
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

function htmlToText(html: string): string {
  return html
    // 去 script/style/noscript
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    // 块级标签转换行
    .replace(/<\/?(div|p|br|h[1-6]|li|tr|td|th|article|section|header|footer|nav|main|aside)[^>]*>/gi, '\n')
    // 去其它标签
    .replace(/<[^>]+>/g, '')
    // 实体
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, '')
    // 多空行合并
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n');
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
