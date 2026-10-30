import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { spawnSafe, sanitizeEnv } from '../core-fork/util/SafeSpawn';
import { decodeOutput } from '../core-fork/util/TextDecode';

/**
 * 杀掉子进程及其全部子孙进程。
 * Windows 下 child.kill() 只杀直接子进程（powershell），它启动的构建/测试命令会残留，
 * 因此用 taskkill /T；POSIX 下退化为 kill pid（spawn 未 setpgid）。
 */
function killProcessTree(child: ChildProcess, isWin: boolean): void {
  try {
    if (isWin && typeof child.pid === 'number') {
      // 走 SafeSpawn 而非 execFile：taskkill 同样不能继承 ELECTRON_* 环境变量，
      // 否则可能在结束进程树时反而派生出 electron 进程。
      const killer = spawnSafe('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => {
        /* taskkill 不可用或子进程已退出：忽略 */
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* 进程可能已退出 */
  }
}

export interface TerminalSession {
  pid: number;
  child: ChildProcess;
  cwd: string;
  cols: number;
  rows: number;
}

/**
 * TerminalAdapter - 终端适配层
 * 替换 VSCode integrated terminal / shell execution API
 * 用 Node.js spawn 创建伪终端子进程
 */

/** exec / execProgram 的统一返回结构 */
export interface ExecResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  /** 输出超过上限被截断 */
  truncated?: boolean;
  /** 被丢弃的字符数（仅截断时有意义） */
  droppedChars?: number;
}

export class TerminalAdapter extends EventEmitter {
  private sessions: Map<number, TerminalSession> = new Map();
  private outputBuffer: Map<number, string[]> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  /** 合成会话键计数器：spawn 失败无 pid 时使用负数，避免与真实 OS pid 冲突或同毫秒碰撞 */
  private syntheticIdCounter = 0;

  spawn(cmd: string, args: string[], cwd: string): { success: boolean; pid?: number; error?: string } {
    try {
      const isWin = process.platform === 'win32';
      const shell = isWin
        ? (process.env.COMSPEC || 'powershell.exe')
        : (process.env.SHELL || '/bin/bash');

      // env 统一经 sanitizeEnv 处理：剔除 Electron 注入变量，避免 electron.exe 子进程
      const env = sanitizeEnv({
        TERM: 'xterm-256color',
        // PowerShell 7+ 认此变量；配合启动前导命令强制 UTF-8
        ...(isWin ? { PYTHONIOENCODING: 'utf-8' } : {}),
      });

      // Windows: 用 chcp 65001 前导命令，确保后续输出为 UTF-8
      const child = isWin
        ? (cmd
          ? spawnSafe(cmd, args, { cwd, env, shell: true, windowsHide: false })
          : spawnSafe(shell, isWin && /powershell/i.test(shell)
            ? ['-NoProfile', '-Command', 'chcp 65001 | Out-Null; [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::InputEncoding=[Text.Encoding]::UTF8']
            : [], { cwd, env, shell: true, windowsHide: false }))
        : (cmd
          ? spawnSafe(cmd, args, { cwd, env, shell: true, windowsHide: false })
          : spawnSafe(shell, [], { cwd, env, shell: true, windowsHide: false }));

      // 会话键：优先用子进程真实 pid；无 pid（spawn 异常）时用负数合成键，
      // 避免原先 Date.now() 造成的同毫秒碰撞，以及与 OS 复用的真实 pid 混淆。
      const pid = child.pid ?? -(++this.syntheticIdCounter);
      const session: TerminalSession = { pid, child, cwd, cols: 80, rows: 24 };
      this.sessions.set(pid, session);
      this.outputBuffer.set(pid, []);

      child.stdout?.on('data', (data: Buffer) => this.bufferOutput(pid, decodeOutput(data)));
      child.stderr?.on('data', (data: Buffer) => this.bufferOutput(pid, decodeOutput(data)));

      child.on('exit', (code: number | null) => {
        try {
          this.flushOutput(pid);
          this.emit('exit', { pid, code: code ?? 0 });
        } finally {
          this.sessions.delete(pid);
          this.outputBuffer.delete(pid);
        }
      });

      child.on('error', (err: Error) => {
        try {
          this.bufferOutput(pid, `\r\n[ERROR] ${err.message}\r\n`);
          this.flushOutput(pid);
          this.emit('exit', { pid, code: 1 });
        } catch {
          /* 关闭竞态下原生句柄可能已销毁，静默忽略 */
        } finally {
          this.sessions.delete(pid);
          this.outputBuffer.delete(pid);
        }
      });

      return { success: true, pid };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private bufferOutput(pid: number, data: string): void {
    const buffer = this.outputBuffer.get(pid);
    if (buffer) {
      buffer.push(data);
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flushAll(), 50);
      }
    }
  }

  private flushAll(): void {
    this.flushTimer = null;
    for (const [pid, buffer] of this.outputBuffer.entries()) {
      if (buffer.length > 0) {
        const data = buffer.join('');
        buffer.length = 0;
        this.emit('output', { pid, data });
      }
    }
  }

  private flushOutput(pid: number): void {
    const buffer = this.outputBuffer.get(pid);
    if (buffer && buffer.length > 0) {
      const data = buffer.join('');
      buffer.length = 0;
      this.emit('output', { pid, data });
    }
  }

  write(pid: number, data: string): void {
    const session = this.sessions.get(pid);
    if (session && session.child.stdin) {
      session.child.stdin.write(data);
    }
  }

  resize(pid: number, cols: number, rows: number): void {
    const session = this.sessions.get(pid);
    if (session) {
      session.cols = cols;
      session.rows = rows;
    }
  }

  kill(pid: number): void {
    const session = this.sessions.get(pid);
    if (session) {
      session.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.sessions.has(pid)) session.child.kill('SIGKILL');
      }, 2000);
    }
  }

  getActivePids(): number[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * 关掉工作目录落在 dirPath（含子目录）下的所有终端会话，返回关掉的数量。
   *
   * Windows 上目录改名会因「有进程把该目录当当前工作目录」而 EBUSY，
   * 而每个终端 shell 的 cwd 就是工作区根目录，所以任务改名/移动前必须先释放。
   * 用的是杀进程树：只 kill 直接子进程会留下真正持有 cwd 的 powershell/cmd 孙进程。
   */
  killByCwd(dirPath: string): number {
    if (!dirPath) return 0;
    const target = path.resolve(dirPath);
    const isWin = process.platform === 'win32';
    let closed = 0;
    for (const [pid, session] of Array.from(this.sessions.entries())) {
      let cwd = '';
      try {
        cwd = path.resolve(session.cwd || '');
      } catch {
        continue;
      }
      if (cwd !== target && !cwd.startsWith(target + path.sep)) continue;
      killProcessTree(session.child, isWin);
      this.sessions.delete(pid);
      this.outputBuffer.delete(pid);
      closed += 1;
    }
    return closed;
  }

  /**
   * 单条命令捕获输出的字符上限。
   *
   * 为什么必须有：Agent 经常发出「全盘扫描」类命令（例如 Get-ChildItem C:\ -Recurse、
   * dir /s、where /r 之类），输出动辄几十万行。此前这里是无限累积 `stdout += chunk`：
   * 主进程内存被撑到 GB 级 → 这段巨型字符串还要经 IPC 结构化复制进渲染进程、
   * 再被塞进 DOM 文本节点 → 两个进程一起被拖死，表现出来就是「运行任务时整窗白屏」。
   * 超限后只保留前 N 字符并标记 truncated，剩余内容边读边丢（管道必须继续读空，
   * 否则子进程会因 stdout 缓冲区写满而卡住不退出）。
   */
  private static readonly MAX_CAPTURE_CHARS = 400_000;

  /** 允许设置项把上限压得更低，但不允许无上限（下限 1 万字符，防止设成 0 后一屏都看不到） */
  private static readonly MIN_CAPTURE_CHARS = 10_000;
  private static readonly HARD_CAPTURE_CHARS = 5_000_000;

  /** 把外部传入的上限收敛到安全区间；未传或非法时退回默认值 */
  private static resolveMaxChars(v?: number): number {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return TerminalAdapter.MAX_CAPTURE_CHARS;
    return Math.min(TerminalAdapter.HARD_CAPTURE_CHARS, Math.max(TerminalAdapter.MIN_CAPTURE_CHARS, Math.floor(n)));
  }

  async exec(
    cmd: string,
    cwd: string,
    timeout: number = 30000,
    signal?: AbortSignal,
    opts?: {
      /** 本次命令的输出上限（字符），默认 MAX_CAPTURE_CHARS；由设置项覆盖 */
      maxChars?: number;
      /** 每收到一段已解码输出就回调一次（用于实时进度识别，回调异常不影响采集） */
      onChunk?: (text: string, isStdout: boolean) => void;
    },
  ): Promise<ExecResult> {
    if (signal?.aborted) return { success: false, error: '已中止' };
    const isWin = process.platform === 'win32';
    let shell: string;
    let shellArgs: string[];
    if (isWin) {
      // 用 -EncodedCommand (UTF-16LE Base64) 传递完整脚本，彻底规避单/双引号、$、反引号、% 等字符在 -Command 拼接时的转义陷阱
      const psScript =
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
        '[Console]::InputEncoding=[Text.Encoding]::UTF8; ' +
        '$OutputEncoding=[Text.Encoding]::UTF8; ' +
        cmd;
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      shell = 'powershell.exe';
      shellArgs = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
    } else {
      shell = '/bin/bash';
      shellArgs = ['-c', cmd];
    }
    return this.runCaptured(shell, shellArgs, { cwd, timeout, signal, ...opts });
  }

  /**
   * 直接执行一个可执行文件（不经 shell）。
   *
   * run_python 必须走这里：脚本路径、参数里常带空格 / 引号 / 中文，一旦经
   * PowerShell 字符串拼接就要处理多层转义，既容易出错又会污染 argv。
   * 输出上限、实时回调、超时与进程树清理与 exec 完全一致。
   */
  async execProgram(
    file: string,
    args: string[],
    opts?: {
      cwd?: string;
      timeout?: number;
      signal?: AbortSignal;
      maxChars?: number;
      onChunk?: (text: string, isStdout: boolean) => void;
      /** 追加的环境变量（Electron 注入变量仍会被清洗掉） */
      env?: Record<string, string>;
    },
  ): Promise<ExecResult> {
    if (opts?.signal?.aborted) return { success: false, error: '已中止' };
    return this.runCaptured(file, args, opts || {});
  }

  /** exec / execProgram 的共同实现：派生 → 采集（带上限）→ 收尾 */
  private runCaptured(
    file: string,
    args: string[],
    o: {
      cwd?: string;
      timeout?: number;
      signal?: AbortSignal;
      maxChars?: number;
      onChunk?: (text: string, isStdout: boolean) => void;
      env?: Record<string, string>;
    },
  ): Promise<ExecResult> {
    const MAX_CAPTURE_CHARS = TerminalAdapter.resolveMaxChars(o.maxChars);
    const timeout = o.timeout ?? 30000;
    const signal = o.signal;
    const isWin = process.platform === 'win32';
    return new Promise((resolve) => {
      // Python 相关环境变量：缺了 PYTHONUNBUFFERED，管道下的 stdout 是块缓冲，
      // PROGRESS 进度行要攒满缓冲区才吐出来，前端进度条会长时间不动。
      const env: Record<string, string> = {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        ...(o.env || {}),
      };
      const child = spawnSafe(file, args, { cwd: o.cwd, windowsHide: true, env });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let droppedChars = 0;
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      /**
       * 累积子进程输出（带上限）。
       * 超限后连 decodeOutput 都不做 —— 它是逐字节 UTF-8 合法性校验，几十 MB 数据光校验
       * 就能把主进程 CPU 打满；这里只保留前 MAX_CAPTURE_CHARS 字符，其余边读边丢。
       */
      const appendOutput = (isStdout: boolean, data: Buffer): void => {
        if (settled) return;
        const current = isStdout ? stdout : stderr;
        const room = MAX_CAPTURE_CHARS - current.length;
        if (room <= 0) {
          truncated = true;
          droppedChars += data.length;
          return;
        }
        const text = decodeOutput(data);
        if (text.length > room) {
          truncated = true;
          droppedChars += text.length - room;
          if (isStdout) stdout = current + text.slice(0, room);
          else stderr = current + text.slice(0, room);
          return;
        }
        if (isStdout) stdout = current + text;
        else stderr = current + text;
        // 实时输出回调：供上层识别 PROGRESS 进度标记；异常由调用方保证不影响采集
        try {
          o.onChunk?.(text, isStdout);
        } catch {
          /* 回调异常不应中断输出采集 */
        }
      };

      child.stdout?.on('data', (data: Buffer) => appendOutput(true, data));
      child.stderr?.on('data', (data: Buffer) => appendOutput(false, data));

      const finish = (r: {
        success: boolean;
        stdout?: string;
        stderr?: string;
        error?: string;
        truncated?: boolean;
        droppedChars?: number;
      }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // 收尾：把残留监听摘掉，避免子进程树还没死透时继续往局部变量里堆字符串
        try {
          child.stdout?.removeAllListeners('data');
          child.stderr?.removeAllListeners('data');
        } catch {
          /* 句柄可能已销毁 */
        }
        if (truncated) {
          r.truncated = true;
          r.droppedChars = droppedChars;
        }
        resolve(r);
      };

      // 用户点「停止」/ 任务取消：连同子进程树一起杀掉，否则 powershell 下的孙进程会残留
      const onAbort = () => {
        killProcessTree(child, isWin);
        finish({ success: false, stdout, stderr, error: '已中止' });
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code: number | null) => {
        finish(code === 0 ? { success: true, stdout, stderr } : { success: false, stdout, stderr, error: `Exit code: ${code}` });
      });

      child.on('error', (err: Error) => {
        finish({ success: false, stdout, stderr, error: err.message });
      });

      if (timeout > 0) {
        timer = setTimeout(() => {
          killProcessTree(child, isWin);
          finish({ success: false, stdout, stderr, error: 'Timeout' });
        }, timeout);
      }
    });
  }

  dispose(): void {
    for (const [pid] of this.sessions) {
      this.kill(pid);
    }
    this.sessions.clear();
    this.outputBuffer.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
