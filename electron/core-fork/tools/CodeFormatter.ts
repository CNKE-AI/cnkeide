/**
 * CodeFormatter - 代码格式化封装（W4）
 * 自动检测 prettier / eslint --fix / black(go-python 通用思路)
 * 失败兜底：返回错误信息由 LLM 决定下一步
 */

import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSafe } from '../util/SafeSpawn';

// promisify 对三回调值 (stdout, stderr) 的函数类型推断不足，必须显式标注返回类型
const execFileAsync = promisify(execFileSafe) as unknown as (
  file: string,
  args: string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

export type Formatter = 'prettier' | 'eslint-fix' | 'black' | 'gofmt' | 'rustfmt' | 'unknown';

export interface FormatResult {
  success: boolean;
  formatter: Formatter;
  command: string;
  filesFormatted: number;
  output: string;
  error?: string;
}

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 100_000;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 探测项目里可用的格式化工具 */
export async function detectFormatter(cwd: string, filePath?: string): Promise<Formatter> {
  const ext = filePath ? path.extname(filePath) : '';

  // 优先看 package.json
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (allDeps.prettier) return 'prettier';
    if (allDeps.eslint) return 'eslint-fix';
  } catch { /* ignore */ }

  // 按文件类型推断
  if (ext === '.py' || (await exists(path.join(cwd, 'pyproject.toml')))) return 'black';
  if (ext === '.go') return 'gofmt';
  if (ext === '.rs') return 'rustfmt';
  if (['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md'].includes(ext)) {
    // 默认尝试 prettier（全局或本地）
    return 'prettier';
  }
  return 'unknown';
}

/** 执行格式化（修改文件） */
export async function formatCode(
  cwd: string,
  files: string[],
  options: { formatter?: Formatter } = {}
): Promise<FormatResult> {
  if (!files || files.length === 0) {
    return { success: false, formatter: 'unknown', command: '', filesFormatted: 0, output: '', error: 'files 不能为空' };
  }
  const formatter = options.formatter ?? (await detectFormatter(cwd, files[0]));
  if (formatter === 'unknown') {
    return { success: false, formatter, command: '', filesFormatted: 0, output: '', error: '未检测到可用的格式化工具' };
  }

  let command: string;
  let args: string[];
  if (formatter === 'prettier') {
    command = `npx prettier --write ${files.join(' ')}`;
    args = ['--write', ...files];
  } else if (formatter === 'eslint-fix') {
    command = `npx eslint --fix ${files.join(' ')}`;
    args = ['--fix', ...files];
  } else if (formatter === 'black') {
    command = `black ${files.join(' ')}`;
    args = [...files];
  } else if (formatter === 'gofmt') {
    command = `gofmt -w ${files.join(' ')}`;
    args = ['-w', ...files];
  } else {
    command = `rustfmt ${files.join(' ')}`;
    args = [...files];
  }

  try {
    const { stdout, stderr } = await execFileAsync('npx', formatter === 'prettier' || formatter === 'eslint-fix' ? args : [formatter, ...args], {
      cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: TIMEOUT_MS,
      windowsHide: true,
    }).catch(async (err) => {
      // fallback：直接调二进制
      const bin = formatter === 'prettier' || formatter === 'eslint-fix' ? formatter : formatter;
      return execFileAsync(bin, args, { cwd, maxBuffer: MAX_OUTPUT_BYTES, timeout: TIMEOUT_MS, windowsHide: true });
    });
    const out = (stdout + '\n' + stderr).slice(0, MAX_OUTPUT_BYTES);
    return {
      success: true,
      formatter,
      command,
      filesFormatted: files.length,
      output: out,
    };
  } catch (err: any) {
    return {
      success: false,
      formatter,
      command,
      filesFormatted: 0,
      output: (err?.stdout || '') + '\n' + (err?.stderr || ''),
      error: err?.message || String(err),
    };
  }
}
