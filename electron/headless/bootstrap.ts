import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { AgentManager } from '../core-fork/agent/AgentManager';
import type { AgentMode } from '../core-fork/agent/AgentManager';
import { ConfigAdapter } from '../adapter/ConfigAdapter';
import { FileSystemAdapter } from '../adapter/FileSystemAdapter';
import { TerminalAdapter } from '../adapter/TerminalAdapter';
import { StorageAdapter } from '../adapter/StorageAdapter';
import { CheckpointManager } from '../core-fork/checkpoint/CheckpointManager';
import { CodebaseIndexer } from '../core-fork/codebase/CodebaseIndexer';
import { MemoryStore } from '../core-fork/memory/MemoryStore';
import { PlanManager } from '../core-fork/plan/PlanManager';
import { RagManager } from '../core-fork/rag/RagManager';
import { SkillRegistry } from '../core-fork/skills/SkillRegistry';
import { McpHub } from '../core-fork/mcp/McpHub';
import { HeadlessWindowAdapter } from './HeadlessWindowAdapter';
import type { HeadlessLogLevel } from './HeadlessWindowAdapter';
import type { WindowAdapter } from '../adapter/WindowAdapter';
import { resolveUserDataDir } from '../util/paths';

/** headless 审批策略 */
export type HeadlessApprovalPolicy = 'never' | 'untrusted' | 'on-request';

/** 只读工具：untrusted 策略下自动放行 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'search_files',
  'list_directory',
  'get_file_outline',
  'grep',
  'semantic_search',
  'search_symbol',
  'find_references',
  'project_structure',
  'web_search',
  'web_fetch',
  'git_status',
  'git_diff',
  'git_log',
  'get_plan',
  'doc_list',
  'doc_query',
]);

export interface HeadlessBootstrapOptions {
  /** 目标工作区（仓库根目录） */
  workspaceDir: string;
  /** 数据目录；默认 ~/.cnkeide（与 GUI 的 userData 隔离） */
  dataDir?: string;
  /** 无状态模式：数据写入临时目录，进程结束即丢弃 */
  noPersist?: boolean;
  mode?: AgentMode;
  /** 显式覆盖模型配置 ID / 模型名 */
  model?: string;
  /** 最大 Agent 轮次 */
  maxTurns?: number;
  approvalPolicy?: HeadlessApprovalPolicy;
  /** 额外允许的工具名 */
  allowTools?: string[];
  /** execute_command 允许的命令正则（字符串形式） */
  allowCommandPatterns?: string[];
  /** 执行权限档位（read-only 时写文件/执行命令会被内核直接拦掉） */
  permissionMode?: 'read-only' | 'standard' | 'full-access';
  /** 启用 MCP 服务器（默认关闭，避免 CLI 拉起用户配置的常驻进程） */
  enableMcp?: boolean;
  /** 启用本地记忆（默认开启；noPersist 时关闭） */
  enableMemory?: boolean;
  log?: (message: string, level: HeadlessLogLevel) => void;
}

export interface HeadlessRuntime {
  agent: AgentManager;
  config: ConfigAdapter;
  fsAdapter: FileSystemAdapter;
  terminalAdapter: TerminalAdapter;
  checkpointManager: CheckpointManager;
  skillRegistry: SkillRegistry;
  mcpHub: McpHub;
  workspaceDir: string;
  dataDir: string;
  /** 落盘配置并释放资源 */
  dispose: () => Promise<void>;
}

function buildApprovalHandler(options: HeadlessBootstrapOptions) {
  const policy = options.approvalPolicy ?? 'untrusted';
  const allowTools = new Set(options.allowTools ?? []);
  const commandPatterns = (options.allowCommandPatterns ?? [])
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch {
        return null;
      }
    })
    .filter((re): re is RegExp => !!re);

  return (toolCall: any): boolean => {
    const name = String(toolCall?.name ?? '');
    // full-access 档位等价于"不再问"，否则 CLI 里 full-access 还得再叠一个 --approve-policy never
    if (policy === 'never' || options.permissionMode === 'full-access') return true;
    if (allowTools.has(name) || allowTools.has('*')) return true;
    if (READ_ONLY_TOOLS.has(name)) return true;

    if (name === 'execute_command') {
      const command = String(toolCall?.arguments?.command ?? '');
      return commandPatterns.some((re) => re.test(command));
    }

    // untrusted / on-request（无交互终端）统一拒绝：宁可失败也不静默写入
    return false;
  };
}

/**
 * 组装一个可在纯 Node 进程运行的 Agent 运行时。
 * 与 GUI 共用同一套 core-fork 内核，差别仅在 adapter 实现。
 */
export async function createHeadlessAgent(options: HeadlessBootstrapOptions): Promise<HeadlessRuntime> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const dataDir = options.noPersist
    ? path.join(os.tmpdir(), `cnkeide-cli-${process.pid}-${randomUUID().slice(0, 8)}`)
    : options.dataDir
      ? path.resolve(options.dataDir)
      : resolveUserDataDir();

  const config = new ConfigAdapter(dataDir);
  await config.init();

  const fsAdapter = new FileSystemAdapter();
  const terminalAdapter = new TerminalAdapter();
  const storage = new StorageAdapter(dataDir);
  await storage.init();

  const checkpointManager = new CheckpointManager(path.join(dataDir, 'checkpoints'));
  const codebaseIndexer = new CodebaseIndexer({ rootPath: workspaceDir });
  const planManager = new PlanManager();
  const ragManager = new RagManager();

  const skillRegistry = new SkillRegistry({ appPath: workspaceDir, cwd: workspaceDir });
  await skillRegistry.scan();

  const mcpHub = new McpHub(config);
  if (options.enableMcp) {
    try {
      await mcpHub.startEnabledServers();
    } catch (err) {
      options.log?.(`MCP 启动失败：${(err as Error).message}`, 'warning');
    }
  }

  const enableMemory = options.enableMemory ?? !options.noPersist;
  const memoryStore = enableMemory ? new MemoryStore(storage) : undefined;

  // 运行期覆盖：模式/轮次/档位只影响本次运行。
  // 必须深拷贝再走 setRuntimeOverride：直接改 config.get() 返回的对象会污染内存里的
  // config.data，退出时 flush 就会把一次性参数写进 GUI 配置（例如跑一次只读模式后永久只读）。
  const agentConfig: any = JSON.parse(JSON.stringify(config.get('agentConfig') ?? {}));
  if (options.mode) agentConfig.mode = options.mode;
  if (options.maxTurns && options.maxTurns > 0) agentConfig.maxTurns = options.maxTurns;
  // --permission：档位只影响本次运行，不写回配置文件
  if (options.permissionMode) agentConfig.permissionMode = options.permissionMode;

  // --model：按配置 ID 或模型名锁定模型，并关闭自动路由（否则首轮会被路由决策覆盖）
  if (options.model) {
    const wanted = options.model.trim();
    const configs: any[] = config.getApiKeyConfigs() ?? [];
    const matched =
      configs.find((c) => c?.id === wanted) ||
      configs.find((c) => c?.model === wanted) ||
      configs.find((c) => typeof c?.model === 'string' && c.model.toLowerCase().includes(wanted.toLowerCase()));
    if (!matched) {
      throw new Error(`找不到模型配置 "${wanted}"，可用 --data-dir 指定已有配置目录`);
    }
    // 同样只覆盖本次运行：命令行指定模型不应该改掉桌面端的当前选中模型
    config.setRuntimeOverride('activeApiConfigId', matched.id);
    agentConfig.enableRouting = false;
  }

  config.setRuntimeOverride('agentConfig', agentConfig);

  const windowAdapter = new HeadlessWindowAdapter({ log: options.log });

  const agent = new AgentManager({
    fsAdapter,
    terminalAdapter,
    mcpHub,
    windowAdapter: windowAdapter as unknown as WindowAdapter,
    config,
    checkpointManager,
    codebaseIndexer,
    memoryStore,
    planManager,
    ragManager,
    skillRegistry,
  });

  agent.setApprovalHandler(buildApprovalHandler(options));

  const dispose = async (): Promise<void> => {
    try {
      mcpHub.dispose();
    } catch {
      /* 忽略关闭异常 */
    }
    try {
      await config.flush();
    } catch {
      /* 忽略刷盘异常 */
    }
  };

  return {
    agent,
    config,
    fsAdapter,
    terminalAdapter,
    checkpointManager,
    skillRegistry,
    mcpHub,
    workspaceDir,
    dataDir,
    dispose,
  };
}
