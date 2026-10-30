import os from 'node:os';
import path from 'node:path';

/**
 * 路径解析工具（无 Electron 强依赖）
 *
 * 目标：让 core-fork / adapter 既能跑在 Electron 主进程，也能跑在纯 Node（headless CLI）下。
 * 纯 Node 环境中 `require('electron')` 返回的是二进制路径字符串而非模块对象，
 * 因此所有访问都必须做能力探测，不能直接解构。
 */

type ElectronApp = {
  getPath?: (name: string) => string;
  getAppPath?: () => string;
  isPackaged?: boolean;
};

function tryElectronApp(): ElectronApp | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron');
    const app = mod && (mod.app || (typeof mod.getPath === 'function' ? mod : null));
    if (app && typeof app.getPath === 'function') return app as ElectronApp;
  } catch {
    // 纯 Node 环境或 electron 未安装：走下方的默认目录
  }
  return null;
}

/**
 * 用户数据根目录。
 * 优先级：CNKEIDE_HOME 环境变量 > Electron userData > ~/.cnkeide
 */
export function resolveUserDataDir(): string {
  const override = process.env.CNKEIDE_HOME;
  if (override && override.trim()) return path.resolve(override.trim());

  const app = tryElectronApp();
  if (app?.getPath) {
    try {
      return app.getPath('userData');
    } catch {
      /* 非标准环境回落 */
    }
  }
  return path.join(os.homedir(), '.cnkeide');
}

/**
 * 文档目录（新建任务时工作区文件夹的默认父目录）。
 *
 * 默认放在「文档」下而不是 userData：任务是用户看得见、要往里放代码的目录，
 * 塞进 AppData 里用户根本找不到。CNKEIDE_TASK_ROOT 可整体覆盖，便于测试隔离。
 */
export function resolveTaskRootDir(): string {
  const override = process.env.CNKEIDE_TASK_ROOT;
  if (override && override.trim()) return path.resolve(override.trim());

  const app = tryElectronApp();
  if (app?.getPath) {
    try {
      return path.join(app.getPath('documents'), 'CnkeIDE');
    } catch {
      /* 非标准环境回落 */
    }
  }
  return path.join(os.homedir(), 'Documents', 'CnkeIDE');
}

/**
 * 应用根目录（用于查找随包分发的 skills 等资源）。
 * Electron 下为 app.getAppPath()，CLI 下为进程工作目录。
 */
export function resolveAppPath(): string {
  const app = tryElectronApp();
  if (app?.getAppPath) {
    try {
      return app.getAppPath();
    } catch {
      /* 回落 */
    }
  }
  return process.cwd();
}

/**
 * 只读资源目录（打包后的 resources，未打包时为应用根目录）。
 */
export function resolveResourcesPath(): string {
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resources) return resources;
  return resolveAppPath();
}
