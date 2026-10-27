#!/usr/bin/env node
/**
 * CnkeIDE CLI（headless）
 *
 * 用法：
 *   cnkeide -p "把 README 里的 TODO 补完" --cwd ./repo
 *   echo "解释这个报错" | cnkeide --stdin --json
 *
 * 约定：
 *   - stdout 只输出协议数据（最终文本或 NDJSON），日志一律写 stderr
 *   - 退出码：0 成功 / 1 任务失败 / 2 用法错误 / 3 审批被拒 / 4 上下文超限 / 124 超时
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHeadlessAgent } from '../electron/headless/bootstrap';
import type { HeadlessApprovalPolicy } from '../electron/headless/bootstrap';
import type { AgentEvent, AgentMode } from '../electron/core-fork/agent/AgentManager';

/** 内核 usage 对象同时存在 snake_case（OpenAI 原生）与 camelCase（归一化后）两种写法 */
interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 工具结果既可能是结构化对象（{success,output,error}），也可能是拒绝时的纯字符串 */
type ToolResultLike =
  | string
  | { success?: boolean; output?: unknown; error?: unknown }
  | null
  | undefined;

declare const __CLI_VERSION__: string;

const VERSION = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev';

const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  APPROVAL_DENIED: 3,
  CONTEXT_LIMIT: 4,
  TIMEOUT: 124,
} as const;

interface CliOptions {
  prompt?: string;
  stdin: boolean;
  cwd: string;
  mode: AgentMode;
  model?: string;
  maxTurns?: number;
  approvePolicy: HeadlessApprovalPolicy;
  allowTools: string[];
  allowCommandPatterns: string[];
  json: boolean;
  finalOnly: boolean;
  noPersist: boolean;
  dataDir?: string;
  noMemory: boolean;
  mcp: boolean;
  timeoutSec?: number;
  verbose: boolean;
}

const VALID_MODES: AgentMode[] = ['ask', 'coder', 'architect', 'debugger'];
const VALID_POLICIES: HeadlessApprovalPolicy[] = ['never', 'untrusted', 'on-request'];

const HELP = `CnkeIDE CLI ${VERSION}

用法: cnkeide [选项]

输入
  -p, --prompt <text>        任务描述
      --stdin                从标准输入读取任务描述
      --cwd <dir>            工作区根目录（默认当前目录）

行为
      --mode <mode>          ask | craft | plan | debug（默认 craft）
      --model <id>           指定模型配置或模型名
      --max-turns <n>        Agent 最大轮次
      --timeout <sec>        整体超时（秒）

权限（默认 untrusted：只读自动放行，写入与命令需显式授权）
      --approve-policy <p>   never | untrusted | on-request
      --allow-tool <name>    额外允许的工具，可重复或逗号分隔
      --allow-command-pattern <regex>  允许执行的命令正则，可重复

输出
      --json                 NDJSON 事件流
      --final-only           仅输出最终结果
  -v, --verbose              输出调试信息到 stderr

存储
      --no-persist           无状态运行（数据写入临时目录）
      --data-dir <dir>       指定数据目录（默认 ~/.cnkeide）
      --no-memory            禁用本地记忆
      --mcp                  启用已配置的 MCP 服务器

  -h, --help                 显示帮助
  -V, --version              显示版本
`;

function log(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  const prefix = level === 'error' ? '错误' : level === 'warning' ? '警告' : '信息';
  process.stderr.write(`[${prefix}] ${message}\n`);
}

class UsageError extends Error {}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    stdin: false,
    cwd: process.cwd(),
    mode: 'coder',
    approvePolicy: 'untrusted',
    allowTools: [],
    allowCommandPatterns: [],
    json: false,
    finalOnly: false,
    noPersist: false,
    noMemory: false,
    mcp: false,
    verbose: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`参数 ${arg} 缺少取值`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '-p':
      case '--prompt':
        opts.prompt = next();
        break;
      case '--stdin':
        opts.stdin = true;
        break;
      case '--cwd':
        opts.cwd = path.resolve(next());
        break;
      case '--mode': {
        const raw = next();
        const map: Record<string, AgentMode> = {
          ask: 'ask',
          craft: 'coder',
          coder: 'coder',
          plan: 'architect',
          architect: 'architect',
          debug: 'debugger',
          debugger: 'debugger',
        };
        const mode = map[raw.toLowerCase()];
        if (!mode || !VALID_MODES.includes(mode)) {
          throw new UsageError(`未知模式 ${raw}，可选 ask | craft | plan | debug`);
        }
        opts.mode = mode;
        break;
      }
      case '--model':
        opts.model = next();
        break;
      case '--max-turns': {
        const value = Number(next());
        if (!Number.isFinite(value) || value <= 0) throw new UsageError('--max-turns 必须是正整数');
        opts.maxTurns = Math.floor(value);
        break;
      }
      case '--timeout': {
        const value = Number(next());
        if (!Number.isFinite(value) || value <= 0) throw new UsageError('--timeout 必须是正数');
        opts.timeoutSec = value;
        break;
      }
      case '--approve-policy': {
        const value = next() as HeadlessApprovalPolicy;
        if (!VALID_POLICIES.includes(value)) {
          throw new UsageError(`未知授权策略 ${value}，可选 never | untrusted | on-request`);
        }
        opts.approvePolicy = value;
        break;
      }
      case '--allow-tool':
        opts.allowTools.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--allow-command-pattern':
        opts.allowCommandPatterns.push(next());
        break;
      case '--json':
        opts.json = true;
        break;
      case '--final-only':
        opts.finalOnly = true;
        break;
      case '--no-persist':
        opts.noPersist = true;
        break;
      case '--data-dir':
        opts.dataDir = path.resolve(next());
        break;
      case '--no-memory':
        opts.noMemory = true;
        break;
      case '--mcp':
        opts.mcp = true;
        break;
      case '-v':
      case '--verbose':
        opts.verbose = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(HELP);
        process.exit(EXIT.OK);
        break;
      case '-V':
      case '--version':
        process.stdout.write(`${VERSION}\n`);
        process.exit(EXIT.OK);
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`未知参数 ${arg}`);
        positional.push(arg);
    }
  }

  if (!opts.prompt && positional.length > 0) opts.prompt = positional.join(' ');
  return opts;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function classifyExitCode(error: string | undefined, timedOut: boolean): number {
  if (timedOut) return EXIT.TIMEOUT;
  const message = (error || '').toLowerCase();
  if (!message) return EXIT.FAILED;
  if (message.includes('拒绝') || message.includes('approval') || message.includes('denied')) {
    return EXIT.APPROVAL_DENIED;
  }
  if (message.includes('上下文') || message.includes('context') || message.includes('token')) {
    return EXIT.CONTEXT_LIMIT;
  }
  return EXIT.FAILED;
}

async function main(): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    log((err as Error).message, 'error');
    process.stderr.write('\n运行 cnkeide --help 查看用法\n');
    return EXIT.USAGE;
  }

  const stdinText = opts.stdin ? await readStdin() : '';
  const prompt = [opts.prompt, stdinText].filter((s) => s && s.trim()).join('\n\n').trim();
  if (!prompt) {
    log('缺少任务描述，请使用 -p/--prompt 或 --stdin', 'error');
    return EXIT.USAGE;
  }

  const sessionId = randomUUID();
  let runtime;
  try {
    runtime = await createHeadlessAgent({
      workspaceDir: opts.cwd,
      dataDir: opts.dataDir,
      noPersist: opts.noPersist,
      mode: opts.mode,
      model: opts.model,
      maxTurns: opts.maxTurns,
      approvalPolicy: opts.approvePolicy,
      allowTools: opts.allowTools,
      allowCommandPatterns: opts.allowCommandPatterns,
      enableMcp: opts.mcp,
      enableMemory: !opts.noMemory,
      log: opts.verbose ? (message, level) => log(message, level) : undefined,
    });
  } catch (err) {
    log(`初始化失败: ${(err as Error).message}`, 'error');
    return EXIT.FAILED;
  }

  let timedOut = false;
  let finalContent = '';
  // 用对象容器而非裸 let：闭包内赋值不参与外部控制流分析，裸 let 会被收窄成 null
  const usageRef: { value: UsageLike | null } = { value: null };

  const timer = opts.timeoutSec
    ? setTimeout(() => {
        timedOut = true;
        log(`执行超时（${opts.timeoutSec}s），正在中止`, 'warning');
        runtime.agent.abort(sessionId);
      }, opts.timeoutSec * 1000)
    : null;

  const onInterrupt = (): void => {
    log('收到中断信号，正在中止', 'warning');
    runtime.agent.abort(sessionId);
  };
  process.on('SIGINT', onInterrupt);

  if (opts.json) {
    emitJson({ type: 'run_start', sessionId, mode: opts.mode, cwd: runtime.workspaceDir, version: VERSION });
  } else if (opts.verbose) {
    log(`工作区 ${runtime.workspaceDir} / 模式 ${opts.mode} / 会话 ${sessionId.slice(0, 8)}`);
  }

  const result = await runtime.agent.run(
    {
      sessionId,
      workspaceId: runtime.workspaceDir,
      prompt,
      history: [],
      mode: opts.mode,
      model: opts.model,
      autoApprove: opts.approvePolicy === 'never',
    },
    (event: AgentEvent) => {
      const data = event?.data ?? {};
      switch (event?.type) {
        case 'stream': {
          if (opts.json) {
            emitJson({ type: 'assistant_delta', text: data.delta ?? '' });
          } else if (!opts.finalOnly) {
            process.stdout.write(data.delta ?? '');
          }
          break;
        }
        case 'thinking': {
          if (opts.json) emitJson({ type: 'thinking', text: data.thinking ?? '' });
          else if (opts.verbose) log(`思考: ${String(data.thinking ?? '').slice(0, 160)}`);
          break;
        }
        case 'tool_call': {
          if (opts.json) {
            emitJson({ type: 'tool_call', id: data.id, name: data.name, args: data.arguments });
          } else {
            log(`调用工具 ${data.name}`);
          }
          break;
        }
        case 'tool_result': {
          // ToolManager 正常返回结构化对象 {success, output, error}，拒绝时为字符串，
          // 直接 String() 会得到 "[object Object]"，必须显式取字段。
          const raw = data.result as ToolResultLike;
          const output =
            typeof raw === 'string'
              ? raw
              : String(raw?.output ?? raw?.error ?? (raw === undefined || raw === null ? '' : JSON.stringify(raw)));
          const ok =
            raw && typeof raw === 'object' && 'success' in raw
              ? raw.success !== false
              : !/^错误|^失败|^error/i.test(output);
          if (opts.json) {
            emitJson({
              type: 'tool_result',
              id: data.toolCallId,
              ok,
              output: output.slice(0, 4000),
            });
          } else if (opts.verbose) {
            log(`工具结果: ${output.slice(0, 200)}`);
          }
          break;
        }
        case 'assistant': {
          finalContent = String(data.content ?? '');
          break;
        }
        case 'context_state': {
          if (opts.json) {
            emitJson({
              type: 'context_state',
              promptTokens: data.promptTokens,
              completionTokens: data.completionTokens,
              ratio: data.maxContextTokens
                ? Number((data.currentChars ?? 0) / data.maxContextTokens)
                : undefined,
            });
          }
          break;
        }
        case 'context_compressed': {
          if (opts.json) emitJson({ type: 'context_compressed', ...data });
          break;
        }
        case 'error': {
          if (opts.json) emitJson({ type: 'error', message: data.error ?? '未知错误' });
          else log(String(data.error ?? '未知错误'), 'error');
          break;
        }
        case 'done': {
          usageRef.value = (data.usage as UsageLike | null) ?? null;
          break;
        }
        default:
          break;
      }
    },
  );

  if (timer) clearTimeout(timer);
  process.off('SIGINT', onInterrupt);
  await runtime.dispose();

  const exitCode = result.success
    ? EXIT.OK
    : result.aborted && !timedOut
      ? EXIT.OK
      : classifyExitCode(result.error, timedOut);

  if (opts.json) {
    const usage = usageRef.value;
    if (usage) {
      emitJson({
        type: 'usage',
        promptTokens: usage.prompt_tokens ?? usage.promptTokens,
        completionTokens: usage.completion_tokens ?? usage.completionTokens,
      });
    }
    emitJson({
      type: 'run_end',
      status: result.success ? 'success' : timedOut ? 'timeout' : 'failed',
      exitCode,
      content: finalContent,
      error: result.error,
    });
  } else {
    if (opts.finalOnly && finalContent) process.stdout.write(finalContent);
    process.stdout.write('\n');
    if (!result.success && result.error) log(result.error, 'error');
  }

  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
    // 部分底层资源（MCP 子进程、文件监听）可能保持句柄，显式退出保证 CI 不会挂起
    setTimeout(() => process.exit(code), 50).unref();
  })
  .catch((err) => {
    log(`未捕获异常: ${(err as Error)?.stack || String(err)}`, 'error');
    process.exit(EXIT.FAILED);
  });
