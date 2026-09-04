/**
 * GrepTool - ripgrep 风格的高速文本搜索（W4）
 * 优先用 rg（ripgrep），回退到 Node 实现的简易 grep
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface GrepMatch {
  file: string;
  line: number;
  match: string;
  /** 上下文：match 行的前 1 行 + match + 后 1 行 */
  context?: string;
}

export interface GrepOptions {
  /** 搜索根目录（绝对路径） */
  path: string;
  /** 正则（ripgrep / JavaScript 正则语法） */
  pattern: string;
  /** 文件 glob 过滤，如 '*.ts'，可多个 */
  glob?: string[];
  /** 不区分大小写，默认 false */
  ignoreCase?: boolean;
  /** 最大结果数，默认 200 */
  maxResults?: number;
  /** 是否包含隐藏文件（.git 仍默认排除） */
  hidden?: boolean;
}

const MAX_RESULTS_DEFAULT = 200;
const RG_TIMEOUT_MS = 30_000;

let rgAvailableCache: boolean | null = null;

/** 探测系统是否安装 rg */
export async function isRipgrepAvailable(): Promise<boolean> {
  if (rgAvailableCache !== null) return rgAvailableCache;
  try {
    await execFileAsync('rg', ['--version'], { timeout: 3000, windowsHide: true });
    rgAvailableCache = true;
  } catch {
    rgAvailableCache = false;
  }
  return rgAvailableCache;
}

/** ripgrep 路径主入口 */
export async function grep(opts: GrepOptions): Promise<{ success: boolean; matches?: GrepMatch[]; engine?: 'rg' | 'node'; error?: string }> {
  if (!opts.path) return { success: false, error: 'path 必填' };
  if (!opts.pattern) return { success: false, error: 'pattern 必填' };

  const useRg = await isRipgrepAvailable();
  if (useRg) {
    return await grepWithRg(opts);
  }
  return await grepWithNode(opts);
}

async function grepWithRg(opts: GrepOptions): Promise<{ success: boolean; matches?: GrepMatch[]; engine?: 'rg' | 'node'; error?: string }> {
  try {
    const max = opts.maxResults ?? MAX_RESULTS_DEFAULT;
    const args: string[] = [
      '--no-heading',
      '--line-number',
      '--no-messages',
      '-e', opts.pattern,
    ];
    if (opts.ignoreCase) args.push('-i');
    if (opts.hidden) args.push('--hidden');
    args.push('--glob', '!.git');
    for (const g of opts.glob || []) {
      args.push('--glob', g);
    }
    args.push('-n', opts.path);

    const { stdout } = await execFileAsync('rg', args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: RG_TIMEOUT_MS,
      windowsHide: true,
    });
    const lines = stdout.split('\n').filter(Boolean);
    const matches: GrepMatch[] = lines.slice(0, max).map((l) => {
      // rg 输出: path:line:match
      const idx = l.indexOf(':');
      const idx2 = l.indexOf(':', idx + 1);
      if (idx < 0 || idx2 < 0) return { file: l, line: 0, match: l };
      return {
        file: l.slice(0, idx),
        line: parseInt(l.slice(idx + 1, idx2), 10) || 0,
        match: l.slice(idx2 + 1),
      };
    });
    return { success: true, matches, engine: 'rg' };
  } catch (err: any) {
    // rg 退出码 1 = 没找到，不是错误
    if (err?.code === 1 || /exited with code 1/.test(String(err?.message))) {
      return { success: true, matches: [], engine: 'rg' };
    }
    return { success: false, error: err?.message || String(err) };
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.cache']);

/** 简易 Node 兜底（不支持正则扩展语法，但满足基本搜索） */
async function grepWithNode(opts: GrepOptions): Promise<{ success: boolean; matches?: GrepMatch[]; engine?: 'rg' | 'node'; error?: string }> {
  try {
    const max = opts.maxResults ?? MAX_RESULTS_DEFAULT;
    const re = new RegExp(opts.pattern, opts.ignoreCase ? 'i' : '');
    const globRegexes = (opts.glob || []).map((g) => globToRegex(g));
    const matches: GrepMatch[] = [];

    async function walk(dir: string): Promise<void> {
      if (matches.length >= max) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= max) return;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          if (!opts.hidden && e.name.startsWith('.')) continue;
          await walk(path.join(dir, e.name));
        } else if (e.isFile()) {
          if (!opts.hidden && e.name.startsWith('.')) continue;
          if (globRegexes.length > 0 && !globRegexes.some((r) => r.test(e.name))) continue;
          await searchFile(path.join(dir, e.name));
        }
      }
    }

    async function searchFile(file: string): Promise<void> {
      let content: string;
      try {
        const stat = await fs.stat(file);
        if (stat.size > 5 * 1024 * 1024) return; // > 5MB 跳过
        content = await fs.readFile(file, 'utf-8');
      } catch {
        return;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= max) return;
        if (re.test(lines[i])) {
          matches.push({
            file,
            line: i + 1,
            match: lines[i].slice(0, 500),
          });
        }
      }
    }

    const stat = await fs.stat(opts.path);
    if (stat.isDirectory()) {
      await walk(opts.path);
    } else if (stat.isFile()) {
      await searchFile(opts.path);
    }
    return { success: true, matches, engine: 'node' };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

function globToRegex(glob: string): RegExp {
  // 简易 glob → 正则：* 任意字符，? 单字符
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${re}$`);
}
