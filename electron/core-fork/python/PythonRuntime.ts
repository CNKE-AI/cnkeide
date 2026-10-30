/**
 * Python 运行时解析器（通用，供 PPT Master 与 run_python 等共用）。
 *
 * 解析优先级：
 *   1. 用户显式配置的 pythonPath（settings，全局或 PPT Master）
 *   2. 项目级虚拟环境（.venv / venv / env 目录，按项目根识别）
 *   3. 随应用打包的内置运行时（resources/python/...）
 *   4. 开发期本地 venv（.pptmaster-venv，PPT Master 兼容）
 *   5. 系统 python3 / python / py
 *
 * 解析结果按 `配置 + 项目根` 维度缓存，避免每次 spawn 都探测，也不被别的
 * 项目缓存遮蔽。同时提供依赖探测与 pip 安装（GBK 安全解码 + 国内镜像 + 超时）。
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFileSafe, spawnSafe } from '../util/SafeSpawn';
import { decodeOutput } from '../util/TextDecode';

// promisify 对三回调值 (stdout, stderr) 的函数类型推断不足，必须显式标注返回类型
const execFileAsync = promisify(execFileSafe) as unknown as (
  file: string,
  args: string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

export interface PythonInfo {
  /** 可执行文件绝对路径，或裸命令名（回退到 PATH） */
  path: string;
  /** 版本号，如 "3.12.4"；探测失败为 null */
  version: string | null;
  /** 运行时来源，便于诊断 */
  source: 'configured' | 'project' | 'bundled' | 'venv' | 'system';
  /** 是否为 Python 3.9+ */
  usable: boolean;
}

export interface DependencyStatus {
  name: string;
  importName: string;
  installed: boolean;
  /** 该依赖缺失时受影响的能力 */
  impact: string;
  /** 是否为核心链路必需 */
  required: boolean;
}

export const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';

/** 关键依赖清单：核心链路必需 + 增强能力可选 */
const DEPENDENCIES: Array<{ name: string; importName: string; impact: string; required: boolean }> = [
  { name: 'python-pptx', importName: 'pptx', impact: 'SVG→原生 PPTX 导出（核心）', required: true },
  { name: 'PyYAML', importName: 'yaml', impact: '模板注册/项目元数据（核心）', required: true },
  { name: 'Pillow', importName: 'PIL', impact: '图片尺寸归一化', required: true },
  { name: 'XlsxWriter', importName: 'xlsxwriter', impact: '图表/表格原生导出', required: false },
  { name: 'numpy', importName: 'numpy', impact: '图片分析', required: false },
  { name: 'requests', importName: 'requests', impact: '网页素材抓取', required: false },
  { name: 'beautifulsoup4', importName: 'bs4', impact: '网页素材解析', required: false },
  { name: 'mammoth', importName: 'mammoth', impact: 'DOCX 源文档转换', required: false },
  { name: 'openpyxl', importName: 'openpyxl', impact: 'XLSX 源文档转换', required: false },
  { name: 'flask', importName: 'flask', impact: 'SVG 实时预览编辑器', required: false },
  { name: 'markdownify', importName: 'markdownify', impact: 'HTML 源文档转换', required: false },
  { name: 'skia-pathops', importName: 'pathops', impact: 'PowerPoint 合并形状运算', required: false },
  { name: 'uharfbuzz', importName: 'uharfbuzz', impact: '文字轮廓运算', required: false },
];

/** 按 `配置 + 项目根` 维度缓存，避免跨项目互相遮蔽 */
const cache: Map<string, PythonInfo | null> = new Map();

/**
 * 探测单个候选可执行文件是否可用（--version 能跑通且为 Python 3.9+）。
 */
async function probe(candidate: string): Promise<{ version: string; usable: boolean } | null> {
  try {
    const { stdout, stderr } = await execFileAsync(candidate, ['--version'], {
      timeout: 8000,
      windowsHide: true,
    });
    const out = `${stdout || ''}${stderr || ''}`.trim();
    const m = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
    if (!m) return null;
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return { version, usable: major === 3 && minor >= 9 };
  } catch {
    return null;
  }
}

/** 项目级 venv 候选（与平台相关的可执行文件路径） */
function projectVenvCandidates(projectRoot: string): Array<{ path: string; source: PythonInfo['source'] }> {
  if (!projectRoot) return [];
  const dirs = ['.venv', 'venv', 'env', '.env'];
  const out: Array<{ path: string; source: PythonInfo['source'] }> = [];
  for (const d of dirs) {
    out.push({ path: path.join(projectRoot, d, 'Scripts', 'python.exe'), source: 'project' });
    out.push({ path: path.join(projectRoot, d, 'bin', 'python3'), source: 'project' });
  }
  return out;
}

/**
 * 生成候选列表（按优先级）。bundled 目录由调用方通过 resourcesPath 传入。
 */
function buildCandidates(opts: {
  configuredPath?: string | null;
  resourcesPath?: string | null;
  skillRoot?: string | null;
  projectRoot?: string | null;
}): Array<{ path: string; source: PythonInfo['source'] }> {
  const list: Array<{ path: string; source: PythonInfo['source'] }> = [];

  if (opts.configuredPath && opts.configuredPath.trim()) {
    list.push({ path: opts.configuredPath.trim(), source: 'configured' });
  }

  // 项目级虚拟环境（最贴近当前工程，优先于系统）
  list.push(...projectVenvCandidates(opts.projectRoot || ''));

  // 内置运行时：<resources>/python/python.exe (Windows) 或 <resources>/python/bin/python3
  if (opts.resourcesPath) {
    const base = path.join(opts.resourcesPath, 'python');
    list.push({ path: path.join(base, 'python.exe'), source: 'bundled' });
    list.push({ path: path.join(base, 'bin', 'python3'), source: 'bundled' });
    list.push({ path: path.join(base, 'python'), source: 'bundled' });
  }

  // 开发期 venv（PPT Master 兼容，与 skills 同级）
  if (opts.skillRoot) {
    const venvBase = path.join(opts.skillRoot, '..', '..', '.pptmaster-venv');
    list.push({ path: path.join(venvBase, 'Scripts', 'python.exe'), source: 'venv' });
    list.push({ path: path.join(venvBase, 'bin', 'python3'), source: 'venv' });
  }

  // 系统 PATH
  list.push({ path: 'python3', source: 'system' });
  list.push({ path: 'python', source: 'system' });
  list.push({ path: 'py', source: 'system' });

  return list;
}

/**
 * 解析可用的 Python 解释器。结果按配置 + 项目根缓存。
 * @param force 强制重新探测（用户改了配置后调用）
 */
export async function resolvePython(opts: {
  configuredPath?: string | null;
  resourcesPath?: string | null;
  skillRoot?: string | null;
  projectRoot?: string | null;
  force?: boolean;
}): Promise<PythonInfo | null> {
  const projectKey = opts.projectRoot || opts.skillRoot || '';
  const key = `${opts.configuredPath || ''}|${projectKey}`;
  if (!opts.force && cache.has(key)) return cache.get(key) ?? null;

  const candidates = buildCandidates(opts);
  for (const c of candidates) {
    // 绝对路径先做存在性检查，减少无谓 spawn
    if (path.isAbsolute(c.path) && !existsSync(c.path)) continue;
    const r = await probe(c.path);
    // 探测失败（r 为 null）或版本过低（usable 为 false）都不接受：
    // 否则 run_python / PPT Master 会拿着 3.8 之类的解释器去跑 3.9+ 才有的语法而报错。
    if (r && r.usable) {
      const info: PythonInfo = { path: c.path, version: r.version, source: c.source, usable: true };
      cache.set(key, info);
      return info;
    }
  }

  cache.set(key, null);
  return null;
}

/** 清除缓存（配置变更 / 安装内置运行时后调用） */
export function clearPythonCache(): void {
  cache.clear();
}

/**
 * 检查关键依赖安装情况。一次 python 调用批量探测，避免逐个 spawn。
 */
export async function checkDependencies(pythonPath: string): Promise<DependencyStatus[]> {
  const importNames = DEPENDENCIES.map((d) => d.importName);
  const script = `
import importlib.util, json, sys
names = ${JSON.stringify(importNames)}
out = {}
for n in names:
    try:
        out[n] = importlib.util.find_spec(n) is not None
    except Exception:
        out[n] = False
print(json.dumps(out))
`;
  let found: Record<string, boolean> = {};
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', script], {
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    found = JSON.parse((stdout || '{}').trim().split('\n').pop() || '{}');
  } catch {
    // 探测失败：全部视为未安装，交由上层提示
  }

  return DEPENDENCIES.map((d) => ({
    name: d.name,
    importName: d.importName,
    installed: found[d.importName] === true,
    impact: d.impact,
    required: d.required,
  }));
}

/**
 * 安装依赖（pip install）。返回是否成功。
 *
 * 相比旧实现：① 输出用 GBK 安全解码，中文报错不再乱码；
 * ② 默认国内镜像 + 关闭版本检查，安装更快更稳；③ 带超时，避免卡死。
 */
export async function installDependencies(
  pythonPath: string,
  requirementsPath: string,
  onOutput?: (line: string) => void,
): Promise<{ success: boolean; error?: string }> {
  const args = [
    '-m',
    'pip',
    'install',
    '-r',
    requirementsPath,
    '-i',
    PYPI_MIRROR,
    '--disable-pip-version-check',
    '--no-input',
  ];
  return new Promise((resolve) => {
    const child = spawnSafe(pythonPath, args, { windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ success: false, error: 'pip 安装超时（300s）' });
    }, 300_000);

    child.stdout?.on('data', (b: Buffer) => onOutput?.(decodeOutput(b)));
    child.stderr?.on('data', (b: Buffer) => onOutput?.(decodeOutput(b)));
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      resolve({ success: false, error: e.message });
    });
    child.on('close', (code: number) => {
      clearTimeout(timer);
      resolve(code === 0 ? { success: true } : { success: false, error: `pip 退出码 ${code}` });
    });
  });
}
