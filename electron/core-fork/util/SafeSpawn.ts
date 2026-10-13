/**
 * SafeSpawn — 统一的安全子进程派生入口
 *
 * 目标（硬约束）：应用运行期间**任何时刻都不得产生 electron.exe 子进程**。
 *
 * 背景与原理
 * ----------
 * 在 Electron 主进程中，`process.env` 会带有一批 Electron 注入的变量
 * （`ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ATTACH_CONSOLE`、`ELECTRON_EXEC_PATH` 等）。
 * 当这些变量随 `env: { ...process.env }` 透传给子进程时，会产生两类风险：
 *
 *   1. 若子进程实际解析到 Electron 二进制（例如 PATH 中 electron 目录排在前面、
 *      npm 在 Electron 环境下把 `node` 解析到 `electron.exe`），带
 *      `ELECTRON_RUN_AS_NODE=1` 的 electron.exe 会以 Node 模式启动 —— 任务管理器里
 *      就多出一个 electron.exe 进程，被用户误认为"应用又开了一个自己"。
 *   2. Electron 的 OS 级环境变量会干扰子进程（如 Windows 上
 *      `ELECTRON_NO_ATTACH_CONSOLE` 影响控制台附着、`ELECTRON_EXEC_PATH` 影响
 *      npm/node 的自我解析）。
 *
 * 处理策略
 * --------
 *   - `sanitizeEnv()`：**移除**所有 Electron 注入变量（黑名单前缀 `ELECTRON_`），
 *     并补齐 `CNKE_CHILD_PROCESS=1` 标记，便于诊断"该进程由 CnkeIDE 派生"。
 *   - `spawnSafe()` / `execFileSafe()`：在 sanitize 之后，额外做二进制守卫 ——
 *     若解析出的可执行文件是 electron/electron.exe，直接拒绝并返回错误，
 *     绝不放行（双保险，即使未来 env 透传被改回也不会有 electron.exe 子进程）。
 *   - `stripElectronEnvFromProcess()`：进程级兜底，在 main 入口删除
 *     `process.env` 中的 Electron 注入变量，让任何**绕过本模块**的 spawn
 *     （第三方库内部调用 child_process）也拿不到这些变量。
 *
 * 使用约定
 * --------
 * electron/ 目录下所有 `child_process` 调用必须经由本模块，
 * 不允许直接 `import { spawn } from 'node:child_process'`。
 */

import { spawn, execFile, type SpawnOptions } from 'node:child_process';
import * as path from 'node:path';

/** Electron 注入进程环境变量的前缀：全部剔除 */
const ELECTRON_ENV_PREFIX = 'ELECTRON_';

/** 子进程标记：便于诊断子进程来源 */
const CHILD_FLAG = 'CNKE_CHILD_PROCESS';

/** 被禁止作为子进程可执行文件的二进制名（小写、含 .exe 与不带扩展名两种写法） */
const FORBIDDEN_BINARIES = new Set(['electron', 'electron.exe', 'electron.cmd', 'electron.bat']);

/** 判定结果 */
export interface SpawnGuardResult {
  ok: boolean;
  /** 被拒绝的原因（ok=false 时有值） */
  reason?: string;
}

/**
 * 清理环境变量：移除全部 Electron 注入变量并追加子进程标记。
 *
 * @param extra   调用方需要额外注入的环境变量（优先级最高，但仍不允许写回 Electron 变量）
 * @param base    基准环境，默认 `process.env`
 */
export function sanitizeEnv(
  extra?: NodeJS.ProcessEnv | Record<string, string> | null,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k || v === undefined) continue;
    if (k.toUpperCase().startsWith(ELECTRON_ENV_PREFIX)) continue;
    out[k] = v;
  }

  if (extra) {
    for (const [k, v] of Object.entries(extra as Record<string, string | undefined>)) {
      if (!k || v === undefined) continue;
      // 显式注入也不允许重新引入 Electron 变量（防止误用导致 electron.exe 子进程）
      if (k.toUpperCase().startsWith(ELECTRON_ENV_PREFIX)) continue;
      out[k] = v;
    }
  }

  out[CHILD_FLAG] = '1';
  return out;
}

/**
 * 二进制守卫：判断目标可执行文件是否为 electron（含 .exe / cmd / bat）。
 *
 * 支持传入裸命令名（`node`）、绝对路径（`C:\\...\\electron.exe`）、
 * 带引号的路径。判定逻辑：取 basename（去掉引号与 `.exe` 重复后缀）后比对黑名单，
 * 并额外检查路径中是否存在独立的 `electron` 目录段（覆盖 PATH 被指向
 * `node_modules/electron/dist` 的极端情况）。
 */
export function checkBinaryForbidden(file: string): SpawnGuardResult {
  if (!file) return { ok: true };

  const raw = String(file).trim().replace(/^["']|["']$/g, '');
  const base = path.basename(raw).toLowerCase();

  if (FORBIDDEN_BINARIES.has(base)) {
    return { ok: false, reason: `禁止派生 electron 进程（${raw}）` };
  }

  // 允许 "electron/node" 这类合法路径；只在以 electron 结尾时才判定
  if (/^electron(\.exe|\.cmd|\.bat)?$/.test(base)) {
    return { ok: false, reason: `禁止派生 electron 进程（${raw}）` };
  }

  // 绝对/相对路径场景：末级目录为 electron 或 electron.exe 所在目录
  const dirSegments = raw.replace(/\\/g, '/').split('/');
  const lastDir = (dirSegments[dirSegments.length - 2] || '').toLowerCase();
  if (lastDir === 'electron' && /^electron(\.exe)?$/.test(base)) {
    return { ok: false, reason: `禁止派生 electron 进程（${raw}）` };
  }

  return { ok: true };
}

/**
 * 安全 spawn：自动 sanitize 环境变量 + 拒绝 electron 二进制。
 *
 * 与 `child_process.spawn` 的差别：
 *   - `env` 默认为 sanitize 后的 process.env（调用方传入的 env 会与之合并并被再次清洗）
 *   - 若 `file` 命中 electron 黑名单，**不派生子进程**，返回一个立即发出
 *     `error` 事件的 ChildProcess 替身，调用方无需特殊处理错误分支
 */
export function spawnSafe(file: string, args: string[] = [], options: SpawnOptions = {}) {
  const guard = checkBinaryForbidden(file);
  if (!guard.ok) {
    return createRejectedChild(file, guard.reason || '禁止派生 electron 进程');
  }

  const { env, ...rest } = options;
  return spawn(file, args, {
    ...rest,
    env: sanitizeEnv(env as NodeJS.ProcessEnv | undefined),
  });
}

/**
 * 安全 execFile：语义同 `spawnSafe`，用于一次性命令（探测版本、git、rg、pytest 等）。
 */
export function execFileSafe(
  file: string,
  args: string[] = [],
  options: Record<string, unknown> = {},
  callback?: (error: Error | null, stdout: string, stderr: string) => void,
): any {
  const guard = checkBinaryForbidden(file);
  if (!guard.ok) {
    const err = new Error(guard.reason || '禁止派生 electron 进程');
    if (typeof options === 'function') {
      (options as any)(err, '', '');
      return createRejectedChild(file, err.message);
    }
    if (callback) callback(err, '', '');
    return createRejectedChild(file, err.message);
  }

  const { env, ...rest } = options as SpawnOptions & Record<string, unknown>;
  return (execFile as any)(
    file,
    args,
    { ...rest, env: sanitizeEnv(env as NodeJS.ProcessEnv | undefined) },
    callback,
  );
}

/**
 * 构造一个"被拒绝"的 ChildProcess 替身。
 *
 * 行为契约（与真实 ChildProcess 保持足够兼容）：
 *   - 下一个 tick 异步发出 `error` 事件（携带明确原因），随后发出 `close`(1)
 *   - `stdout` / `stderr` 为空的可读替身，`stdin` 为 null
 *   - `kill()` / `pid` / `killed` 等常用字段齐备，避免调用方解构报错
 */
function createRejectedChild(file: string, reason: string): any {
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');

  const child: any = new EventEmitter();
  child.pid = -1;
  child.killed = false;
  child.exitCode = 1;
  child.stdout = Readable.from([]);
  child.stderr = Readable.from([]);
  child.stdin = null;
  child.kill = () => {
    child.killed = true;
    return true;
  };

  const err: any = new Error(reason);
  err.code = 'ERR_FORBIDDEN_BINARY';
  err.file = file;

  process.nextTick(() => {
    child.emit('error', err);
    child.emit('close', 1);
    child.emit('exit', 1);
  });

  return child;
}

/**
 * 进程级兜底：从 `process.env` 中删除 Electron 注入变量。
 *
 * 必须在 main 入口**尽早**调用（app.whenReady 之前），这样即便某个第三方库
 * 直接调用 `child_process.spawn(..., { env: process.env })`，也无法把
 * `ELECTRON_RUN_AS_NODE` 等变量带到子进程，从根上杜绝 electron.exe 子进程。
 *
 * @returns 被删除的变量名列表（便于启动日志输出）
 */
export function stripElectronEnvFromProcess(): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith(ELECTRON_ENV_PREFIX)) {
      delete process.env[key];
      removed.push(key);
    }
  }
  process.env[CHILD_FLAG] = '1';
  return removed;
}
