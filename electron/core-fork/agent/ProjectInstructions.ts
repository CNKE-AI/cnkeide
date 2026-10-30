/**
 * 仓库级指令文件（AGENTS.md / CNKE.md）
 *
 * 目标：让模型遵守「这个仓库自己的规矩」——命名风格、目录约束、构建/测试命令、
 * 禁止改动的地方等。此前这些约定只能塞进全局 systemPrompt（对所有工作区生效）
 * 或本地记忆（零散、需手动管理），换个仓库就得重写一遍。
 *
 * 本模块按目录层级扫描指令文件（浅层优先，深层覆盖浅层的写法），拼装成一段
 * 带来源标注的提示块，由 AgentManager 在每轮 run 时注入 systemPrompt。
 *
 * 设计要点：
 * - 纯读、绝不执行：只读固定文件名的 Markdown，不做任何脚本求值；
 * - 有硬上限：单文件 12KB、总量默认 24KB，超出即截断并显式告知模型被截断；
 * - 跳过重目录：node_modules/.git/dist 等不进（否则一次扫描就是几万个 stat）；
 * - 扫描结果带 TTL 缓存：连续对话时不必每条消息都重扫磁盘。
 */

import { promises as fsp } from 'fs';
import * as path from 'path';

/** 默认识别的指令文件名（顺序即同一目录内的优先级） */
export const DEFAULT_INSTRUCTION_FILES = ['AGENTS.md', 'CNKE.md'];

/** 扫描时整体跳过的目录名（大小写不敏感比较） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.gradle', '.mvn',
  'dist', 'dist-electron', 'out', 'build', 'build_srv', 'release', 'target',
  'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '__pycache__',
  'venv', '.venv', 'env', 'vendor', 'Pods', '.pnpm-store', '.yarn', '.parcel-cache',
]);

/** 单文件默认字节上限 */
export const DEFAULT_MAX_BYTES_PER_FILE = 12000;
/** 注入总量默认字节上限 */
export const DEFAULT_MAX_TOTAL_BYTES = 24000;
/** 默认扫描深度（根为 0，即最多看 root/a/b 这一层） */
export const DEFAULT_MAX_DEPTH = 3;
/** 剩余预算低于此值时整份跳过（不注入残缺约定） */
const MIN_SLICE_BYTES = 200;

export interface InstructionFileInfo {
  /** 绝对路径 */
  path: string;
  /** 相对工作区根目录的路径（统一用 / 分隔，便于跨平台显示） */
  relPath: string;
  /** 原始字节数 */
  bytes: number;
  /** 是否因超过单文件上限被截断 */
  truncated: boolean;
  /** 相对根目录的层级深度，根目录文件为 0 */
  depth: number;
}

export interface SkippedInstruction {
  path: string;
  relPath: string;
  reason: string;
}

export interface ProjectInstructionsResult {
  root: string;
  files: InstructionFileInfo[];
  skipped: SkippedInstruction[];
  /** 实际注入内容的总字节数（截断后） */
  totalBytes: number;
  /** 直接拼到 systemPrompt 的提示块；没有命中任何指令文件时为空串 */
  block: string;
}

export interface LoadInstructionsOptions {
  /** 工作区根目录（绝对路径） */
  root: string;
  /** 识别哪些文件名，默认 AGENTS.md / CNKE.md */
  fileNames?: string[];
  /** 扫描深度，默认 3 */
  maxDepth?: number;
  /** 单文件字节上限，默认 12000 */
  maxBytesPerFile?: number;
  /** 总量字节上限，默认 24000 */
  maxTotalBytes?: number;
  /** 是否使用扫描缓存（默认 true；用户手动刷新时传 false） */
  useCache?: boolean;
}

interface ScanEntry {
  path: string;
  relPath: string;
  depth: number;
}

interface CacheEntry {
  at: number;
  entries: ScanEntry[];
}

/** 扫描缓存：key = root + 文件名集合 + 深度 */
const scanCache = new Map<string, CacheEntry>();
const SCAN_TTL_MS = 15000;

/** 清空扫描缓存（手动刷新/切换工作区时可调，测试也用得到） */
export function invalidateInstructionCache(): void {
  scanCache.clear();
}

/** 去掉 UTF-8 BOM，避免注入文本以 \uFEFF 开头被模型当成乱码 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 按字节截断（不切断多字节字符）。
 * 返回截断后的字符串与「是否真的截断了」。
 */
export function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text, truncated: false };
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  // toString 遇到不完整的字符序列会替换成 U+FFFD，这里退一个字符位避免尾部出现乱码
  let cut = maxBytes;
  let sliced = buf.subarray(0, cut).toString('utf-8');
  if (sliced.endsWith('\uFFFD')) {
    cut -= 1;
    sliced = buf.subarray(0, cut).toString('utf-8');
  }
  return { text: sliced, truncated: true };
}

function normalizeOptions(opts: LoadInstructionsOptions) {
  const fileNames = (opts.fileNames && opts.fileNames.length ? opts.fileNames : DEFAULT_INSTRUCTION_FILES)
    .map((n) => n.trim())
    .filter(Boolean);
  const maxDepth = clampInt(opts.maxDepth, 0, 6, DEFAULT_MAX_DEPTH);
  const maxBytesPerFile = clampInt(opts.maxBytesPerFile, 512, 200000, DEFAULT_MAX_BYTES_PER_FILE);
  const maxTotalBytes = clampInt(opts.maxTotalBytes, 1024, 200000, DEFAULT_MAX_TOTAL_BYTES);
  return { fileNames, maxDepth, maxBytesPerFile, maxTotalBytes };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 广度优先扫描指令文件，结果按「深度升序、同级按文件名顺序」排列，
 * 因此浅层（通用约束）在前、深层（局部覆盖）在后，符合「后写的更具体」的直觉。
 */
export async function scanInstructionFiles(opts: LoadInstructionsOptions): Promise<ScanEntry[]> {
  const { fileNames, maxDepth } = normalizeOptions(opts);
  const root = path.resolve(opts.root);
  const cacheKey = `${root}::${fileNames.join(',')}::${maxDepth}`;
  const useCache = opts.useCache !== false;
  if (useCache) {
    const hit = scanCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.entries;
  }

  const found: ScanEntry[] = [];
  let level: string[] = [root];

  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: import('fs').Dirent[] = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // 无权限/已删除目录直接跳过，不影响其它层级
      }
      // 本层目录内的指令文件（按 fileNames 顺序保证确定性）
      for (const name of fileNames) {
        const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === name.toLowerCase());
        if (!hit) continue;
        const abs = path.join(dir, hit.name);
        found.push({
          path: abs,
          relPath: toRelPath(root, abs),
          depth,
        });
      }
      if (depth === maxDepth) continue;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        next.push(path.join(dir, entry.name));
      }
    }
    level = next.sort();
  }

  if (useCache) scanCache.set(cacheKey, { at: Date.now(), entries: found });
  return found;
}

function toRelPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}

/**
 * 把已读取的指令文件拼接成 systemPrompt 提示块（纯函数，便于单测）。
 * 未命中任何文件时返回空串——调用方据此跳过注入，不会平白多花 token。
 */
export function buildInstructionBlock(
  entries: { relPath: string; content: string; truncated?: boolean; depth?: number }[]
): string {
  if (!entries.length) return '';
  const parts: string[] = [
    '',
    '',
    '[项目指令] 下面是本仓库维护者写在指令文件里的约定，对本次任务具有强制力：',
    '- 效力顺序：用户本轮的明确要求 > 项目指令 > 你的通用习惯；两者冲突时先指出冲突再询问，不要静默取舍。',
    '- 动手前先核对：命名风格、目录放置、构建/测试命令、禁止改动范围、提交信息格式等。',
    '- 项目指令与任务无关的部分忽略即可，不要为了"遵守"而做多余改动。',
  ];
  for (const entry of entries) {
    const depth = entry.depth ?? 0;
    const where = depth === 0 ? '仓库根目录' : relDirLabel(entry.relPath);
    parts.push('');
    parts.push(`<<< ${entry.relPath} · ${where} >>>`);
    if (entry.truncated) {
      parts.push('（该文件内容超长，只注入了前一部分；需要其余内容请用 read_file 读取原文件）');
    }
    parts.push(entry.content.trim());
    parts.push(`<<< /${entry.relPath} >>>`);
  }
  return parts.join('\n');
}

function relDirLabel(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx > 0 ? `目录 ${relPath.slice(0, idx)}/` : '子目录';
}

/**
 * 读取并拼装工作区的项目指令。
 * 任何 IO 异常都被吞掉并记入 skipped —— 指令文件读不出来绝不能让对话失败。
 */
export async function loadProjectInstructions(opts: LoadInstructionsOptions): Promise<ProjectInstructionsResult> {
  const { maxBytesPerFile, maxTotalBytes } = normalizeOptions(opts);
  const root = typeof opts.root === 'string' ? opts.root.trim() : '';
  const empty: ProjectInstructionsResult = { root, files: [], skipped: [], totalBytes: 0, block: '' };
  if (!root) return empty;

  let entries: ScanEntry[] = [];
  try {
    entries = await scanInstructionFiles({ ...opts, root });
  } catch {
    return empty;
  }
  if (!entries.length) return empty;

  const files: InstructionFileInfo[] = [];
  const skipped: SkippedInstruction[] = [];
  const picked: { relPath: string; content: string; truncated: boolean; depth: number }[] = [];
  let usedBytes = 0;

  for (const entry of entries) {
    let raw: Buffer;
    try {
      raw = await fsp.readFile(entry.path);
    } catch (err: any) {
      skipped.push({ path: entry.path, relPath: entry.relPath, reason: `读取失败：${err?.message || err}` });
      continue;
    }
    const bytes = raw.length;
    if (bytes === 0) {
      skipped.push({ path: entry.path, relPath: entry.relPath, reason: '文件为空' });
      continue;
    }
    const remaining = maxTotalBytes - usedBytes;
    // 剩余预算连一小段都不够时直接跳过：注入半句话的不完整约定比不注入更危险
    if (remaining < MIN_SLICE_BYTES) {
      skipped.push({ path: entry.path, relPath: entry.relPath, reason: `超出总量上限 ${maxTotalBytes} 字节` });
      continue;
    }
    // 单文件上限与剩余总量取小，保证总注入量可控
    const cap = Math.min(maxBytesPerFile, remaining);
    const { text, truncated } = truncateToBytes(stripBom(raw.toString('utf-8')), cap);
    const content = text.trim();
    if (!content) {
      skipped.push({ path: entry.path, relPath: entry.relPath, reason: '内容为空' });
      continue;
    }
    usedBytes += Buffer.byteLength(content, 'utf-8');
    picked.push({ relPath: entry.relPath, content, truncated, depth: entry.depth });
    files.push({ path: entry.path, relPath: entry.relPath, bytes, truncated, depth: entry.depth });
  }

  return {
    root,
    files,
    skipped,
    totalBytes: usedBytes,
    block: buildInstructionBlock(picked),
  };
}

/** 新建指令文件用的模板（足够具体又不啰嗦，用户改起来有抓手） */
export const INSTRUCTION_TEMPLATE = `# 项目约定

> 本文件由 CnkeIDE 生成，AI 会在每次对话时自动读取它（含子目录下的同名文件）。
> 只写"这个仓库特有的规矩"，通用的编程常识不用写。

## 技术栈与结构
- 语言 / 框架：
- 主要目录：
  - \`src/\` —
  - \`tests/\` —

## 常用命令
- 安装依赖：
- 本地启动：
- 构建：
- 测试：
- 代码检查 / 格式化：

## 代码约定
- 命名：
- 注释语言：
- 新增文件放哪里：

## 不要做的事
- 不要改动的目录 / 文件：
- 不要引入的依赖：
- 不要使用的命令：
`;

/**
 * 在工作区根目录生成 AGENTS.md 模板。
 * 已存在时**不覆盖**（用户的约定比模板重要），返回 created=false 让 UI 提示改为「打开」。
 */
export async function createInstructionTemplate(
  root: string,
  fileName: string = DEFAULT_INSTRUCTION_FILES[0]
): Promise<{ success: boolean; path?: string; created?: boolean; error?: string }> {
  const dir = typeof root === 'string' ? root.trim() : '';
  if (!dir) return { success: false, error: '未打开工作区' };
  const name = (fileName || DEFAULT_INSTRUCTION_FILES[0]).trim();
  if (!name || name.includes('/') || name.includes('\\')) {
    return { success: false, error: '文件名不合法' };
  }
  const target = path.join(dir, name);
  try {
    const stat = await fsp.stat(target).catch(() => null);
    if (stat?.isFile()) return { success: true, path: target, created: false };
    await fsp.writeFile(target, INSTRUCTION_TEMPLATE, 'utf-8');
    invalidateInstructionCache();
    return { success: true, path: target, created: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
