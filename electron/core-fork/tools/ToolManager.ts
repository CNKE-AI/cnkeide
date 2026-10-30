import { FileSystemAdapter } from '../../adapter/FileSystemAdapter';
import { TerminalAdapter } from '../../adapter/TerminalAdapter';
import { McpHub } from '../mcp/McpHub';
import { CheckpointManager } from '../checkpoint/CheckpointManager';
import { CodebaseIndexer } from '../codebase/CodebaseIndexer';
import { webSearch, webFetch } from './WebTools';
import {
  gitStatus,
  gitDiff,
  gitCommit,
  gitLog,
  isGitRepo,
  gitBranch,
  gitCheckout,
  gitFetch,
  gitPull,
  gitPush,
} from './GitTools';
import { grep, isRipgrepAvailable } from './GrepTool';
import { detectTestFramework, runTests } from './TestRunner';
import { detectFormatter, formatCode } from './CodeFormatter';
import { SemanticRetriever } from '../codebase/SemanticRetriever';
import { RagManager } from '../rag/RagManager';
import { PlaywrightAdapter, MockPlaywrightAdapter, createRealPlaywrightAdapter } from './PlaywrightTools';
import { ImageGenAdapter, MockImageGenAdapter, OpenAIImageGenAdapter } from './ImageGenTools';
import { parseProgress, type ToolProgress } from './progress';
import { resolvePython } from '../python/PythonRuntime';
import { parsePythonTraceback, type PythonTracebackMeta } from '../python/traceback';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
}

/**
 * W8：子 Agent 委派工具。
 * 该工具不在本类的 execute() 里实现——它需要独立的多轮 LLM 循环，
 * 由 AgentManager 在工具执行处拦截后交给 SubAgentManager 处理。
 * 常量放在这里，避免 AgentManager 与 ToolManager 互相 import 形成循环依赖。
 */
export const SUBAGENT_TOOL_NAME = 'delegate_subagent';

/**
 * W27：测试自愈工具。
 * 与委派同理——需要"跑测试 → 调 LLM 改代码 → 再跑"的多轮循环，
 * execute() 承载不了，由 AgentManager 拦截后交给 AutoFixLoop。
 */
export const AUTOFIX_TOOL_NAME = 'auto_fix_tests';

/** W12 浏览器工具名集合：仅在真实 Playwright 就绪时才投递给模型 */
const BROWSER_TOOL_NAMES = new Set([
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_input',
  'browser_extract',
  'browser_close',
]);

/**
 * 跨平台路径拼接：模型在 Windows 上也可能给出 posix 风格（src/a.ts），
 * 直接用 path.join 在 Windows 上没问题，但在 POSIX 上遇到 Windows 风格分隔符会出错。
 * 这里统一先把分隔符归一化再拼接，保证两种风格混用都能落到正确位置。
 */
function pathLikeJoin(base: string, rel: string): string {
  const normalized = rel.replace(/[\\/]+/g, '/');
  const joined = path.join(base, normalized);
  // Windows 上 path.join 会输出反斜杠，正好符合 Node fs 的期望
  return joined;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  /**
   * 变更审查元数据（W18）：仅写操作工具填充。
   * 供前端渲染 diff 与一键回滚；回填 LLM messages 前会被 AgentManager 剥离，
   * 避免 before/after 全文撑爆上下文。
   */
  diff?: {
    /** 目标文件绝对路径 */
    path: string;
    /** 修改前内容；新建文件为 undefined */
    before?: string;
    /** 修改后内容；删除文件为 undefined */
    after?: string;
  };
  /**
   * Python traceback 结构化信息（仅 run_python 失败时填充）。
   * 只供前端做「跳转到出错行」，不进 LLM 上下文（AgentManager 会剥离）。
   */
  errorMeta?: PythonTracebackMeta;
}

export type { ToolProgress } from './progress';
export type { PythonTracebackMeta } from '../python/traceback';

export interface ToolManagerConfig {
  fsAdapter: FileSystemAdapter;
  terminalAdapter: TerminalAdapter;
  mcpHub: McpHub;
  checkpointManager: CheckpointManager;
  codebaseIndexer: CodebaseIndexer;
  /** W3 新增：可选的 PlanManager，未注入时 plan 工具不可用 */
  planManager?: import('../plan/PlanManager').PlanManager;
  /** W5：可选 ConfigAdapter，semantic_search 用它读 active API 与 embedding model */
  config?: any;
  /** W10：可选 RagManager，doc_query 工具用 */
  ragManager?: RagManager;
}

/**
 * ToolManager - 全套工具链管理器
 * 移植自 Roo-Code Core 工具系统
 * 内置快照回滚：写操作前自动快照，支持一键回滚
 */
export class ToolManager {
  private fsAdapter: FileSystemAdapter;
  private terminalAdapter: TerminalAdapter;
  private mcpHub: McpHub;
  private checkpointManager: CheckpointManager;
  private codebaseIndexer: CodebaseIndexer;
  /** W3 新增：PlanManager（可选） */
  private planManager?: import('../plan/PlanManager').PlanManager;
  /** W5：ConfigAdapter 可选，semantic_search 用 */
  private config?: any;
  /** W10：RagManager 可选 */
  private ragManager?: RagManager;
  /** W12：Playwright 浏览器自动化适配器（可选，未安装 playwright 时为 Mock） */
  private playwright?: PlaywrightAdapter;
  /** W12：图片生成适配器（可选，未配置时为 Mock） */
  private imageGen?: ImageGenAdapter;
  /**
   * 真实 Playwright 是否就绪。
   * 为 false 时浏览器工具不会投递给模型：MockPlaywrightAdapter 的每个方法都直接抛
   * 「Playwright 未启用」，把它们列在工具表里只会让模型白跑一轮再收到无用报错。
   */
  private browserReady = false;
  /** 图片生成适配器是否真正可用（Mock 的 generate() 固定返回失败，故同样不投递） */
  private imageGenReady = false;
  /** 当前会话上下文（sessionId + 工作区），用于快照归属与回滚 */
  private sessionId: string | null = null;
  private workspaceId: string | null = null;
  /** 本次会话中已修改的文件集合 */
  private modifiedFiles: Set<string> = new Set();
  /** W5 缓存：按工作区缓存 SemanticRetriever 实例 */
  private retrievers: Map<string, import('../codebase/SemanticRetriever').SemanticRetriever> = new Map();

  constructor(config: ToolManagerConfig) {
    this.fsAdapter = config.fsAdapter;
    this.terminalAdapter = config.terminalAdapter;
    this.mcpHub = config.mcpHub;
    this.checkpointManager = config.checkpointManager;
    this.codebaseIndexer = config.codebaseIndexer;
    this.planManager = config.planManager;
    this.config = config.config;
    this.ragManager = config.ragManager;
  }

  /** 设置当前会话上下文，供快照归属使用 */
  setSessionContext(sessionId: string, workspaceId: string): void {
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;
    this.modifiedFiles.clear();
  }

  /**
   * 把模型给出的路径解析为绝对路径。
   *
   * 模型天然倾向输出相对路径（src/index.ts、"src"、"."），而 fsAdapter 只认绝对路径，
   * 直接透传会让所有相对路径调用报 ENOENT —— 这就是「识别不了工作区」的直接原因。
   * 规则：
   *   - 已经是绝对路径 → 原样返回
   *   - 相对路径 → 以当前工作区根目录为基准拼接
   *   - 没有工作区 → 原样返回，交由底层报错（附带清晰错误信息由调用方给出）
   */
  private resolvePath(p: string): string {
    const raw = String(p ?? '').trim();
    if (!raw) return this.workspaceId || raw;
    // Windows 盘符绝对路径（C:\ / C:/）或 UNC（\\server\share）
    const isWinAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
    // POSIX 绝对路径
    const isPosixAbs = raw.startsWith('/');
    if (isWinAbs || isPosixAbs) return raw;
    const base = this.workspaceId || '';
    if (!base) return raw;
    // 去掉开头的 ./，避免 path.join 产生冗余段
    const cleaned = raw.replace(/^\.[\\/]/, '');
    if (cleaned === '.') return base;
    return pathLikeJoin(base, cleaned);
  }

  /** 本次会话修改过的文件（用于回滚/展示） */
  getModifiedFiles(): string[] {
    return Array.from(this.modifiedFiles);
  }

  /** W5：获取/创建指定工作区的 SemanticRetriever（缓存） */
  getOrCreateRetriever(rootPath: string): SemanticRetriever {
    let ret = this.retrievers.get(rootPath);
    if (!ret) {
      ret = new SemanticRetriever(rootPath);
      this.retrievers.set(rootPath, ret);
    }
    return ret;
  }

  /** W12：启用 Playwright 浏览器自动化（异步检测是否安装） */
  async enablePlaywright(): Promise<boolean> {
    const a = await createRealPlaywrightAdapter();
    if (a) {
      this.playwright = a;
      this.browserReady = true;
      return true;
    }
    // 保留 Mock 实例，这样即使被绕过调用也能返回明确的「未启用」而不是 undefined 崩溃
    this.playwright = new MockPlaywrightAdapter();
    this.browserReady = false;
    return false;
  }

  /** W12：设置图片生成适配器（用户提供 apiKey 时调用） */
  setImageGenAdapter(adapter: ImageGenAdapter): void {
    this.imageGen = adapter;
    this.imageGenReady = !(adapter instanceof MockImageGenAdapter);
  }

  /**
   * 写操作前自动快照：记录文件当前内容（仅首次记录，避免重复覆盖）
   */
  private async snapshotBeforeWrite(filePath: string): Promise<void> {
    try {
      if (!this.sessionId) return;
      if (!existsSync(filePath)) return; // 新建文件无需快照
      if (this.modifiedFiles.has(filePath)) return; // 已快照过
      this.modifiedFiles.add(filePath);
      await this.checkpointManager.createSnapshot(this.sessionId, [filePath], `auto:${path.basename(filePath)}`);
    } catch {
      /* 快照失败不阻断主流程 */
    }
  }

  async getAvailableTools(mode: string): Promise<ToolDefinition[]> {
    const builtin = this.getBuiltinTools(mode);
    if (mode === 'ask' || mode === 'architect') return builtin;
    const mcpTools = await this.getMcpTools();
    return [...builtin, ...mcpTools];
  }

  private getBuiltinTools(mode: string): ToolDefinition[] {
    const allTools: ToolDefinition[] = [
      {
        name: 'read_file',
        description: '读取指定文件的内容。参数：path（文件路径）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '要读取的文件绝对路径' } },
          required: ['path'],
        },
      },
      {
        name: 'write_to_file',
        description: '将完整内容写入指定文件（覆盖写）。参数：path（文件路径）、content（完整内容）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' },
            content: { type: 'string', description: '要写入的完整内容' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'create_file',
        description: '新建文件（若文件已存在会报错）。参数：path（文件路径）、content（内容，可空）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要新建的文件路径' },
            content: { type: 'string', description: '文件内容，默认空' },
          },
          required: ['path'],
        },
      },
      {
        name: 'delete_file',
        description: '删除指定文件或目录。参数：path（路径）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '要删除的文件或目录路径' } },
          required: ['path'],
        },
      },
      {
        name: 'rename_file',
        description: '重命名或移动文件/目录。参数：oldPath（原路径）、newPath（新路径）。',
        parameters: {
          type: 'object',
          properties: {
            oldPath: { type: 'string', description: '原路径' },
            newPath: { type: 'string', description: '新路径' },
          },
          required: ['oldPath', 'newPath'],
        },
      },
      {
        name: 'search_files',
        description: '在项目目录中搜索匹配正则的文件内容，返回匹配行及行号。参数：path（搜索根目录）、regex（正则表达式）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '搜索根目录' },
            regex: { type: 'string', description: '正则表达式' },
          },
          required: ['path', 'regex'],
        },
      },
      {
        name: 'list_directory',
        description: '列出指定目录内容。参数：path（目录路径）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '目录路径' } },
          required: ['path'],
        },
      },
      {
        name: 'execute_command',
        description:
          '在终端执行 Shell 命令。参数：command（命令）、cwd（工作目录，可选）。' +
          '长任务请在脚本中输出形如 PROGRESS 3/10 或 PROGRESS 45% 的行，界面会显示进度条。' +
          '扫描类命令务必限定范围（-Depth/-First/Select-Object/过滤条件），输出过大会被截断。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令' },
            cwd: { type: 'string', description: '工作目录' },
          },
          required: ['command'],
        },
      },
      {
        name: 'run_python',
        description:
          '运行 Python 脚本或代码片段（自动选择解释器：配置 > 项目 venv > 内置 > 系统；强制 UTF-8 与无缓冲输出）。' +
          '参数：file（脚本路径，与 code 二选一）、code（内联代码）、args（命令行参数数组）、cwd（工作目录）、timeout（毫秒，默认 240000）。' +
          '失败时会返回结构化的 traceback（文件/行号/异常类型）。长任务可在脚本中用 print 输出 PROGRESS n/m。',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Python 脚本路径（相对工作区或绝对路径）' },
            code: { type: 'string', description: '内联 Python 代码（与 file 二选一）' },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: '传给脚本的命令行参数',
            },
            cwd: { type: 'string', description: '工作目录，默认工作区根' },
            timeout: { type: 'number', description: '超时毫秒，默认 240000' },
          },
        },
      },
      {
        name: 'apply_diff',
        description:
          '对文件应用精确差异编辑（推荐用于局部修改）。参数：path（文件路径）、diff（编辑块）。' +
          'diff 格式：每块用 SEARCH 行开始，然后是需要替换的原文，=== 分隔，之后是替换文本，最后用 >>>REPLACE 结束。' +
          '例如：\nSEARCH\n旧代码\n===\n新代码\n>>>REPLACE',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' },
            diff: { type: 'string', description: '差异内容（SEARCH/===/>>>REPLACE 格式）' },
          },
          required: ['path', 'diff'],
        },
      },
      {
        name: 'search_symbol',
        description: '在项目代码中按名称搜索符号定义（函数/类/方法/接口/类型/常量等），返回定义位置。参数：name（符号名）。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '要查找的符号名，如 getActiveApiConfig' } },
          required: ['name'],
        },
      },
      {
        name: 'get_file_outline',
        description: '提取指定文件的符号结构大纲（类/方法/函数列表及行号）。参数：path（文件路径）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '要分析的文件路径' } },
          required: ['path'],
        },
      },
      {
        name: 'semantic_search',
        description: '3 路召回（关键词+符号+语义 embedding）融合检索代码库。参数：query（搜索文本，必填）、topK（默认 10）、useEmbedding（默认 true，若 API 未配置可降级到纯关键词）。返回按相关度排序的文件:行:snippet 列表。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索文本' },
            topK: { type: 'number', description: '返回条数' },
            useEmbedding: { type: 'boolean', description: '是否启用 embedding 召回' },
          },
          required: ['query'],
        },
      },
      // ===== W10 RAG 工具 =====
      {
        name: 'doc_ingest',
        description: '把任意文档（.md .txt .pdf .docx .html）加入 RAG 索引，返回 docId 供后续 doc_query 使用。参数：path（文件绝对路径，必填）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '文档绝对路径' } },
          required: ['path'],
        },
      },
      {
        name: 'doc_query',
        description: '在已索引的文档中检索最相关的片段（基于关键词或 embedding），返回 LLM-ready 引用文本。参数：query（查询文本）、topK（默认 5）、docIds（可选，限定文档数组）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '查询文本' },
            topK: { type: 'number', description: '返回条数' },
            docIds: { type: 'array', items: { type: 'string' }, description: '限定文档 ID 数组' },
          },
          required: ['query'],
        },
      },
      {
        name: 'doc_list',
        description: '列出当前已索引的所有文档（含 id/name/chunkCount）。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'doc_remove',
        description: '从索引中移除一个文档。参数：docId（必填）。',
        parameters: {
          type: 'object',
          properties: { docId: { type: 'string', description: '文档 ID' } },
          required: ['docId'],
        },
      },
      // ===== W12 Playwright 浏览器自动化 =====
      {
        name: 'browser_navigate',
        description: '用 Playwright 打开 URL。返回页面 title、url、状态码。需先运行 npm install playwright。参数：url（必填）。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '目标 URL' } },
          required: ['url'],
        },
      },
      {
        name: 'browser_screenshot',
        description: '截取当前页面截图并保存到 path（同时返回 base64）。参数：path（保存路径，可选）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '保存路径（绝对路径）' } },
          required: [],
        },
      },
      {
        name: 'browser_click',
        description: '点击页面元素（CSS selector）。参数：selector（必填）。',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string', description: 'CSS selector' } },
          required: ['selector'],
        },
      },
      {
        name: 'browser_input',
        description: '在输入框中填入文本。参数：selector、text（均必填）。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector' },
            text: { type: 'string', description: '要输入的文本' },
          },
          required: ['selector', 'text'],
        },
      },
      {
        name: 'browser_extract',
        description: '提取元素的文本或 HTML。参数：selector、attr（text/html，默认 text）。',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector' },
            attr: { type: 'string', enum: ['text', 'html'] },
          },
          required: ['selector'],
        },
      },
      {
        name: 'browser_close',
        description: '关闭浏览器。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      // ===== W12 图片生成 =====
      {
        name: 'image_generate',
        description: '用 AI 生成图片（默认 OpenAI DALL-E 3）。需配置图片生成 API。参数：prompt（必填）、size（256x256/512x512/1024x1024/1792x1024/1024x1792）、savePath（可选）。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '图片描述' },
            size: { type: 'string', enum: ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'] },
            savePath: { type: 'string', description: '保存路径（绝对路径）' },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'find_references',
        description: '查找某个符号在项目中被引用的位置。参数：name（符号名）。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '要查找引用的符号名' } },
          required: ['name'],
        },
      },
      {
        name: 'project_structure',
        description: '生成项目目录树概览（跳过 node_modules/.git/dist 等，深度默认 3）。参数：depth（可选，最大深度）。',
        parameters: {
          type: 'object',
          properties: { depth: { type: 'number', description: '目录树最大深度，默认 3' } },
          required: [],
        },
      },
      // ===== W3 Plan 工具 =====
      {
        name: 'create_plan',
        description: '创建一个任务计划，包含多个待执行步骤。仅包含计划，不执行任何操作。后续可调用 update_plan_status 推进每一步。参数：title（计划标题，可选）、items（步骤列表，每项含 content、toolName、filePath）。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '计划标题（可选）' },
            items: {
              type: 'array',
              description: '步骤列表',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string', description: '步骤描述' },
                  toolName: { type: 'string', description: '关联工具名（可选）' },
                  filePath: { type: 'string', description: '关联文件路径（可选）' },
                },
                required: ['content'],
              },
            },
          },
          required: ['items'],
        },
      },
      {
        name: 'update_plan_status',
        description: '更新计划中某步骤的状态。参数：itemId（步骤 id）、status（pending/running/completed/failed/skipped）、error（仅 failed 时可选）。',
        parameters: {
          type: 'object',
          properties: {
            itemId: { type: 'string', description: '步骤 id' },
            status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'skipped'] },
            error: { type: 'string', description: '失败时的错误信息' },
          },
          required: ['itemId', 'status'],
        },
      },
      {
        name: 'add_plan_item',
        description: '在已有计划中追加一个步骤。参数：content（描述）、toolName（可选）、filePath（可选）。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '步骤描述' },
            toolName: { type: 'string' },
            filePath: { type: 'string' },
          },
          required: ['content'],
        },
      },
      {
        name: 'get_plan',
        description: '获取当前会话的计划详情（含所有步骤与状态）。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'mark_plan_complete',
        description: '确认当前计划已结束。不会自动修改任何步骤状态；仅在所有应执行步骤均已明确完成后调用。尚未完成的步骤应保留 pending/running 或按实际原因标记 failed/skipped。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      // ===== W4 联网 / Git / Grep / Test / Format =====
      {
        name: 'web_search',
        description: '联网搜索信息（走 DuckDuckGo HTML 端点，无需 API key）。返回最多 N 条结果的标题/链接/摘要。参数：query（搜索关键词，必填）、maxResults（最多返回条数，默认 8）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            maxResults: { type: 'number', description: '最多返回条数，默认 8' },
          },
          required: ['query'],
        },
      },
      {
        name: 'web_fetch',
        description: '抓取指定 URL 的页面文本（HTML 自动转纯文本，最大 200KB）。参数：url（完整 http(s) 链接，必填）。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要抓取的 URL（http/https）' },
          },
          required: ['url'],
        },
      },
      {
        name: 'git_status',
        description: '查看当前工作区的 git 状态（分支、未暂存/已暂存/未跟踪文件）。无需参数。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'git_diff',
        description: '查看当前工作区的 git diff。参数：staged（true=查看已暂存 vs HEAD，false=查看未暂存，默认 false）、maxBytes（最大字节，默认 500000）。',
        parameters: {
          type: 'object',
          properties: {
            staged: { type: 'boolean', description: '查看已暂存变更，默认 false' },
          },
          required: [],
        },
      },
      {
        name: 'git_commit',
        description: '提交变更。参数：message（提交信息，必填）、addAll（是否先 git add -A，默认 false）、author（可选，作者名）。',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: '提交信息' },
            addAll: { type: 'boolean', description: '是否先 add -A' },
            author: { type: 'string', description: '作者标识（可选）' },
          },
          required: ['message'],
        },
      },
      {
        name: 'git_log',
        description: '查看最近 N 条提交记录。参数：limit（默认 10）、branch（默认 HEAD）。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '条数，默认 10' },
            branch: { type: 'string', description: '分支名，默认 HEAD' },
          },
          required: [],
        },
      },
      {
        name: 'git_branch',
        description:
          'Git 分支操作。action：list（默认，列出本地与远程分支，标注当前分支与上游）| create（新建分支，name 必填，from 指定起点，checkout=true 建完直接切过去）| delete（删除分支，force=true 用 -D 丢弃未合并提交）| rename（重命名为 to）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'list | create | delete | rename，默认 list' },
            name: { type: 'string', description: '分支名（create/delete/rename 必填）' },
            from: { type: 'string', description: 'create 时的起点引用（可选）' },
            to: { type: 'string', description: 'rename 后的新名字' },
            force: { type: 'boolean', description: 'delete 时是否强制删除' },
            checkout: { type: 'boolean', description: 'create 后是否切换到新分支' },
          },
          required: [],
        },
      },
      {
        name: 'git_checkout',
        description:
          '切换分支（或创建并切换）。参数：target（分支/提交，必填）、create（true 时新建分支）、startPoint（新建的起点）、force（默认 false；true 会丢弃工作区未提交改动，慎用）。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '目标分支或提交' },
            create: { type: 'boolean', description: '是否新建分支' },
            startPoint: { type: 'string', description: '新建分支的起点' },
            force: { type: 'boolean', description: '强制切换（丢弃改动）' },
          },
          required: ['target'],
        },
      },
      {
        name: 'git_fetch',
        description:
          'git fetch：只拉取远程引用，不改动工作区。参数：remote（默认 origin）、prune（默认 true，清理远程已删除的分支）。',
        parameters: {
          type: 'object',
          properties: {
            remote: { type: 'string', description: '远程名，默认 origin' },
            prune: { type: 'boolean', description: '是否清理失效远程分支，默认 true' },
          },
          required: [],
        },
      },
      {
        name: 'git_pull',
        description:
          'git pull：拉取并快进当前分支。参数：remote（默认 origin）、branch（默认当前分支上游）、rebase（默认 false）。默认 --ff-only，本地与远程分叉时会失败并提示，不会自动造 merge commit。',
        parameters: {
          type: 'object',
          properties: {
            remote: { type: 'string', description: '远程名，默认 origin' },
            branch: { type: 'string', description: '要拉取的远程分支' },
            rebase: { type: 'boolean', description: '是否用 rebase 方式（默认 false）' },
          },
          required: [],
        },
      },
      {
        name: 'git_push',
        description:
          'git push：推送当前分支到远程（永不强推）。参数：remote（默认 origin）、branch（默认当前分支）、setUpstream（首次推送新分支时置 true）、tags（同时推标签）、allowProtected（默认 false；直接推 main/master 会被拒绝，需用户明确同意后才可置 true）。',
        parameters: {
          type: 'object',
          properties: {
            remote: { type: 'string', description: '远程名，默认 origin' },
            branch: { type: 'string', description: '要推送的分支，默认当前分支' },
            setUpstream: { type: 'boolean', description: '是否 -u 建立追踪' },
            tags: { type: 'boolean', description: '是否同时推送标签' },
            allowProtected: { type: 'boolean', description: '允许直推 main/master，默认 false' },
          },
          required: [],
        },
      },
      {
        name: 'grep',
        description: 'ripgrep 风格的高速文本搜索（若系统未装 rg 则用 Node 兜底）。参数：path（搜索根目录）、pattern（正则）、glob（文件 glob 过滤数组，可选）、ignoreCase（默认 false）、maxResults（默认 200）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '搜索根目录' },
            pattern: { type: 'string', description: '正则表达式' },
            glob: { type: 'array', items: { type: 'string' }, description: '文件 glob 过滤' },
            ignoreCase: { type: 'boolean', description: '不区分大小写' },
            maxResults: { type: 'number', description: '最多返回条数' },
          },
          required: ['path', 'pattern'],
        },
      },
      {
        name: 'run_tests',
        description: '自动检测项目测试框架（npm/yarn/pnpm/pytest/go/cargo/make）并执行。参数：framework（强制指定框架，可选）、extraArgs（追加参数数组，可选）、timeoutMs（超时，默认 300000）。',
        parameters: {
          type: 'object',
          properties: {
            framework: { type: 'string', enum: ['npm', 'yarn', 'pnpm', 'pytest', 'go', 'cargo', 'make'] },
            extraArgs: { type: 'array', items: { type: 'string' } },
            timeoutMs: { type: 'number' },
          },
          required: [],
        },
      },
      {
        name: 'format_code',
        description: '用项目配置的格式化工具（prettier/eslint --fix/black/gofmt/rustfmt）格式化指定文件。参数：files（文件路径数组，必填）、formatter（强制指定，可选）。',
        parameters: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' }, description: '要格式化的文件绝对路径列表' },
            formatter: { type: 'string', enum: ['prettier', 'eslint-fix', 'black', 'gofmt', 'rustfmt'] },
          },
          required: ['files'],
        },
      },
      {
        name: SUBAGENT_TOOL_NAME,
        description:
          '把独立的子任务委派给子 Agent 执行。子 Agent 拥有独立上下文和完整工具链，适合「大范围搜索调研」或「与当前主线无关的独立任务」，避免大量中间结果把主对话上下文塞满。注意：子 Agent 看不到主对话历史，description 必须自包含。',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: '子任务描述，必须自包含（含必要背景、目标、验收标准）' },
            agentType: {
              type: 'string',
              enum: ['general-purpose', 'explore'],
              description: 'explore 为只读调研（禁止写入/执行命令），general-purpose 可读写，默认 general-purpose',
            },
            maxTurns: { type: 'number', description: '子 Agent 最大轮数，默认 10，上限 30' },
          },
          required: ['description'],
        },
      },
      {
        name: AUTOFIX_TOOL_NAME,
        description:
          '测试自愈循环：跑测试 → 解析失败（file:line + 原因）→ 派子 Agent 修代码 → 再跑，直到全绿或到达轮数上限。适合「刚改完代码，把测试修绿」这类机械循环。会禁止改断言/skip 测试来伪造通过。参数：maxRounds（修复轮数，默认 3，上限 5）、framework / extraArgs / timeoutMs（透传给 run_tests）、fixTurns（每轮子 Agent 最大轮数，默认 10）。',
        parameters: {
          type: 'object',
          properties: {
            maxRounds: { type: 'number', description: '修复轮数，默认 3，上限 5' },
            framework: { type: 'string', enum: ['npm', 'yarn', 'pnpm', 'pytest', 'go', 'cargo', 'make'] },
            extraArgs: { type: 'array', items: { type: 'string' } },
            timeoutMs: { type: 'number' },
            fixTurns: { type: 'number', description: '每轮修复子 Agent 的最大轮数，默认 10，上限 20' },
          },
          required: [],
        },
      },
    ];

    // 只投递真正可用的工具。无法工作的工具留在表里，模型会照调不误——
    // 白耗一轮，还带回「Playwright 未启用 / 图片生成未配置」这类对用户无意义的报错。
    const available = allTools.filter((t) => {
      if (!this.browserReady && BROWSER_TOOL_NAMES.has(t.name)) return false;
      if (!this.imageGenReady && t.name === 'image_generate') return false;
      return true;
    });

    if (mode === 'ask' || mode === 'architect') {
      const readOnly = ['read_file', 'search_files', 'list_directory', 'get_plan', 'grep', 'web_search', 'web_fetch', 'git_status', 'git_log', 'semantic_search'];
      const planning = ['create_plan', 'update_plan_status', 'add_plan_item', 'get_plan', 'mark_plan_complete'];
      return available.filter((t) => readOnly.includes(t.name) || (mode === 'architect' && planning.includes(t.name)));
    }
    return available;
  }

  private async getMcpTools(): Promise<ToolDefinition[]> {
    try {
      const tools = await this.mcpHub.getAllTools();
      return tools.map((t: any) => ({
        name: `mcp__${t.serverId}__${t.name}`,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
      }));
    } catch {
      return [];
    }
  }

  /**
   * 对外统一入口：执行工具并对返回结果做体积治理。
   * 大文件 read_file / 命中上千行的 grep 等工具会产出海量 output，
   * 全量塞进 messages 会瞬间逼近上下文上限并稀释模型注意力，
   * 因此在这里统一截断；被截断时把完整结果落盘，返回路径供后续精确读取。
   */
  async execute(
    toolName: string,
    args: any,
    signal?: AbortSignal,
    onProgress?: (p: ToolProgress) => void,
  ): Promise<ToolResult> {
    const planItem = this.planManager && this.sessionId && !toolName.startsWith('plan_')
      ? this.planManager.findMatchingItem(this.sessionId, toolName, args)
      : null;
    if (planItem?.status === 'pending') this.planManager!.startItem(this.sessionId!, planItem.id);

    const result = await this.executeRaw(toolName, args, signal, onProgress);
    if (planItem) {
      const succeeded = result?.success !== false;
      if (succeeded) this.planManager!.completeItem(this.sessionId!, planItem.id);
      else this.planManager!.failItem(this.sessionId!, planItem.id, result?.error || '工具执行失败');
    }
    return this.clampToolResult(toolName, result);
  }

  /** 单个工具 output 的最大字符数（约 token 上限的一半） */
  private static readonly MAX_TOOL_OUTPUT_CHARS = 8000;

  /**
   * 截断超长工具输出。
   * - 保留头部（结论/前几条命中通常在开头）+ 尾部（命令的报错常在结尾），中间用省略标记衔接；
   * - 完整内容写入工作区 .cnke/tool-output 下，返回可读回的相对路径，避免信息真丢失；
   * - 仅治理 output，不动 error（错误信息通常很短且必须完整）。
   */
  private clampToolResult(toolName: string, result: ToolResult): ToolResult {
    const output = result.output;
    if (!output || output.length <= ToolManager.MAX_TOOL_OUTPUT_CHARS) return result;

    const limit = ToolManager.MAX_TOOL_OUTPUT_CHARS;
    const head = output.slice(0, Math.floor(limit * 0.7));
    const tail = output.slice(output.length - Math.floor(limit * 0.25));
    const omitted = output.length - head.length - tail.length;

    // 落盘完整结果，便于模型用 read_file 精确取用（失败则退化为纯截断）
    const spillPath = this.spillToolOutput(toolName, output);
    const spillNote = spillPath
      ? `\n\n完整结果（${output.length} 字符）已保存到：${spillPath}\n如需查看全部内容，请用 read_file 读取该文件。`
      : '';

    return {
      ...result,
      output: `${head}\n\n… [已截断 ${omitted} 字符，仅保留头尾] …\n\n${tail}${spillNote}`,
    };
  }

  /** 把超长工具输出写入工作区临时目录，返回相对工作区的路径；无工作区或写失败返回 null */
  private spillToolOutput(toolName: string, output: string): string | null {
    if (!this.workspaceId) return null;
    try {
      const dir = join(this.workspaceId, '.cnke', 'tool-output');
      mkdirSync(dir, { recursive: true });
      const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `${safeName}-${Date.now()}.txt`;
      const fullPath = join(dir, fileName);
      writeFileSync(fullPath, output, 'utf-8');
      return `.cnke/tool-output/${fileName}`;
    } catch {
      return null;
    }
  }

  private async executeRaw(
    toolName: string,
    args: any,
    signal?: AbortSignal,
    onProgress?: (p: ToolProgress) => void,
  ): Promise<ToolResult> {
    try {
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const serverId = parts[1];
        const actualToolName = parts.slice(2).join('__');
        const result = await this.mcpHub.callTool(serverId, actualToolName, args);
        return { success: result.success, output: result.content || '', error: result.error };
      }

      switch (toolName) {
        case 'read_file': {
          const abs = this.resolvePath(args.path);
          const result = await this.fsAdapter.readFile(abs);
          if (!result.success) return { success: false, error: `${result.error}（解析路径: ${abs}）` };
          return { success: true, output: result.content };
        }
        case 'write_to_file': {
          const abs = this.resolvePath(args.path);
          // 先留底再写：变更审查视图需要修改前内容
          const beforeRes = existsSync(abs) ? await this.fsAdapter.readFile(abs) : null;
          const before = beforeRes?.success ? beforeRes.content : undefined;
          await this.snapshotBeforeWrite(abs);
          const result = await this.fsAdapter.writeFile(abs, args.content);
          if (!result.success) return { success: false, error: `${result.error}（解析路径: ${abs}）` };
          this.modifiedFiles.add(abs);
          return { success: true, output: `文件已写入: ${abs}`, diff: { path: abs, before, after: args.content } };
        }
        case 'create_file': {
          const abs = this.resolvePath(args.path);
          const result = await this.fsAdapter.createFile(abs, args.content ?? '');
          if (!result.success) return { success: false, error: `${result.error}（解析路径: ${abs}）` };
          this.modifiedFiles.add(abs);
          return { success: true, output: `文件已创建: ${abs}`, diff: { path: abs, after: args.content ?? '' } };
        }
        case 'delete_file': {
          const abs = this.resolvePath(args.path);
          const beforeRes = existsSync(abs) ? await this.fsAdapter.readFile(abs) : null;
          const before = beforeRes?.success ? beforeRes.content : undefined;
          await this.snapshotBeforeWrite(abs);
          const result = await this.fsAdapter.deletePath(abs);
          if (!result.success) return { success: false, error: `${result.error}（解析路径: ${abs}）` };
          return { success: true, output: `已删除: ${abs}`, diff: { path: abs, before } };
        }
        case 'rename_file': {
          const absOld = this.resolvePath(args.oldPath);
          const absNew = this.resolvePath(args.newPath);
          await this.snapshotBeforeWrite(absOld);
          const result = await this.fsAdapter.renamePath(absOld, absNew);
          if (!result.success) return { success: false, error: `${result.error}（解析路径: ${absOld} -> ${absNew}）` };
          this.modifiedFiles.add(absNew);
          return { success: true, output: `已重命名: ${absOld} -> ${absNew}` };
        }
        case 'search_files': {
          const abs = this.resolvePath(args.path);
          const result = await this.fsAdapter.searchFiles(abs, args.regex);
          if (!result.success) return { success: false, error: `${result.error}（解析路径: ${abs}）` };
          const output = result.results!.map((r: any) => `${r.relativePath}:${r.line}: ${r.match}`).join('\n');
          return { success: true, output: output || '未找到匹配' };
        }
        case 'list_directory': {
          const abs = this.resolvePath(args.path);
          const result = await this.fsAdapter.listDir(abs);
          if (!result.success) return { success: false, error: `${result.error}（解析路径: ${abs}）` };
          const output = result.entries!.map((e) => `${e.isDirectory ? '[目录]' : '[文件]'} ${e.name}`).join('\n');
          return { success: true, output: output || '空目录' };
        }
        case 'execute_command': {
          // cwd 也按工作区解析：模型常给 "." 或相对子目录
          const cwd = args.cwd ? this.resolvePath(args.cwd) : this.workspaceId || process.cwd();
          // 命令输出上限：优先取设置项（KB），未配置则用内置默认
          const maxKB = this.config?.get?.('agentConfig.maxCommandOutputKB', 0) || 0;
          const maxChars = maxKB > 0 ? maxKB * 1024 : undefined;
          // 实时进度：只在需要时挂载回调，避免每条命令都做字符串解析
          let tail = '';
          let lastEmit = 0;
          const onChunk = onProgress
            ? (text: string) => {
                tail = (tail + text).slice(-4096);
                const now = Date.now();
                if (now - lastEmit < 200) return;
                const p = parseProgress(tail);
                if (p) {
                  lastEmit = now;
                  onProgress!(p);
                }
              }
            : undefined;
          const result = await this.terminalAdapter.exec(args.command, cwd, args.timeout, signal, { maxChars, onChunk });
          // 输出被截断时必须显式告诉模型，否则它会以为命令真的只输出了这么点内容，
          // 进而基于残缺结果继续推理（全盘扫描类命令最容易踩这个坑）。
          const note = (s?: string): string => {
            const body = s || '';
            if (!result.truncated) return body;
            return (
              body +
              `\n\n[输出过大已截断：仅保留前 ${body.length} 字符，另有约 ${result.droppedChars ?? 0} 字符被丢弃。` +
              '请缩小命令的输出范围（限定目录/加 -Depth、-First、Select-Object 或过滤条件）后重试。]'
            );
          };
          if (!result.success) return { success: false, error: result.error, output: note(result.stdout) };
          return { success: true, output: note(result.stdout) || result.stderr || '命令执行完成' };
        }
        case 'run_python': {
          const cwd = args.cwd ? this.resolvePath(args.cwd) : this.workspaceId || process.cwd();
          const fileArg = typeof args.file === 'string' ? args.file.trim() : '';
          const codeArg = typeof args.code === 'string' ? args.code : '';
          if (!fileArg && !codeArg) return { success: false, error: '参数 file 与 code 至少提供一个' };

          // 解析解释器：配置路径 > 项目 venv > 内置 > 系统；找不到直接报错，不静默
          const configured =
            String(this.config?.get?.('agentConfig.pythonPath', '') || '').trim() ||
            String(this.config?.get?.('pptMaster.pythonPath', '') || '').trim() ||
            null;
          const py = await resolvePython({
            configuredPath: configured,
            resourcesPath: (process as any).resourcesPath || null,
            projectRoot: this.workspaceId || cwd,
          });
          if (!py) {
            return { success: false, error: '未找到可用的 Python 解释器。请安装 Python 3.9+，或在设置 - Agent 中指定解释器路径。' };
          }
          if (!py.usable) {
            return { success: false, error: `Python 版本过低：${py.version ?? '未知'}，需要 3.9+` };
          }

          const scriptPath = fileArg ? this.resolvePath(fileArg) : '';
          if (scriptPath && !existsSync(scriptPath)) {
            return { success: false, error: `脚本不存在：${scriptPath}` };
          }

          // -u 无缓冲：管道下 stdout 否则会块缓冲，PROGRESS 进度行要攒满才吐出
          const argv: string[] = ['-u'];
          if (codeArg) argv.push('-c', codeArg);
          else argv.push(scriptPath);
          if (Array.isArray(args.args)) argv.push(...args.args.map((a: any) => String(a)));

          const maxKB = this.config?.get?.('agentConfig.maxCommandOutputKB', 0) || 0;
          const maxChars = maxKB > 0 ? maxKB * 1024 : undefined;
          const rawTimeout = Number(args.timeout);
          const timeout =
            Number.isFinite(rawTimeout) && rawTimeout > 0
              ? Math.min(900_000, Math.max(1_000, Math.floor(rawTimeout)))
              : 240_000;

          // 实时进度：与 execute_command 同款尾部窗口解析 PROGRESS
          let tail = '';
          let lastEmit = 0;
          const onChunk = onProgress
            ? (text: string) => {
                tail = (tail + text).slice(-4096);
                const now = Date.now();
                if (now - lastEmit < 200) return;
                const p = parseProgress(tail);
                if (p) {
                  lastEmit = now;
                  onProgress!(p);
                }
              }
            : undefined;

          const result = await this.terminalAdapter.execProgram(py.path, argv, { cwd, timeout, signal, maxChars, onChunk });
          const note = (s?: string): string => {
            const body = s || '';
            if (!result.truncated) return body;
            return (
              body +
              `\n\n[输出过大已截断：仅保留前 ${body.length} 字符，另有约 ${result.droppedChars ?? 0} 字符被丢弃。` +
              '请缩小输出范围（只打印关键信息 / 分批处理）后重试。]'
            );
          };
          if (!result.success) {
            const tb = parsePythonTraceback(result.stderr || '');
            return {
              success: false,
              // 失败以 stderr（traceback）为准，模型才知道错了什么
              error: note(result.stderr) || note(result.error) || '脚本执行失败',
              output: note(result.stdout),
              errorMeta: tb,
            };
          }
          return { success: true, output: note(result.stdout) || result.stderr || '脚本执行完成' };
        }
        case 'apply_diff': {
          return this.applyDiff(this.resolvePath(args.path), args.diff);
        }
        case 'search_symbol': {
          const symbols = await this.codebaseIndexer.searchSymbol(args.name);
          if (symbols.length === 0) return { success: true, output: '未找到符号: ' + args.name };
          const output = symbols
            .map((s) => `${s.relativeFile}:${s.line} [${s.kind}] ${s.parent ? s.parent + '.' : ''}${s.name}`)
            .join('\n');
          return { success: true, output };
        }
        case 'get_file_outline': {
          const items = await this.codebaseIndexer.getFileOutline(args.path);
          if (items.length === 0) return { success: true, output: '未识别到符号（可能是空文件或非代码文件）' };
          const output = items
            .map((it) => `${it.line}: [${it.kind}] ${it.parent ? it.parent + '.' : ''}${it.name}`)
            .join('\n');
          return { success: true, output };
        }
        case 'find_references': {
          const refs = await this.codebaseIndexer.findReferences(args.name);
          if (refs.length === 0) return { success: true, output: '未找到引用: ' + args.name };
          const output = refs
            .map((r) => `${r.relativeFile}:${r.line}: ${r.snippet}`)
            .join('\n');
          return { success: true, output };
        }
        case 'project_structure': {
          const output = await this.codebaseIndexer.getProjectStructure(args.depth ?? 3);
          return { success: true, output };
        }
        case 'semantic_search': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const ret = this.getOrCreateRetriever(this.workspaceId);
          const useEmbedding = args.useEmbedding !== false;
          let embedding: any = undefined;
          if (useEmbedding && this.config) {
            const cfg = this.config;
            const configs: any[] = cfg.getApiKeyConfigs ? cfg.getApiKeyConfigs() : [];
            const activeId = cfg.get('activeApiConfigId');
            const apiConfig = configs.find((c: any) => c.id === activeId) || configs[0];
            if (apiConfig?.baseUrl && apiConfig?.apiKey) {
              embedding = {
                baseUrl: apiConfig.baseUrl,
                apiKey: apiConfig.apiKey,
                model: cfg.get('agentConfig.embeddingModel', 'text-embedding-3-small'),
              };
            }
          }
          const results = await ret.search(args.query, {
            rootPath: this.workspaceId,
            enableEmbedding: !!embedding,
            embedding,
            topK: args.topK ?? 10,
          });
          if (results.length === 0) return { success: true, output: '未找到匹配' };
          const list = results
            .map((r, i) => `${i + 1}. [${r.score.toFixed(2)}] ${r.relativeFile}:${r.line}${r.symbolName ? ` (${r.symbolName})` : ''}\n   ${r.snippet}\n   来源: ${r.sources.join('+')}`)
            .join('\n\n');
          return { success: true, output: list };
        }
        // ===== W10 RAG 工具 =====
        case 'doc_ingest': {
          if (!this.ragManager) return { success: false, error: 'RagManager 未启用' };
          let embedding: any;
          if (this.config) {
            const cfg = this.config;
            const configs: any[] = cfg.getApiKeyConfigs ? cfg.getApiKeyConfigs() : [];
            const activeId = cfg.get('activeApiConfigId');
            const apiConfig = configs.find((c: any) => c.id === activeId) || configs[0];
            if (apiConfig?.baseUrl && apiConfig?.apiKey) {
              embedding = {
                baseUrl: apiConfig.baseUrl,
                apiKey: apiConfig.apiKey,
                model: cfg.get('agentConfig.embeddingModel', 'text-embedding-3-small'),
              };
            }
          }
          try {
            const r = await this.ragManager.ingest(args.path, embedding || { baseUrl: '', apiKey: '', model: '' });
            return { success: true, output: `已摄入：${r.name} (${r.type}, ${r.chars} 字符, ${r.chunkCount} 块, embedding ${r.embeddedCount}/${r.chunkCount})\ndocId: ${r.docId}` };
          } catch (err: any) {
            return { success: false, error: err.message || String(err) };
          }
        }
        case 'doc_query': {
          if (!this.ragManager) return { success: false, error: 'RagManager 未启用' };
          let embedding: any;
          if (this.config) {
            const cfg = this.config;
            const configs: any[] = cfg.getApiKeyConfigs ? cfg.getApiKeyConfigs() : [];
            const activeId = cfg.get('activeApiConfigId');
            const apiConfig = configs.find((c: any) => c.id === activeId) || configs[0];
            if (apiConfig?.baseUrl && apiConfig?.apiKey) {
              embedding = {
                baseUrl: apiConfig.baseUrl,
                apiKey: apiConfig.apiKey,
                model: cfg.get('agentConfig.embeddingModel', 'text-embedding-3-small'),
              };
            }
          }
          const r = await this.ragManager.query(args.query, embedding || { baseUrl: '', apiKey: '', model: '' }, args.topK ?? 5, args.docIds);
          return { success: true, output: r.context };
        }
        case 'doc_list': {
          if (!this.ragManager) return { success: false, error: 'RagManager 未启用' };
          const list = this.ragManager.list();
          if (list.length === 0) return { success: true, output: '（暂无已索引文档，请先用 doc_ingest 添加）' };
          return { success: true, output: list.map((d) => `- ${d.id} | ${d.name} | ${d.chunkCount} 块`).join('\n') };
        }
        case 'doc_remove': {
          if (!this.ragManager) return { success: false, error: 'RagManager 未启用' };
          this.ragManager.remove(args.docId);
          return { success: true, output: `已移除文档：${args.docId}` };
        }
        // ===== W12 Playwright 浏览器工具 =====
        case 'browser_navigate': {
          if (!this.playwright) return { success: false, error: 'Playwright 未初始化，请调用 enablePlaywright()' };
          try {
            const r = await this.playwright.navigate(args.url);
            return { success: true, output: `已打开：${r.title}\nURL: ${r.url}\n状态: ${r.status}` };
          } catch (err: any) {
            return { success: false, error: err.message || String(err) };
          }
        }
        case 'browser_screenshot': {
          if (!this.playwright) return { success: false, error: 'Playwright 未初始化' };
          try {
            const r = await this.playwright.screenshot(args.path);
            return { success: true, output: `已截图：${r.path || '(内存)'}\n尺寸：${r.width}x${r.height}\nbase64 长度：${r.base64?.length || 0}` };
          } catch (err: any) {
            return { success: false, error: err.message || String(err) };
          }
        }
        case 'browser_click': {
          if (!this.playwright) return { success: false, error: 'Playwright 未初始化' };
          const r = await this.playwright.click(args.selector);
          return r.success ? { success: true, output: `已点击：${args.selector}` } : { success: false, error: r.error };
        }
        case 'browser_input': {
          if (!this.playwright) return { success: false, error: 'Playwright 未初始化' };
          const r = await this.playwright.input(args.selector, args.text);
          return r.success ? { success: true, output: `已输入：${args.text} → ${args.selector}` } : { success: false, error: r.error };
        }
        case 'browser_extract': {
          if (!this.playwright) return { success: false, error: 'Playwright 未初始化' };
          const r = await this.playwright.extract(args.selector, args.attr);
          return { success: true, output: r.value };
        }
        case 'browser_close': {
          if (!this.playwright) return { success: false, error: 'Playwright 未初始化' };
          await this.playwright.close();
          return { success: true, output: '浏览器已关闭' };
        }
        // ===== W12 图片生成 =====
        case 'image_generate': {
          if (!this.imageGen) return { success: false, error: '图片生成未配置，请在设置中启用 DALL-E 或通义万相' };
          const r = await this.imageGen.generate({
            prompt: args.prompt,
            size: args.size,
            savePath: args.savePath,
          });
          if (!r.success) return { success: false, error: r.error };
          return { success: true, output: `已生成图片（${r.provider}）\n${r.path ? `已保存：${r.path}` : `base64 长度：${r.base64?.length || 0}`}${r.url ? `\nURL: ${r.url}` : ''}` };
        }
        // ===== W3 Plan 工具 =====
        case 'create_plan': {
          if (!this.planManager || !this.sessionId) {
            return { success: false, error: 'PlanManager 未启用' };
          }
          const items = Array.isArray(args.items) ? args.items : [];
          if (items.length === 0) return { success: false, error: 'items 不能为空' };
          const plan = this.planManager.create(this.sessionId, items, args.title);
          return { success: true, output: `已创建计划（${plan.items.length} 步）：\n${this.planManager.summaryForLlm(this.sessionId)}` };
        }
        case 'update_plan_status': {
          if (!this.planManager || !this.sessionId) {
            return { success: false, error: 'PlanManager 未启用' };
          }
          const ok = this.planManager.updateStatus(this.sessionId, args.itemId, args.status, args.error);
          if (!ok) return { success: false, error: `更新失败：步骤不存在或状态非法（itemId=${args.itemId}, status=${args.status}）` };
          return { success: true, output: this.planManager.summaryForLlm(this.sessionId) };
        }
        case 'add_plan_item': {
          if (!this.planManager || !this.sessionId) {
            return { success: false, error: 'PlanManager 未启用' };
          }
          const item = this.planManager.addItem(this.sessionId, args.content, args.toolName, args.filePath);
          if (!item) return { success: false, error: '当前会话没有计划，请先调用 create_plan' };
          return { success: true, output: `已追加步骤：${item.content}\n${this.planManager.summaryForLlm(this.sessionId)}` };
        }
        case 'get_plan': {
          if (!this.planManager || !this.sessionId) {
            return { success: false, error: 'PlanManager 未启用' };
          }
          const plan = this.planManager.getPlan(this.sessionId);
          if (!plan) return { success: true, output: '当前会话没有计划' };
          return { success: true, output: this.planManager.summaryForLlm(this.sessionId) };
        }
        case 'mark_plan_complete': {
          if (!this.planManager || !this.sessionId) {
            return { success: false, error: 'PlanManager 未启用' };
          }
          this.planManager.complete(this.sessionId);
          return { success: true, output: `计划已结束。\n${this.planManager.summaryForLlm(this.sessionId)}` };
        }
        // ===== W4 新工具 =====
        case 'web_search': {
          const r = await webSearch(args.query, { maxResults: args.maxResults });
          if (!r.success) return { success: false, error: r.error };
          if (!r.results || r.results.length === 0) return { success: true, output: '未找到结果' };
          const list = r.results.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`).join('\n\n');
          return { success: true, output: list };
        }
        case 'web_fetch': {
          const r = await webFetch(args.url);
          if (!r.success) return { success: false, error: r.error };
          const text = r.result!.text;
          const note = r.result!.truncated ? '\n\n[内容已截断]' : '';
          return { success: true, output: `${text}${note}` };
        }
        case 'git_status': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await gitStatus(this.workspaceId);
          if (!r.success) return { success: false, error: r.error };
          const s = r.status!;
          const out = [
            `分支：${s.branch}`,
            `状态：${s.clean ? '干净' : '有变更'}`,
            s.staged.length ? `已暂存 (${s.staged.length})：\n${s.staged.map((x) => '  ' + x).join('\n')}` : '',
            s.unstaged.length ? `未暂存 (${s.unstaged.length})：\n${s.unstaged.map((x) => '  ' + x).join('\n')}` : '',
            s.untracked.length ? `未跟踪 (${s.untracked.length})：\n${s.untracked.slice(0, 20).map((x) => '  ' + x).join('\n')}${s.untracked.length > 20 ? `\n  ... 还有 ${s.untracked.length - 20} 项` : ''}` : '',
          ].filter(Boolean).join('\n');
          return { success: true, output: out };
        }
        case 'git_diff': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await gitDiff(this.workspaceId, !!args.staged);
          if (!r.success) return { success: false, error: r.error };
          const note = r.truncated ? '\n\n[diff 已截断]' : '';
          return { success: true, output: (r.diff || '无差异') + note };
        }
        case 'git_commit': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await gitCommit(this.workspaceId, args.message, { addAll: !!args.addAll, author: args.author });
          if (!r.success) return { success: false, error: r.error };
          return { success: true, output: `已提交：${r.hash?.slice(0, 7) || ''}\n${r.message}` };
        }
        case 'git_log': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await gitLog(this.workspaceId, { limit: args.limit, branch: args.branch });
          if (!r.success) return { success: false, error: r.error };
          if (!r.entries || r.entries.length === 0) return { success: true, output: '无提交记录' };
          const list = r.entries.map((e) => `${e.shortHash} | ${e.date} | ${e.author}\n   ${e.subject}`).join('\n');
          return { success: true, output: list };
        }
        case 'git_branch': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await gitBranch(this.workspaceId, {
            action: args.action,
            name: args.name,
            from: args.from,
            to: args.to,
            force: !!args.force,
            checkout: !!args.checkout,
          });
          if (!r.success) return { success: false, error: r.error };
          if (r.local) {
            const locals = r.local.map((b) => `${b.current ? '*' : ' '} ${b.name}${b.upstream ? ` -> ${b.upstream}` : ''}`);
            const remotes = (r.remote || []).map((b) => `  ${b.name}`);
            const out = [`当前分支：${r.current || '(未知)'}`, '本地分支：', ...locals];
            if (remotes.length) out.push('', '远程分支：', ...remotes);
            return { success: true, output: out.join('\n') };
          }
          return { success: true, output: r.output || '完成' };
        }
        case 'git_checkout': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await gitCheckout(this.workspaceId, args.target, {
            create: !!args.create,
            startPoint: args.startPoint,
            force: !!args.force,
          });
          if (!r.success) return { success: false, error: r.error };
          return { success: true, output: r.output || `已切换到 ${r.branch || args.target}` };
        }
        case 'git_fetch': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await gitFetch(this.workspaceId, { remote: args.remote, prune: args.prune });
          if (!r.success) return { success: false, error: r.error };
          return { success: true, output: r.output || '已拉取远程引用' };
        }
        case 'git_pull': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await gitPull(this.workspaceId, { remote: args.remote, branch: args.branch, rebase: !!args.rebase });
          if (!r.success) return { success: false, error: r.error };
          return { success: true, output: r.output || '已拉取并同步' };
        }
        case 'git_push': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await gitPush(this.workspaceId, {
            remote: args.remote,
            branch: args.branch,
            setUpstream: !!args.setUpstream,
            tags: !!args.tags,
            allowProtected: !!args.allowProtected,
          });
          if (!r.success) return { success: false, error: r.error };
          const ab = typeof r.ahead === 'number' ? `（与上游：领先 ${r.ahead} / 落后 ${r.behind ?? 0}）` : '';
          return { success: true, output: `${r.output || `已推送 ${r.branch}`}${ab}` };
        }
        case 'grep': {
          const r = await grep({
            path: args.path,
            pattern: args.pattern,
            glob: args.glob,
            ignoreCase: !!args.ignoreCase,
            maxResults: args.maxResults,
          });
          if (!r.success) return { success: false, error: r.error };
          if (!r.matches || r.matches.length === 0) return { success: true, output: `未找到匹配（引擎: ${r.engine}）` };
          const list = r.matches.map((m) => `${m.file}:${m.line}: ${m.match}`).join('\n');
          return { success: true, output: `${list}\n\n[共 ${r.matches.length} 条，引擎: ${r.engine}]` };
        }
        case 'run_tests': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await runTests(this.workspaceId, { framework: args.framework, extraArgs: args.extraArgs, timeoutMs: args.timeoutMs });
          const head = `框架: ${r.framework}\n命令: ${r.command}\n退出码: ${r.exitCode}\n耗时: ${r.durationMs}ms${r.truncated ? '\n[输出已截断]' : ''}\n`;
          return {
            success: r.exitCode === 0,
            output: head + '\n--- stdout ---\n' + r.stdout + (r.stderr ? '\n--- stderr ---\n' + r.stderr : ''),
            error: r.error,
          };
        }
        case 'format_code': {
          if (!this.workspaceId) return { success: false, error: '无当前工作区' };
          const r = await formatCode(this.workspaceId, args.files || [], { formatter: args.formatter });
          if (!r.success) return { success: false, error: r.error || r.output };
          return { success: true, output: `已用 ${r.formatter} 格式化 ${r.filesFormatted} 个文件\n${r.output}` };
        }
        default:
          return { success: false, error: `未知工具: ${toolName}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Diff 精确编辑：SEARCH / === / >>>REPLACE 格式
   * - 每块独立精确匹配，未匹配到会报错（避免静默错误）
   * - 支持多块顺序应用
   */
  private async applyDiff(filePath: string, diff: string): Promise<ToolResult> {
    try {
      if (!existsSync(filePath)) {
        return { success: false, error: `文件不存在: ${filePath}` };
      }

      await this.snapshotBeforeWrite(filePath);
      const original = await fs.readFile(filePath, 'utf-8');

      // 解析 diff 格式: SEARCH\n<原文>\n===\n<替换>\n>>>REPLACE
      const blocks = diff.split(/>>>REPLACE/).filter((b) => b.trim());
      if (blocks.length === 0) {
        return { success: false, error: 'diff 格式错误：缺少 >>>REPLACE 结束标记' };
      }

      let content = original;
      for (const block of blocks) {
        const match = block.match(/SEARCH\s*\n([\s\S]*?)\n===\n([\s\S]*)/);
        if (!match) {
          return { success: false, error: 'diff 格式错误：缺少 SEARCH 或 === 标记' };
        }
        const search = match[1];
        const replace = match[2].trim();
        if (search === undefined || search === null) {
          return { success: false, error: 'diff 格式错误：SEARCH 内容为空' };
        }
        const occurrences = content.split(search).length - 1;
        if (occurrences === 0) {
          return { success: false, error: `未找到匹配文本: ${search.slice(0, 50)}...` };
        }
        if (occurrences > 1) {
          return {
            success: false,
            error: `匹配文本出现 ${occurrences} 次，请提供更长的上下文使其唯一: ${search.slice(0, 50)}...`,
          };
        }
        content = content.replace(search, replace);
      }

      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true, output: `差异已应用: ${filePath}`, diff: { path: filePath, before: original, after: content } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
