/**
 * PPT Master 集成模块入口
 *
 * 对外暴露：
 *   - getPptMasterService()  —— 单例服务，供 IPC / Agent 工具调用
 *   - initPptMaster()        —— 应用启动时初始化（定位 skill 根目录 + 解析 Python）
 *   - PptMasterService / SkillRunner 等类型
 *
 * 目录约定：
 *   projectsRoot —— 用户数据目录下的 pptmaster-projects/（生成的项目工作区）
 */

import * as path from 'node:path';
import { app } from 'electron';
import { SkillRunner, locateSkillRoot } from './SkillRunner';
import { PptMasterService } from './PptMasterService';
import { resolvePython } from './PythonRuntime';

export { SkillRunner, locateSkillRoot } from './SkillRunner';
export { PptMasterService } from './PptMasterService';
export type {
  PptMasterOptions,
  PptMasterResult,
  PptMasterProgress,
  PptMasterStage,
  PptMasterEventHandler,
} from './PptMasterService';
export { EXECUTOR_SYSTEM_PROMPT } from './PptMasterService';
export { checkDependencies, installDependencies, resolvePython, clearPythonCache } from './PythonRuntime';
export type { PythonInfo, DependencyStatus } from './PythonRuntime';

let service: PptMasterService | null = null;
let runner: SkillRunner | null = null;
let skillRoot: string | null = null;
let projectsRoot: string | null = null;
let candidatesRoot = '';
let configRef: any = null;

/** 记录 skill 根目录候选基准（用于诊断） */
export function getSkillRootCandidate(): string {
  return candidatesRoot;
}

/** 获取项目工作区根目录 */
export function getProjectsRoot(): string {
  if (!projectsRoot) {
    projectsRoot = path.join(app.getPath('userData'), 'pptmaster-projects');
  }
  return projectsRoot;
}

/**
 * 初始化 PPT Master 集成。
 * @param config ConfigAdapter 实例（用于解析模型 API）
 */
export async function initPptMaster(config?: any): Promise<{
  ok: boolean;
  skillRoot: string | null;
  pythonFound: boolean;
}> {
  if (config) configRef = config;

  const resourcesPath = (process as any).resourcesPath || '';
  const appPath = app.getAppPath();

  skillRoot = locateSkillRoot({
    isPackaged: app.isPackaged,
    appPath,
    resourcesPath,
    searchFrom: [__dirname, process.cwd(), appPath],
  });

  candidatesRoot = [
    `resourcesPath=${resourcesPath}`,
    `appPath=${appPath}`,
    `cwd=${process.cwd()}`,
    `__dirname=${__dirname}`,
  ].join(' | ');

  if (!skillRoot) {
    console.error('[pptmaster] 未找到 skill 包（skills/ppt-master/SKILL.md）');
    return { ok: false, skillRoot: null, pythonFound: false };
  }

  runner = new SkillRunner({
    skillRoot,
    resourcesPath,
    configuredPythonPath: readConfiguredPython(config),
  });

  const python = await runner.ensurePython();
  service = new PptMasterService({
    runner,
    projectsRoot: getProjectsRoot(),
    config,
  });

  console.log(
    `[pptmaster] skillRoot=${skillRoot} python=${python ? `${python.path} (${python.version}, ${python.source})` : '未找到'}`,
  );

  return { ok: true, skillRoot, pythonFound: !!python };
}

/** 从配置读用户指定的 Python 路径 */
function readConfiguredPython(config?: any): string | null {
  if (!config?.get) return null;
  const p = config.get('pptMaster.pythonPath', '');
  return typeof p === 'string' && p.trim() ? p.trim() : null;
}

/** 获取单例服务（未初始化时返回 null） */
export function getPptMasterService(): PptMasterService | null {
  return service;
}

/** 获取单例 runner（未初始化时返回 null） */
export function getSkillRunner(): SkillRunner | null {
  return runner;
}

/** 用户修改 Python 路径后重新绑定 */
export async function rebindPython(config?: any): Promise<{ found: boolean; path?: string; version?: string | null }> {
  if (!runner) return { found: false };
  if (config) configRef = config;
  runner.setConfiguredPythonPath(readConfiguredPython(config ?? configRef));
  const py = await runner.ensurePython(true);
  return py ? { found: true, path: py.path, version: py.version } : { found: false };
}

/** 是否已完成初始化 */
export function isPptMasterReady(): boolean {
  return !!service && !!runner;
}
