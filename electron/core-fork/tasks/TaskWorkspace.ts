import fs from 'node:fs';
import path from 'node:path';

/**
 * 任务工作区（TRAE 式「新建任务 = 自动建同名文件夹」的核心逻辑）
 *
 * 设计约束（都很关键，改动前先读一遍）：
 * 1. **只建空目录**，不往用户的项目目录里塞任何标记文件。
 *    任务是用户放代码的地方，多一个 task.json 就多一份被提交进版本库的垃圾；
 *    任务与文件夹的关联改为存在应用侧索引里（workspacePath 绝对路径 = 主键）。
 * 2. **只新建、绝不复用**：目标目录已存在时自动追加 `-2`/`-3` 后缀另建，
 *    这样回滚时"删掉这个刚建的目录"永远安全，不可能误删用户已有文件。
 * 3. **失败必须回滚**：makedir 之后任何一步抛错，都把本次新建的空目录删掉，
 *    不留半成品（否则下次同名会被自动避让成 `-2`，用户会看到一堆空壳）。
 */

/** 目录名长度上限（按字符计，给 Windows 路径留足余量） */
export const TASK_DIR_MAX_LEN = 48;

/** Windows 保留设备名：作为目录名会创建失败或行为诡异 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Windows/POSIX 下不允许出现在文件名里的字符 */
const ILLEGAL_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

export interface TaskWorkspaceRecord {
  /** 任务 id = 工作区绝对路径，与 session.workspaceId 同一语义（同一主键） */
  id: string;
  /** 任务名（用户输入的原名，仅展示用，不参与路径计算） */
  name: string;
  /** 实际目录名（清洗 + 去重后的结果） */
  dirName: string;
  /** 父目录绝对路径 */
  parentDir: string;
  /** 工作区绝对路径（= id） */
  workspacePath: string;
  createdAt: number;
}

export type CreateTaskResult =
  | { ok: true; record: TaskWorkspaceRecord }
  | { ok: false; error: string };

/**
 * 去掉控制字符（换行 / 制表 / NUL 等）。
 * 不用正则 `\u0000-\u001f` 是因为 eslint 的 no-control-regex 会报错，
 * 而且逐字符判断对代理对（emoji）更安全。
 */
function stripControlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out;
}

/** 用固定格式的时间戳做兜底名，避免"未命名任务"互相覆盖 */
function fallbackName(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `task-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把用户输入的任务名清洗成可用的目录名。
 *
 * 规则（与资源管理器/IDE 的直觉一致）：
 * - 非法字符 `\ / : * ? " < > |` → `-`
 * - 连续空白 → 单个 `-`，连续 `-` 折叠
 * - 去掉首尾的 `.`、`-`、空白（Windows 不允许目录名以点或空格结尾）
 * - 超长截断到 TASK_DIR_MAX_LEN
 * - 空名 / 全是非法字符 → `task-<yyyyMMdd-HHmmss>`
 * - 命中 Windows 保留名（CON、PRN…）→ 加 `task-` 前缀
 *
 * 中文、日文、emoji 都原样保留：用户起名叫「统计看板导出」，文件夹就叫「统计看板导出」，
 * 不强行转拼音或英文（转出来反而看不懂是哪个任务）。
 */
export function sanitizeTaskName(raw: string, now: number = Date.now()): string {
  const src = stripControlChars(typeof raw === 'string' ? raw : '');
  let name = '';
  for (const ch of src) {
    name += ILLEGAL_CHARS.has(ch) ? '-' : ch;
  }
  name = name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '');

  if (name.length > TASK_DIR_MAX_LEN) {
    name = name.slice(0, TASK_DIR_MAX_LEN).replace(/[.\-\s]+$/, '');
  }
  if (!name) name = fallbackName(now);
  if (RESERVED_NAMES.has(name.toLowerCase())) name = `task-${name}`;
  return name;
}

/**
 * 在 parentDir 下求一个未被占用的目录名：`名称`、`名称-2`、`名称-3` …
 *
 * 用 `-2` 而不是 `(2)`：括号在命令行 / Markdown / URL 里都要转义，
 * 而连字符在 shell 里不用引号也能用。
 */
export function uniqueDirName(base: string, parentDir: string): string | null {
  const exists = (n: string) => fs.existsSync(path.join(parentDir, n));
  if (!exists(base)) return base;
  for (let n = 2; n <= 999; n++) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  return null;
}

/**
 * 新建任务工作区：在 parentDir 下建一个**空目录**。
 *
 * 返回的 record.id === record.workspacePath，调用方直接把它当 workspaceId 用。
 */
export function createTaskWorkspace(params: {
  name: string;
  parentDir: string;
  now?: number;
}): CreateTaskResult {
  const now = params.now ?? Date.now();
  const rawParent = (params.parentDir || '').trim();
  if (!rawParent) return { ok: false, error: '未指定工作区父目录' };

  const parentDir = path.resolve(rawParent);
  let createdDir: string | null = null;

  try {
    // 父目录不存在就建出来（多级），已存在则原样保留
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    } else if (!fs.statSync(parentDir).isDirectory()) {
      return { ok: false, error: `父路径不是文件夹：${parentDir}` };
    }

    const base = sanitizeTaskName(params.name, now);
    const dirName = uniqueDirName(base, parentDir);
    if (!dirName) {
      return { ok: false, error: `同名任务过多（已存在 999 个），请换一个任务名` };
    }

    const target = path.join(parentDir, dirName);
    // 非递归创建：目标已存在会抛 EEXIST，而不是静默写进别人的目录
    fs.mkdirSync(target);
    createdDir = target;

    return {
      ok: true,
      record: {
        id: target,
        name: (params.name || '').trim() || dirName,
        dirName,
        parentDir,
        workspacePath: target,
        createdAt: now,
      },
    };
  } catch (err) {
    // 回滚：只删本次新建的**空**目录，已有目录永不触碰
    if (createdDir) {
      try {
        fs.rmdirSync(createdDir);
      } catch {
        /* 目录里被别的进程写了东西，删不掉就留着，不掩盖原始错误 */
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `创建任务文件夹失败：${msg}` };
  }
}

export type RenameTaskResult =
  | {
      ok: true;
      record: TaskWorkspaceRecord;
      /** 目录是否真的改了名（只改展示名时为 false） */
      dirChanged: boolean;
      /** 改名前路径（调用方据此迁移会话绑定 / 配置） */
      previousPath: string;
    }
  | { ok: false; error: string };

/**
 * 「资源被占用」类错误判定。
 *
 * Windows 上目录 rename 只要有任何进程持有句柄（终端 shell 把该目录当 cwd、
 * fs.watch 监听、编辑器打开的文件、杀毒扫描）就会失败；这类占用是瞬时的，
 * 退避重试通常能过，而"目录不存在/无权限"之类重试也没用。
 */
export function isBusyRenameError(msg?: string): boolean {
  if (!msg) return false;
  return /EBUSY|EPERM|EACCES|ENOTEMPTY|resource busy|being used by another process|另一个程序正在使用/i.test(
    msg,
  );
}

/**
 * 遇到占用类错误时退避重试（1、2、3… 倍基础间隔）。
 *
 * 纯函数式重试器：只关心"结果带 ok/error"，因此可脱离文件系统单测；
 * 每次重试前重新执行 fn —— 要求 fn 在失败时保持外部状态不变（rename 满足）。
 */
export async function retryWhileBusy<T extends { ok: boolean; error?: string }>(
  fn: () => T,
  attempts = 6,
  baseDelayMs = 120,
): Promise<T> {
  let result = fn();
  for (let i = 1; i < attempts && !result.ok && isBusyRenameError(result.error); i++) {
    await new Promise((r) => setTimeout(r, baseDelayMs * i));
    result = fn();
  }
  return result;
}

/**
 * 重命名任务：同时改展示名和磁盘目录名。
 *
 * 为什么目录也跟着改：用户点"重命名"的预期就是资源管理器里的文件夹变了名。
 * 只改展示名会让状态分歧（侧边栏叫 A、文件夹叫 B），下次在 Explorer 里找不着。
 *
 * 三条安全性要求：
 * 1. 目录不存在直接报错，不"顺手重建"（用户可能只是移动了，重建会造出空壳）；
 * 2. 新名字已被别的目录占用时自动避让 `-2`，**绝不覆盖**；
 * 3. 只做一次 fs.rename（同分区原子操作）；跨分区/权限失败时原目录保持原样，
 *    索引由调用方负责回滚 —— 这里不触碰索引，保持纯文件系统语义。
 */
export function renameTaskWorkspace(params: {
  workspacePath: string;
  newName: string;
  createdAt?: number;
}): RenameTaskResult {
  const rawPath = (params.workspacePath || '').trim();
  if (!rawPath) return { ok: false, error: '未指定任务工作区' };
  const oldPath = path.resolve(rawPath);
  if (!taskWorkspaceExists(oldPath)) {
    return { ok: false, error: '任务文件夹不存在，可能已被删除或移动' };
  }

  const displayName = (params.newName || '').trim();
  if (!displayName) return { ok: false, error: '任务名不能为空' };

  const parentDir = path.dirname(oldPath);
  const oldDirName = path.basename(oldPath);
  const base = sanitizeTaskName(displayName);
  const createdAt = params.createdAt ?? Date.now();

  const build = (dirName: string, full: string): TaskWorkspaceRecord => ({
    id: full,
    name: displayName,
    dirName,
    parentDir,
    workspacePath: full,
    createdAt,
  });

  // 目录名不变（只改展示名）：不碰文件系统
  if (base === oldDirName) {
    return { ok: true, dirChanged: false, previousPath: oldPath, record: build(oldDirName, oldPath) };
  }

  try {
    // 仅大小写不同（Windows/macOS 上 existsSync 大小写不敏感，会被误判成"已占用"）
    if (base.toLowerCase() === oldDirName.toLowerCase()) {
      const target = path.join(parentDir, base);
      fs.renameSync(oldPath, target);
      return { ok: true, dirChanged: true, previousPath: oldPath, record: build(base, target) };
    }

    const dirName = uniqueDirName(base, parentDir);
    if (!dirName) {
      return { ok: false, error: '同名任务过多（已存在 999 个），请换一个任务名' };
    }
    const target = path.join(parentDir, dirName);
    fs.renameSync(oldPath, target);
    return { ok: true, dirChanged: true, previousPath: oldPath, record: build(dirName, target) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `重命名任务文件夹失败：${msg}` };
  }
}

/** 任务目录是否还在磁盘上（用户可能手动删了/移走了） */
export function taskWorkspaceExists(workspacePath: string): boolean {
  try {
    return !!workspacePath && fs.statSync(workspacePath).isDirectory();
  } catch {
    return false;
  }
}
