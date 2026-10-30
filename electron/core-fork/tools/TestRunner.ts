/**
 * TestRunner - 项目测试自动检测与执行（W4）
 * 检测 package.json 的 scripts.test / python pytest / go test / cargo / make test
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSafe } from '../util/SafeSpawn';

interface ShellCapture {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * 跑一条 shell 命令并**在非零退出码时也拿到完整输出**。
 *
 * 为什么不用 promisify(execFile)：失败时 reject 出来的 err 对象在本环境下
 * 不带 stdout/stderr（`err.stdout === undefined`），于是"测试失败"这个最重要的场景
 * 反而拿不到任何失败信息——模型只能看到退出码，无法定位。回调参数才是可靠的。
 */
function runShellCaptured(
  file: string,
  args: string[],
  options: Record<string, unknown>,
): Promise<ShellCapture> {
  return new Promise((resolve) => {
    try {
      execFileSafe(file, args, options, (err: any, stdout: string, stderr: string) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: err ? err.message || `退出码 ${code}` : undefined,
        });
      });
    } catch (err: any) {
      resolve({ code: -1, stdout: '', stderr: '', error: err?.message || String(err) });
    }
  });
}

export type TestFramework = 'npm' | 'yarn' | 'pnpm' | 'pytest' | 'go' | 'cargo' | 'make' | 'unknown';

export interface TestRunResult {
  success: boolean;
  framework: TestFramework;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  truncated?: boolean;
}

const TIMEOUT_MS = 300_000; // 5 分钟
const MAX_OUTPUT_BYTES = 200_000;

export async function detectTestFramework(cwd: string): Promise<{ framework: TestFramework; command: string }> {
  const pkgPath = path.join(cwd, 'package.json');
  try {
    const pkgRaw = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    if (pkg?.scripts?.test) {
      const hasYarn = await exists(path.join(cwd, 'yarn.lock'));
      const hasPnpm = await exists(path.join(cwd, 'pnpm-lock.yaml'));
      if (hasPnpm) return { framework: 'pnpm', command: 'pnpm test' };
      if (hasYarn) return { framework: 'yarn', command: 'yarn test' };
      return { framework: 'npm', command: 'npm test' };
    }
  } catch { /* ignore */ }

  if (await exists(path.join(cwd, 'pytest.ini')) || await exists(path.join(cwd, 'pyproject.toml')) || await exists(path.join(cwd, 'tests'))) {
    return { framework: 'pytest', command: 'python -m pytest' };
  }
  if (await exists(path.join(cwd, 'go.mod'))) {
    return { framework: 'go', command: 'go test ./...' };
  }
  if (await exists(path.join(cwd, 'Cargo.toml'))) {
    return { framework: 'cargo', command: 'cargo test' };
  }
  if (await exists(path.join(cwd, 'Makefile'))) {
    return { framework: 'make', command: 'make test' };
  }

  return { framework: 'unknown', command: '' };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runTests(
  cwd: string,
  options: { framework?: TestFramework; extraArgs?: string[]; timeoutMs?: number } = {}
): Promise<TestRunResult> {
  const detected = await detectTestFramework(cwd);
  const framework = options.framework ?? detected.framework;
  let baseCmd = detected.command;
  if (framework !== detected.framework) {
    const all: Record<string, string> = {
      npm: 'npm test',
      yarn: 'yarn test',
      pnpm: 'pnpm test',
      pytest: 'python -m pytest',
      go: 'go test ./...',
      cargo: 'cargo test',
      make: 'make test',
    };
    baseCmd = all[framework] || baseCmd;
  }
  if (!baseCmd) {
    return {
      success: false,
      framework: 'unknown',
      command: '',
      exitCode: -1,
      stdout: '',
      stderr: '',
      durationMs: 0,
      error: '未检测到测试框架，请在 package.json 加 scripts.test，或提供 framework 参数',
    };
  }
  const fullCmd = options.extraArgs?.length ? `${baseCmd} ${options.extraArgs.join(' ')}` : baseCmd;
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'powershell.exe' : '/bin/bash';
  const shellArgs = isWin
    ? ['-NoProfile', '-NonInteractive', '-Command', fullCmd]
    : ['-c', fullCmd];

  const t0 = Date.now();
  const captured = await runShellCaptured(shell, shellArgs, {
    cwd,
    maxBuffer: MAX_OUTPUT_BYTES * 2,
    timeout: options.timeoutMs ?? TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  const outTrunc = captured.stdout.length > MAX_OUTPUT_BYTES;
  const errTrunc = captured.stderr.length > MAX_OUTPUT_BYTES;
  return {
    success: captured.code === 0,
    framework,
    command: fullCmd,
    exitCode: captured.code,
    stdout: outTrunc ? captured.stdout.slice(0, MAX_OUTPUT_BYTES) : captured.stdout,
    stderr: errTrunc ? captured.stderr.slice(0, MAX_OUTPUT_BYTES) : captured.stderr,
    durationMs: Date.now() - t0,
    error: captured.error,
    truncated: outTrunc || errTrunc,
  };
}
