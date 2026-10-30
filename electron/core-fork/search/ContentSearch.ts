/**
 * ContentSearch —— 工作区全文搜索（Ctrl+Shift+F）
 *
 * 为什么不直接用已有的 `fsAdapter.searchFiles`：
 *   1. 它把 pattern 当**正则**，用户搜 `foo(` 会直接抛语法错；
 *   2. 它按 `:` 切分 rg 输出，Windows 路径 `C:\a\b.ts:12:3:...` 会被切碎；
 *   3. 无二进制/大文件/目录黑名单保护，搜一次 node_modules 就能卡住整个主进程；
 *   4. 命中上限写死 100、且 rg 缺失时行为不一致（大小写敏感 vs 不敏感）。
 * 所以这里给编辑器用的全局搜索单独实现一套，`search_files` 工具保持原样（那是给模型用的）。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ContentMatch {
  /** 绝对路径 */
  file: string;
  /** 相对工作区路径（统一用 / 分隔，UI 直接展示） */
  relativePath: string;
  /** 1 起 */
  line: number;
  /** 1 起 */
  column: number;
  /** 该行内容（已去掉行尾空白，过长会截断） */
  text: string;
}

export interface ContentSearchOptions {
  /** 默认 false（编辑器里搜索默认不区分大小写） */
  caseSensitive?: boolean;
  /** query 按正则解释；默认 false = 字面量 */
  regex?: boolean;
  /** 全词匹配（仅对字面量模式有意义） */
  wholeWord?: boolean;
  /** 命中上限，默认 200 */
  maxResults?: number;
  /** 单文件大小上限（字节），默认 1MB */
  maxFileSize?: number;
  /** 总耗时预算（毫秒），默认 8000 */
  maxDurationMs?: number;
  /** 递归深度上限，默认 15 */
  maxDepth?: number;
}

export interface ContentSearchResult {
  matches: ContentMatch[];
  /** 扫描了多少个文件（用于告诉用户"搜过了，确实没有"） */
  filesScanned: number;
  /** 命中了上限被截断 */
  truncated: boolean;
  /** 因体积过大跳过的文件数 */
  skippedLarge: number;
  /** 超时提前结束 */
  timedOut: boolean;
  error?: string;
}

/** 重目录：进这些目录搜一次要几十秒，且结果几乎全是噪音 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', '__pycache__', '.venv',
  'venv', 'target', '.idea', '.gradle', '.mypy_cache', '.pytest_cache',
]);

const MAX_LINE_TEXT = 400;

export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name.toLowerCase());
}

/** 前 8KB 出现 NUL 基本可判定为二进制（图片/压缩包/编译产物） */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构造匹配器。
 *
 * 字面量模式下必须转义：用户搜 `a.b(` 是很常见的（写代码时随手复制），
 * 当正则处理会抛 "Invalid regular expression" 或匹配到别的东西。
 * 返回 null 表示 query 为空或正则非法，调用方据此提示。
 */
export function buildMatcher(query: string, opts: ContentSearchOptions = {}): RegExp | null {
  const q = (query || '').trim();
  if (!q) return null;

  let pattern = opts.regex ? q : escapeRegExp(q);
  if (opts.wholeWord) pattern = `\\b(?:${pattern})\\b`;

  try {
    // 'g' 用于逐行找出所有命中列；'m' 对单行无影响但保留以便未来整文件匹配
    return new RegExp(pattern, opts.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * 在工作区里搜内容。
 *
 * 顺序遍历 + 三重预算（命中数 / 总耗时 / 单文件大小），保证最坏情况下也能返回：
 * 用户要的是"搜索结果"，不是"卡住不动"。
 */
export async function searchContent(
  rootPath: string,
  query: string,
  opts: ContentSearchOptions = {},
): Promise<ContentSearchResult> {
  const empty: ContentSearchResult = {
    matches: [],
    filesScanned: 0,
    truncated: false,
    skippedLarge: 0,
    timedOut: false,
  };

  const root = (rootPath || '').trim();
  if (!root) return { ...empty, error: '未打开工作区' };

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return { ...empty, error: '工作区目录不存在' };
  }
  if (!rootStat.isDirectory()) return { ...empty, error: '工作区不是文件夹' };

  const re = buildMatcher(query, opts);
  if (!re) return { ...empty, error: '请输入搜索内容' };

  const maxResults = opts.maxResults ?? 200;
  const maxFileSize = opts.maxFileSize ?? 1024 * 1024;
  const maxDurationMs = opts.maxDurationMs ?? 8000;
  const maxDepth = opts.maxDepth ?? 15;
  const deadline = Date.now() + maxDurationMs;

  const matches: ContentMatch[] = [];
  let filesScanned = 0;
  let skippedLarge = 0;
  let timedOut = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (matches.length >= maxResults || timedOut) return;
    if (depth > maxDepth) return;
    if (Date.now() > deadline) {
      timedOut = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 权限不足 / 目录被删：静默跳过，不影响其他分支
    }

    for (const entry of entries) {
      if (matches.length >= maxResults || timedOut) return;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (stat.size > maxFileSize) {
        skippedLarge++;
        continue;
      }

      let buf: Buffer;
      try {
        buf = await fs.promises.readFile(full);
      } catch {
        continue;
      }
      filesScanned++;
      if (looksBinary(buf)) continue;

      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxResults) break;
        const text = lines[i];
        // 每行都要重置 lastIndex：正则带 g，否则上一行的位置会影响这一行
        re.lastIndex = 0;
        let m = re.exec(text);
        while (m) {
          if (m[0].length === 0) break; // 空匹配（如 `a*`）会死循环
          matches.push({
            file: full,
            relativePath: toPosix(path.relative(root, full)),
            line: i + 1,
            column: m.index + 1,
            text: text.replace(/\r$/, '').trim().slice(0, MAX_LINE_TEXT),
          });
          if (matches.length >= maxResults) break;
          m = re.exec(text);
        }
      }
    }
  };

  await walk(root, 0);

  return {
    matches,
    filesScanned,
    truncated: matches.length >= maxResults,
    skippedLarge,
    timedOut,
  };
}
