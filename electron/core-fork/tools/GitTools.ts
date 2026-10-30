/**
 * GitTools - Git 操作封装（W4）
 * 提供 status / diff / commit / log
 * 全部走 git 子进程，cwd 必须是 git 仓库
 */

import { promisify } from 'node:util';
import { execFileSafe } from '../util/SafeSpawn';

// promisify 对三回调值 (stdout, stderr) 的函数类型推断不足，必须显式标注返回类型
const execFileAsync = promisify(execFileSafe) as unknown as (
  file: string,
  args: string[],
  options?: Record<string, unknown>,
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

/* ============================================================================
 * W26：Git 写操作闭环（branch / checkout / fetch / pull / push）
 *
 * 三条设计原则：
 *  1. 参数绝不拼字符串进命令行：全部走 execFile 的 argv 数组，且 ref 名先过 isValidRefName
 *     （拒绝以 - 开头、含空白或 git 保留字符），避免 `git push --force` 这类注入。
 *  2. 默认安全：pull 只允许快进（--ff-only）、push 永不强推、不允许直推 main/master
 *     （要直推必须显式 allowProtected=true）。
 *  3. 失败必须回传 git 原生 stderr，模型才能自己看懂「被拒绝」的原因并换策略。
 * ========================================================================== */

export interface GitOpResult {
  success: boolean;
  output?: string;
  error?: string;
}

/** 受保护分支：默认禁止直接推送 */
export const PROTECTED_BRANCHES = ['main', 'master'];

/** 分支/引用名合法性校验（防注入 + 防非法 ref） */
export function isValidRefName(name: string): boolean {
  const n = String(name ?? '').trim();
  if (!n) return false;
  if (n.startsWith('-')) return false; // 防止被当成命令行选项
  if (/[\s~^:?*[\\\u0000-\u001f]/.test(n)) return false;
  if (n.includes('..') || n.includes('@{')) return false;
  if (n.endsWith('/') || n.endsWith('.') || n.endsWith('.lock')) return false;
  if (n.length > 200) return false;
  return true;
}

function gitErrorText(err: any): string {
  const stderr = err?.stderr ? String(err.stderr) : '';
  if (stderr.trim()) return stderr.trim();
  return err?.message ? String(err.message) : String(err);
}

/** 当前分支名（游离 HEAD 时返回 HEAD） */
export async function gitCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return stdout.trim() || 'HEAD';
}

/** 远程列表 */
export async function gitRemotes(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await git(['remote'], cwd);
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 与上游的领先/落后提交数；没有上游返回 null */
export async function gitAheadBehind(cwd: string): Promise<{ ahead: number; behind: number } | null> {
  try {
    const { stdout } = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], cwd);
    const [behind, ahead] = stdout
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10) || 0);
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return null;
  }
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
}

export interface GitBranchListResult {
  success: boolean;
  local?: GitBranchInfo[];
  remote?: GitBranchInfo[];
  current?: string;
  error?: string;
}

/**
 * 分支操作
 *  - list（默认）：本地 + 远程分支，标注当前分支与上游
 *  - create：新建分支，可用 from 指定起点、checkout 建完直接切过去
 *  - delete：删除分支，force=true 用 -D（丢弃未合并提交）
 *  - rename：重命名为 to
 */
export async function gitBranch(
  cwd: string,
  options: {
    action?: 'list' | 'create' | 'delete' | 'rename';
    name?: string;
    from?: string;
    to?: string;
    force?: boolean;
    checkout?: boolean;
  } = {}
): Promise<GitBranchListResult & GitOpResult> {
  const action = options.action || 'list';
  try {
    if (!(await isGitRepo(cwd))) return { success: false, error: '当前目录不是 git 仓库' };

    if (action === 'list') {
      const { stdout } = await git(['for-each-ref', '--format=%(refname:short)\t%(upstream:short)\t%(HEAD)', 'refs/heads'], cwd);
      const local: GitBranchInfo[] = stdout
        .split('\n')
        .filter((l) => l.trim())
        .map((line) => {
          const [name, upstream, head] = line.split('\t');
          return {
            name: name.trim(),
            current: (head || '').trim() === '*',
            remote: false,
            upstream: (upstream || '').trim() || undefined,
          };
        });
      let remote: GitBranchInfo[] = [];
      try {
        const r = await git(['branch', '-r', '--format=%(refname:short)'], cwd);
        remote = r.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s && !s.includes('->'))
          .map((name) => ({ name, current: false, remote: true }));
      } catch {
        // 没有远程时忽略
      }
      const current = local.find((b) => b.current)?.name;
      return { success: true, local, remote, current };
    }

    const name = String(options.name ?? '').trim();
    if (action === 'create') {
      if (!isValidRefName(name)) return { success: false, error: `非法分支名：${name}` };
      if (options.from && !isValidRefName(String(options.from))) {
        return { success: false, error: `非法起点引用：${options.from}` };
      }
      const exists = await branchExists(cwd, name);
      if (exists) return { success: false, error: `分支已存在：${name}（如需切换请直接用 git_checkout）` };
      const args = options.checkout ? ['checkout', '-b', name] : ['branch', name];
      if (options.from) args.push(String(options.from));
      const r = await git(args, cwd);
      const current = await gitCurrentBranch(cwd);
      return {
        success: true,
        output: options.checkout
          ? `已创建并切换到分支 ${name}（当前分支：${current}）`
          : `已创建分支 ${name}${options.from ? `（起点 ${options.from}）` : ''}\n${(r.stdout || r.stderr || '').trim()}`,
      };
    }

    if (action === 'delete') {
      if (!isValidRefName(name)) return { success: false, error: `非法分支名：${name}` };
      const current = await gitCurrentBranch(cwd);
      if (name === current) return { success: false, error: `不能删除当前所在分支 ${name}，请先切换到其它分支` };
      const r = await git(['branch', options.force ? '-D' : '-d', name], cwd);
      return { success: true, output: (r.stdout || r.stderr || `已删除分支 ${name}`).trim() };
    }

    if (action === 'rename') {
      const to = String(options.to ?? '').trim();
      if (!isValidRefName(name)) return { success: false, error: `非法分支名：${name}` };
      if (!isValidRefName(to)) return { success: false, error: `非法新分支名：${to}` };
      const r = await git(['branch', '-m', name, to], cwd);
      return { success: true, output: (r.stdout || r.stderr || `已重命名 ${name} -> ${to}`).trim() };
    }

    return { success: false, error: `未知 action：${action}` };
  } catch (err: any) {
    return { success: false, error: gitErrorText(err) };
  }
}

async function branchExists(cwd: string, name: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * 切换分支 / 创建并切换
 * force=true 会丢弃工作区改动（git checkout -f），默认禁止
 */
export async function gitCheckout(
  cwd: string,
  target: string,
  options: { create?: boolean; startPoint?: string; force?: boolean } = {}
): Promise<GitOpResult & { branch?: string }> {
  const name = String(target ?? '').trim();
  try {
    if (!(await isGitRepo(cwd))) return { success: false, error: '当前目录不是 git 仓库' };
    if (!isValidRefName(name)) return { success: false, error: `非法目标引用：${name}` };

    const args = ['checkout'];
    if (options.create) {
      args.push('-b', name);
      if (options.startPoint) {
        if (!isValidRefName(String(options.startPoint))) {
          return { success: false, error: `非法起点引用：${options.startPoint}` };
        }
        args.push(String(options.startPoint));
      }
    } else {
      if (options.force) args.push('-f');
      args.push(name);
    }

    const r = await git(args, cwd);
    const branch = await gitCurrentBranch(cwd);
    const extra = (r.stderr || '').trim();
    return {
      success: true,
      branch,
      output: `已切换到 ${branch}${options.create ? '（新建）' : ''}${extra ? `\n${extra}` : ''}`,
    };
  } catch (err: any) {
    return { success: false, error: gitErrorText(err) };
  }
}

/** git fetch：只更新远程引用，不动工作区 */
export async function gitFetch(
  cwd: string,
  options: { remote?: string; prune?: boolean } = {}
): Promise<GitOpResult> {
  try {
    if (!(await isGitRepo(cwd))) return { success: false, error: '当前目录不是 git 仓库' };
    const remotes = await gitRemotes(cwd);
    if (remotes.length === 0) return { success: false, error: '当前仓库没有配置任何远程（git remote 为空）' };

    const args = ['fetch'];
    if (options.prune !== false) args.push('--prune');
    if (options.remote) {
      if (!isValidRefName(String(options.remote))) return { success: false, error: `非法远程名：${options.remote}` };
      if (!remotes.includes(String(options.remote))) {
        return { success: false, error: `远程 ${options.remote} 不存在，可用：${remotes.join(', ')}` };
      }
      args.push(String(options.remote));
    } else if (!remotes.includes('origin')) {
      args.push('--all');
    } else {
      args.push('origin');
    }

    const r = await git(args, cwd);
    const text = `${(r.stdout || '').trim()}\n${(r.stderr || '').trim()}`.trim();
    return { success: true, output: text || '已是最新（无新引用）' };
  } catch (err: any) {
    return { success: false, error: gitErrorText(err) };
  }
}

/**
 * git pull：默认只允许快进（--ff-only），分叉时直接失败并提示，不替用户造 merge commit
 */
export async function gitPull(
  cwd: string,
  options: { remote?: string; branch?: string; rebase?: boolean } = {}
): Promise<GitOpResult & { branch?: string }> {
  try {
    if (!(await isGitRepo(cwd))) return { success: false, error: '当前目录不是 git 仓库' };
    const remotes = await gitRemotes(cwd);
    if (remotes.length === 0) return { success: false, error: '当前仓库没有配置任何远程（git remote 为空）' };

    const remote = String(options.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0])).trim();
    if (!remotes.includes(remote)) return { success: false, error: `远程 ${remote} 不存在，可用：${remotes.join(', ')}` };
    const branch = options.branch ? String(options.branch).trim() : '';
    if (branch && !isValidRefName(branch)) return { success: false, error: `非法分支名：${branch}` };

    const args = ['pull'];
    args.push(options.rebase ? '--rebase' : '--ff-only');
    args.push(remote);
    if (branch) args.push(branch);

    const r = await git(args, cwd);
    const current = await gitCurrentBranch(cwd);
    const text = `${(r.stdout || '').trim()}\n${(r.stderr || '').trim()}`.trim();
    return { success: true, branch: current, output: text || `已与 ${remote} 同步` };
  } catch (err: any) {
    const raw = gitErrorText(err);
    const hint = /fast-?forward|diverg|non-fast-forward/i.test(raw)
      ? '\n提示：本地与远程已分叉，--ff-only 拒绝合并。可让用户决定是 rebase（git_pull rebase=true）还是手工合并。'
      : '';
    return { success: false, error: `${raw}${hint}` };
  }
}

/**
 * git push：永不强推；默认拒绝直推 main/master（需显式 allowProtected=true）
 */
export async function gitPush(
  cwd: string,
  options: {
    remote?: string;
    branch?: string;
    setUpstream?: boolean;
    tags?: boolean;
    allowProtected?: boolean;
  } = {}
): Promise<GitOpResult & { branch?: string; ahead?: number; behind?: number }> {
  try {
    if (!(await isGitRepo(cwd))) return { success: false, error: '当前目录不是 git 仓库' };
    const remotes = await gitRemotes(cwd);
    if (remotes.length === 0) {
      return { success: false, error: '当前仓库没有配置任何远程，无法 push。需要用户先 git remote add origin <url>' };
    }

    const current = await gitCurrentBranch(cwd);
    if (current === 'HEAD' && !options.branch) {
      return { success: false, error: '当前处于游离 HEAD 状态，请先切到某个分支再推送' };
    }
    const branch = String(options.branch ?? current).trim();
    if (!isValidRefName(branch)) return { success: false, error: `非法分支名：${branch}` };
    if (PROTECTED_BRANCHES.includes(branch) && !options.allowProtected) {
      return {
        success: false,
        error:
          `拒绝直接推送受保护分支 ${branch}。请先创建特性分支（git_branch action=create, name=feat/xxx, checkout=true）再推送；` +
          `确需直推由用户显式确认后传 allowProtected=true。`,
      };
    }

    const remote = String(options.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0])).trim();
    if (!remotes.includes(remote)) return { success: false, error: `远程 ${remote} 不存在，可用：${remotes.join(', ')}` };

    const args = ['push'];
    if (options.setUpstream) args.push('-u');
    args.push(remote, branch);
    if (options.tags) args.push('--tags');

    const r = await git(args, cwd);
    const ab = await gitAheadBehind(cwd);
    const text = `${(r.stdout || '').trim()}\n${(r.stderr || '').trim()}`.trim();
    return {
      success: true,
      branch,
      ahead: ab?.ahead,
      behind: ab?.behind,
      output: text || `已推送 ${branch} 到 ${remote}`,
    };
  } catch (err: any) {
    return { success: false, error: gitErrorText(err) };
  }
}
