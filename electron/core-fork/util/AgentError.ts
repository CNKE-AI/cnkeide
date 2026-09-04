/**
 * AgentError - 标准化错误类型（W9）
 *
 * 目标：
 * 1. 让 AgentManager 关键路径抛 AgentError 而非裸 Error
 * 2. 错误可分类（code）便于 UI 展示 / 自动恢复
 * 3. 保留原始错误（cause）便于排查
 *
 * 错误码（ECode）：
 * - LLM_*    LLM 调用相关
 * - TOOL_*   工具执行相关
 * - PLAN_*   Plan 相关
 * - CFG_*    配置相关
 * - FS_*     文件系统
 * - CKP_*    Checkpoint 相关
 */

export type ErrorCode =
  // LLM
  | 'LLM_NOT_CONFIGURED'
  | 'LLM_TIMEOUT'
  | 'LLM_ABORTED'
  | 'LLM_RATE_LIMIT'
  | 'LLM_AUTH'
  | 'LLM_INVALID_RESPONSE'
  | 'LLM_ALL_FALLBACKS_FAILED'
  // Tool
  | 'TOOL_UNKNOWN'
  | 'TOOL_INVALID_ARGS'
  | 'TOOL_EXEC_FAILED'
  | 'TOOL_PERMISSION_DENIED'
  | 'TOOL_APPROVAL_TIMEOUT'
  | 'TOOL_APPROVAL_DENIED'
  // Plan
  | 'PLAN_INVALID_STATE'
  | 'PLAN_ITEM_NOT_FOUND'
  // Config
  | 'CFG_NO_ACTIVE_API'
  | 'CFG_INVALID'
  // Filesystem
  | 'FS_FILE_NOT_FOUND'
  | 'FS_PERMISSION_DENIED'
  | 'FS_DISK_FULL'
  // Checkpoint
  | 'CKP_NOT_FOUND'
  | 'CKP_RESTORE_FAILED'
  // Generic
  | 'UNKNOWN';

export class AgentError extends Error {
  public readonly code: ErrorCode;
  public readonly recoverable: boolean;
  public readonly details?: Record<string, any>;
  public readonly cause?: Error;
  public readonly timestamp: number;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    recoverable?: boolean;
    details?: Record<string, any>;
    cause?: Error;
  }) {
    super(opts.message);
    this.name = 'AgentError';
    this.code = opts.code;
    this.recoverable = opts.recoverable ?? false;
    this.details = opts.details;
    this.cause = opts.cause;
    this.timestamp = Date.now();
  }

  /** 转 JSON（用于 IPC 传输 / 日志） */
  toJSON(): {
    name: string;
    code: ErrorCode;
    message: string;
    recoverable: boolean;
    details?: Record<string, any>;
    cause?: string;
    timestamp: number;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      details: this.details,
      cause: this.cause?.message,
      timestamp: this.timestamp,
    };
  }

  /** 包装任意错误为 AgentError（保持堆栈） */
  static from(err: unknown, code: ErrorCode = 'UNKNOWN', message?: string): AgentError {
    if (err instanceof AgentError) return err;
    if (err instanceof Error) {
      return new AgentError({
        code,
        message: message || err.message,
        cause: err,
      });
    }
    return new AgentError({
      code,
      message: message || String(err),
    });
  }

  /** 用户友好的展示文本 */
  get displayMessage(): string {
    const prefix = this.recoverable ? '⚠️' : '❌';
    return `${prefix} [${this.code}] ${this.message}`;
  }
}

/** 是否为不可重试错误（用于上层重试决策） */
export function isNonRetryable(err: unknown): boolean {
  if (err instanceof AgentError) {
    return ['LLM_AUTH', 'TOOL_PERMISSION_DENIED', 'TOOL_APPROVAL_DENIED', 'FS_PERMISSION_DENIED', 'CFG_NO_ACTIVE_API'].includes(err.code);
  }
  return false;
}
