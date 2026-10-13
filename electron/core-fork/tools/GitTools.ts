/**
 * GitTools - Git 操作封装（W4）
 * 提供 status / diff / commit / log
 * 全部走 git 子进程，cwd 必须是 git 仓库
 */

import { promisify } from 'node:util';
import { execFileSafe } from '../util/SafeSpawn';

const execFileAsync = promisify(execFileSafe as any) as (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

const GIT_TIMEOUT_MS = 30_000;
const GIT_DIFF_MAX_BYTES = 500_000; // 500KB 上限

export interface GitStatus {
  branch: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface GitCommitResult {
  success: boolean;
  hash?: string;
  message?: string;
  error?: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

async function git(args: string[], cwd: string, maxBuffer: number = 10 * 1024 * 1024): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    maxBuffer,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** 探测目录是否是 git 仓库（HEAD 存在即视为是） */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

/** git status（结构化输出） */
export async function gitStatus(cwd: string): Promise<{ success: boolean; status?: GitStatus; error?: string }> {
  try {
    const isRepo = await isGitRepo(cwd);
    if (!isRepo) return { success: false, error: '当前目录不是 git 仓库' };

    const [branchResp, porcelainResp] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      git(['status', '--porcelain=v1', '-uall'], cwd),
    ]);
    const branch = branchResp.stdout.trim() || 'HEAD';
    const lines = porcelainResp.stdout.split('\n').filter((l) => l.length >= 2);

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];
    for (const line of lines) {
      const x = line[0];
      const y = line[1];
      const file = line.slice(3).trim();
      if (x === '?' && y === '?') {
        untracked.push(file);
        continue;
      }
      if (x !== ' ' && x !== '?') staged.push(`${x} ${file}`);
      if (y !== ' ' && y !== '?') unstaged.push(`${y} ${file}`);
    }
    return {
      success: true,
      status: {
        branch,
        clean: lines.length === 0,
        staged,
        unstaged,
        untracked,
      },
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** git diff（未暂存 + 暂存 vs HEAD） */
export async function gitDiff(cwd: string, staged: boolean = false): Promise<{ success: boolean; diff?: string; truncated?: boolean; error?: string }> {
  try {
    const isRepo = await isGitRepo(cwd);
    if (!isRepo) return { success: false, error: '当前目录不是 git 仓库' };
    const args = staged ? ['diff', '--cached', '--no-color'] : ['diff', '--no-color'];
    const { stdout } = await git(args, cwd, GIT_DIFF_MAX_BYTES + 1024);
    const truncated = stdout.length > GIT_DIFF_MAX_BYTES;
    return {
      success: true,
      diff: truncated ? stdout.slice(0, GIT_DIFF_MAX_BYTES) : stdout,
      truncated,
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** git commit（带 message，可选 addAll） */
export async function gitCommit(
  cwd: string,
  message: string,
  options: { addAll?: boolean; author?: string } = {}
): Promise<GitCommitResult> {
  if (!message || !message.trim()) {
    return { success: false, error: 'commit message 不能为空' };
  }
  try {
    const isRepo = await isGitRepo(cwd);
    if (!isRepo) return { success: false, error: '当前目录不是 git 仓库' };

    if (options.addAll) {
      await git(['add', '-A'], cwd);
    }

    const args = ['commit', '-m', message];
    if (options.author) {
      args.push('--author', options.author);
    }
    await git(args, cwd);

    // 拿到刚刚的 commit hash
    const { stdout: hashOut } = await git(['rev-parse', 'HEAD'], cwd);
    return {
      success: true,
      hash: hashOut.trim(),
      message: message.trim(),
    };
  } catch (err: any) {
    const stderr = err?.stderr || err?.message || String(err);
    return { success: false, error: stderr };
  }
}

/** git log（最近 n 条） */
export async function gitLog(
  cwd: string,
  options: { limit?: number; branch?: string } = {}
): Promise<{ success: boolean; entries?: GitLogEntry[]; error?: string }> {
  try {
    const isRepo = await isGitRepo(cwd);
    if (!isRepo) return { success: false, error: '当前目录不是 git 仓库' };

    const limit = options.limit ?? 10;
    const branch = options.branch ? options.branch : 'HEAD';
    const sep = '<<GIT_LOG_SEP>>';
    const fmt = `%H${sep}%h${sep}%an${sep}%ai${sep}%s`;
    const { stdout } = await git(['log', `-n`, String(limit), branch, `--pretty=format:${fmt}`], cwd);
    const lines = stdout.split('\n').filter((l) => l.includes(sep));
    const entries: GitLogEntry[] = lines.map((line) => {
      const [hash, shortHash, author, date, subject] = line.split(sep);
      return { hash, shortHash, author, date, subject };
    });
    return { success: true, entries };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
