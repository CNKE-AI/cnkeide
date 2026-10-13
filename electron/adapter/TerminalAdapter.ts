import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { spawnSafe, sanitizeEnv } from '../core-fork/util/SafeSpawn';

export interface TerminalSession {
  pid: number;
  child: ChildProcess;
  cwd: string;
  cols: number;
  rows: number;
}

/**
 * Windows 下子进程输出编码处理：
 * PowerShell/cmd 默认用系统代码页（GBK/936）输出，直接按 utf-8 解码会乱码。
 * 策略：
 * 1. 若字节流是合法 UTF-8（严格校验），直接按 UTF-8 解码；
 * 2. 否则按 GBK 解码（GBK 是兼容 ASCII 的双字节编码，特征为 0x81-0xFE + 0x40-0xFE）。
 */
function decodeOutput(buf: Buffer): string {
  // 严格 UTF-8 校验：任一非法序列即判定为非 UTF-8
  let i = 0;
  const len = buf.length;
  let validUtf8 = true;
  while (i < len) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    if (b >= 0xc2 && b <= 0xdf) {
      if (i + 1 >= len || (buf[i + 1] & 0xc0) !== 0x80) { validUtf8 = false; break; }
      i += 2; continue;
    }
    if (b >= 0xe0 && b <= 0xef) {
      if (i + 2 >= len || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) { validUtf8 = false; break; }
      // 排除过长编码 (overlong) 与代理区
      if (b === 0xe0 && buf[i + 1] < 0xa0) { validUtf8 = false; break; }
      if (b === 0xed && buf[i + 1] >= 0xa0) { validUtf8 = false; break; }
      i += 3; continue;
    }
    if (b >= 0xf0 && b <= 0xf4) {
      if (i + 3 >= len || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80 || (buf[i + 3] & 0xc0) !== 0x80) { validUtf8 = false; break; }
      if (b === 0xf0 && buf[i + 1] < 0x90) { validUtf8 = false; break; }
      if (b === 0xf4 && buf[i + 1] >= 0x90) { validUtf8 = false; break; }
      i += 4; continue;
    }
    // 0x80-0xC1、0xF5-0xFF 均为非法起始字节
    validUtf8 = false;
    break;
  }

  if (validUtf8) return buf.toString('utf-8');

  try {
    return new TextDecoder('gb18030').decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

/**
 * TerminalAdapter - 终端适配层
 * 替换 VSCode integrated terminal / shell execution API
 * 用 Node.js spawn 创建伪终端子进程
 */
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

  async exec(cmd: string, cwd: string, timeout: number = 30000): Promise<{ success: boolean; stdout?: string; stderr?: string; error?: string }> {
    return new Promise((resolve) => {
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
      const child = spawnSafe(shell, shellArgs, { cwd, windowsHide: true });

      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | null = null;

      child.stdout?.on('data', (data: Buffer) => { stdout += decodeOutput(data); });
      child.stderr?.on('data', (data: Buffer) => { stderr += decodeOutput(data); });

      child.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        resolve(code === 0 ? { success: true, stdout, stderr } : { success: false, stdout, stderr, error: `Exit code: ${code}` });
      });

      child.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        resolve({ success: false, stdout, stderr, error: err.message });
      });

      if (timeout > 0) {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ success: false, stdout, stderr, error: 'Timeout' });
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
