import { LLMProvider } from '../llm/LLMProvider';
import { decideModelFromPromptWithImages } from '../llm/ModelRouter';
import { ToolManager } from '../tools/ToolManager';
import { scheduleToolCalls, DEFAULT_TOOL_POLICIES } from '../tools/ParallelToolScheduler';
import { CodebaseIndexer } from '../codebase/CodebaseIndexer';
import { FileSystemAdapter } from '../../adapter/FileSystemAdapter';
import { TerminalAdapter } from '../../adapter/TerminalAdapter';
import { WindowAdapter } from '../../adapter/WindowAdapter';
import { McpHub } from '../mcp/McpHub';
import { ConfigAdapter } from '../../adapter/ConfigAdapter';
import { CheckpointManager } from '../checkpoint/CheckpointManager';
import { MemoryStore, MemoryType, MemoryScope, MEMORY_DEFAULT_SETTINGS, MEMORY_LIMITS } from '../memory/MemoryStore';
import { PlanManager } from '../plan/PlanManager';
import { ApprovalPolicy, ApprovalRule, PolicyDecision } from '../checkpoint/ApprovalPolicy';
import { ContextTracker, ContextState } from './ContextTracker';
import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { appendFileSync } from 'node:fs';

// 诊断日志：定位"对话没反应/工具卡住"问题
function dbgLog(msg: string): void {
  try {
    appendFileSync('C:\\Users\\yuhen\\Downloads\\CNKE\\cnke-claw\\agent-debug.log', `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

/** 手动上下文压缩的 system prompt */
const SUMMARIZE_CONTEXT_PROMPT = `你是对话压缩助手。下面是早期对话历史，请提炼出 200-500 字的简洁摘要，让后续 AI 能延续上下文而不丢失关键信息。

要求：
- 用户的目标 / 偏好 / 关键决策
- 已完成的工作（修改了哪些文件、解决了什么问题）
- 当前进度和待办
- 任何重要的技术细节

直接输出摘要文本，不要任何前缀。`;

export type AgentMode = 'architect' | 'coder' | 'debugger' | 'ask';

export interface AgentConfig {
  fsAdapter: FileSystemAdapter;
  terminalAdapter: TerminalAdapter;
  mcpHub: McpHub;
  windowAdapter: WindowAdapter;
  config: ConfigAdapter;
  checkpointManager: CheckpointManager;
  codebaseIndexer: CodebaseIndexer;
  /** 本地记忆存储（可选）：未注入时不启用记忆功能 */
  memoryStore?: MemoryStore;
  /** W3 新增：PlanManager（可选），未注入时 plan 工具不可用 */
  planManager?: PlanManager;
}

export interface RunParams {
  sessionId: string;
  workspaceId: string;
  prompt: string;
  history: any[];
  mode: AgentMode;
  model?: string;
  images?: string[];
  /** 用户上传的文本文件（渲染层已按 MAX_FILE_TEXT_CHARS 截断，content 为可读文本） */
  files?: { id: string; name: string; size: number; content: string; truncated?: boolean }[];
  systemPromptOverride?: string;
  /** 全自动模式：为 true 时自动批准所有工具调用，不弹出审批窗口 */
  autoApprove?: boolean;
}

export interface AgentEvent {
  type: 'thinking' | 'assistant' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'stream' | 'context_state';
  sessionId: string;
  data: any;
}

// Agent 核心身份与工作准则：所有模式共享的公共基础 Prompt
export const BASE_SYSTEM_PROMPT = `你是 CnkeIDE，一款国产桌面 AI 编程助手的内核 Agent。
你的任务是在用户的本地代码库里，通过调用工具帮用户完成需求。

## 你的工作方式
- 你只能通过【工具】读写文件、检索代码、跑命令、操作浏览器，绝不能假装做了没做的事。
- 面对复杂需求，先调用 read_file / project_structure / semantic_search 了解现状，再动手改。
- 优先做"最小、可理解、可回滚"的改动；能用 apply_diff 精确改，就不要整文件覆盖。
- 每次改动后主动向用户说明：改了什么、为什么改、影响面、如何验证。

## 铁律（必须遵守）
1. 不臆造 API、不补全不存在的方法；拿不准就先搜代码或问用户。
2. 改代码前先读相关文件，确认类型与调用关系，避免破坏其他模块。
3. 涉及删除/重命名/批量改，先给用户确认或给出 plan，再执行。
4. 输出要精炼：先结论后细节，能列表不写长段。
5. 遇到权限、网络、路径问题，如实报告错误，不猜测成功。

## 反幻觉铁律（最高优先级，违反即为严重事故）
1. **未读不引**：你没有用 read_file / get_file_outline 等工具实际读过的文件，绝不能在回复中声称"我看了""这个文件里有""代码第 N 行是"。你必须先调用工具读取，再引用。
2. **未改不说改**：你没有用 write_to_file / apply_diff 等工具实际执行的改动，绝不能在回复中声称"我修改了""已修复""已更新"。回复中描述的每个改动，都必须有对应的工具调用记录。
3. **未跑不说通**：你没有用 execute_command 实际运行的命令，绝不能声称"测试通过""编译成功""运行正常"。必须先跑再报结果。
4. **不编造 API**：不要凭记忆编造第三方库的 API 签名/参数/返回值。拿不准时，先搜代码看实际用法，或用 web_search 查文档。
5. **不编造文件路径**：不要凭猜测给出文件路径。不确定就先 project_structure / list_directory 看真实结构。
6. **不编造执行结果**：工具返回什么就是什么。不要美化、隐瞒、篡改工具的输出。工具报错就如实转告用户，不要假装成功。
7. **宁可承认不知道**：当你不确定时，明确说"我不确定，需要先验证"，然后调用工具去验证。绝不用编造的"事实"填充回复。

## 对你能力的边界说明
- 你可以联网检索、抓取网页、生成图片、操作浏览器做验证。
- 你具备本地记忆与代码库语义检索能力，可复用项目上下文。
- 对不确定的外部依赖，倾向保守建议而非编造。`;

const SYSTEM_PROMPTS: Record<AgentMode, string> = {
  architect: `你是一位资深软件架构师。你的职责是：
1. 分析项目结构，理解代码架构
2. 制定技术方案和开发计划
3. 设计系统架构和数据模型
4. 提供详细的技术建议和最佳实践

你拥有完整的工具链。分析/理解代码库时，请优先使用代码库理解工具：
- project_structure：先看项目目录树，快速了解整体结构
- search_symbol：按名称定位函数/类/方法/接口的定义位置
- get_file_outline：查看单个文件的符号大纲（有哪些类和方法）
- find_references：查找某个符号被哪些地方引用
- 然后再用 read_file 精读关键文件、search_files 做文本检索、execute_command 运行命令
请善用它们来完成架构分析。`,
  coder: `你是一位高效的全栈开发者。你的职责是：
1. 根据需求编写高质量代码
2. 创建、修改、重构文件
3. 运行和测试代码
4. 修复 bug 和优化性能

你拥有完整的工具链。写代码前先理解代码库：可用 project_structure 看目录结构、search_symbol 找定义、get_file_outline 看文件大纲、find_references 查引用；改完用 read_file 复查、execute_command 运行测试验证。请积极使用文件操作和终端工具来完成任务。`,
  debugger: `你是一位专业的调试专家。你的职责是：
1. 分析错误日志和堆栈跟踪
2. 定位 bug 根因
3. 提供修复方案并实施
4. 验证修复结果

请使用搜索和读取工具快速定位问题，用终端工具执行测试验证。`,
  ask: `你是一位知识渊博的技术顾问。你的职责是：
1. 回答技术问题
2. 解释代码逻辑
3. 提供编程建议
4. 推荐最佳实践

在回答前请先阅读相关文件以确保准确性。`,
};

// 结构化回复规范：让最终回复按美观的 Markdown 排版，类似 CodeBuddy
const REPLY_FORMAT_STRUCTURED = `

[回复格式要求] 你的最终回复请始终使用清晰、美观的结构化 Markdown（若只需一句简短确认则可例外）：
1. 先给结论：开头用一两句话直接回答核心问题，不要铺垫和客套。
2. 善用标题分层：内容较多时用 ## / ### 组织小节，避免一大段平铺文字。
3. 要点用 - 无序列表或 1. 有序列表；需要对比时用 Markdown 表格。
4. 代码、命令、路径一律用 \`\`\` 代码块（标注语言）或 \`行内代码\` 包裹。
5. 操作步骤分步编号，重要结果用加粗强调（不要滥用加粗）。
6. 需要总结时在末尾用「小结」小节，最多 3 条。
7. 长度适中：能列表不写长句，能表格不用段落。`;

// W3：plan 引导：让 LLM 在执行复杂任务时主动拆解为计划
const PLAN_GUIDE = `
[任务规划]
当用户请求涉及多步操作（修改多个文件、运行测试、调试等）时，请按以下流程工作：
1. **先建计划**：先调用 create_plan，列出 3-8 个清晰的步骤（每步一个 action verb 开头）
2. **逐步推进**：每调用一个非 plan 工具前，先用 update_plan_status 把对应步骤标记为 running；完成后立即标记为 completed
3. **失败处理**：工具失败时标记为 failed 并附 error 描述
4. **追加步骤**：发现原计划遗漏时，用 add_plan_item 追加
5. **不要省略**：即使任务看起来简单，建一个 2 步的计划也比直接动手更让用户放心

简单对话（单步即可完成）不需要建计划。`;


// 自动记忆提取的系统提示：让 LLM 把本轮对话中「值得长期记住」的信息提炼为结构化 JSON
const MEMORY_EXTRACT_SYSTEM = `你是对话记忆提取器。从下面的【用户请求】与【AI 回复】中，提炼出少量“值得长期保存”的信息，用于未来对话自动加载，避免用户重复交代相同背景。

只提取以下类别（不满足就不要输出）：
- 用户身份/偏好/习惯（如偏好语言、命名风格、是否用中文回复、常用技术栈）→ type=preference
- 项目的关键事实与决策（如项目是做什么的、用何技术栈、关键目录约定、用户指定的架构选择）→ type=project
- 需要延续执行的事项或重要结论 → type=project

规则：
1. 最多输出 3 条，宁缺毋滥；每条是一句完整、自包含、可独立理解的话（第三人称描述，不要在开头写“用户”“他”）。
2. 全局通用偏好（与具体项目无关）scope=global；与具体项目/代码库相关 scope=workspace。
3. importance 用 1(一般)/2(重要)/3(关键)。
4. 只输出一个 JSON 数组，不要输出任何其他文字、解释或代码围栏。格式：[{"content":"...","type":"preference|project","scope":"global|workspace","importance":1}]`;

/** 解析 LLM 返回的记忆 JSON（容错：支持代码围栏、纯 JSON、兜底按行提取） */
function parseExtractedMemories(text: string): { content: string; type: MemoryType; scope: MemoryScope; importance: number }[] {
  let arr: any = null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : text).trim();
  try {
    arr = JSON.parse(candidate);
  } catch {
    /* 非严格 JSON，继续尝试 */
  }
  if (!Array.isArray(arr)) {
    arr = candidate
      .split('\n')
      .map((l) => l.replace(/^[-*•\d.\s]+/, '').trim())
      .filter((l) => l.length >= 8)
      .slice(0, 5)
      .map((content) => ({ content, type: 'project', scope: 'workspace', importance: 1 }));
  }
  const types: MemoryType[] = ['preference', 'project', 'summary', 'manual'];
  const out: { content: string; type: MemoryType; scope: MemoryScope; importance: number }[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!content || content.length < 8) continue;
    const importance = Number(raw.importance);
    out.push({
      content: content.slice(0, MEMORY_LIMITS.maxCharsPerItem),
      type: types.includes(raw.type) ? raw.type : 'project',
      scope: raw.scope === 'global' ? 'global' : 'workspace',
      importance: Number.isInteger(importance) && importance >= 1 && importance <= 3 ? importance : 1,
    });
  }
  return out;
}

/**
 * AgentManager - Agent 智能系统核心
 * 多角色 Agent、自主任务规划、多步骤思考、循环工具调用
 */
export class AgentManager {
  private llmProvider: LLMProvider;
  private toolManager: ToolManager;
  private config: ConfigAdapter;
  private mcpHub: McpHub;
  private windowAdapter: WindowAdapter;
  private checkpointManager: CheckpointManager;
  private memoryStore?: MemoryStore;
  private runningSessions: Map<string, boolean> = new Map();
  /** W1 新增：每会话独立的 AbortController，abort 时中断 LLM 流与读流 */
  private abortControllers: Map<string, AbortController> = new Map();
  private toolApprovals: Map<string, (approved: boolean) => void> = new Map();
  /** W3 新增：PlanManager（可选） */
  private planManager?: PlanManager;
  /** W7 新增：审批策略（信任规则） */
  private approvalPolicy: ApprovalPolicy = new ApprovalPolicy();
  /** W11 新增：上下文窗口实时追踪 */
  private contextTracker: ContextTracker = new ContextTracker();

  constructor(config: AgentConfig) {
    this.config = config.config;
    this.mcpHub = config.mcpHub;
    this.windowAdapter = config.windowAdapter;
    this.checkpointManager = config.checkpointManager;
    this.memoryStore = config.memoryStore;
    this.planManager = config.planManager;
    this.llmProvider = new LLMProvider(config.config);
    // W7：加载持久化的信任规则
    this.loadApprovalRules();
    this.toolManager = new ToolManager({
      fsAdapter: config.fsAdapter,
      terminalAdapter: config.terminalAdapter,
      mcpHub: config.mcpHub,
      checkpointManager: config.checkpointManager,
      codebaseIndexer: config.codebaseIndexer,
      planManager: config.planManager,
      config: config.config,
    });
  }

  async run(params: RunParams, emit: (event: AgentEvent) => void): Promise<{ success: boolean; error?: string }> {
    const { sessionId, workspaceId, prompt, history, mode, images, files, autoApprove } = params;

    if (this.runningSessions.get(sessionId)) {
      return { success: false, error: '该会话正在运行中' };
    }
    this.runningSessions.set(sessionId, true);

    // W1 新增：为本次会话创建 AbortController，abort() 调用会中断 LLM 流与读流
    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    // 设置工具会话上下文，启用快照回滚
    this.toolManager.setSessionContext(sessionId, workspaceId);

    try {
      const basePrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.ask;
      const customPrompt = this.config.get<string>('agentConfig.systemPrompt', '');
      // 注入运行时平台/Shell 信息，让 LLM 选对命令（避免在 Windows PowerShell 上跑 GNU date 等 Linux 专用命令）
      const isWin = process.platform === 'win32';
      const shellInfo = isWin
        ? `\n\n[运行环境] 当前操作系统：Windows。Shell：PowerShell（execute_command 工具通过 PowerShell 执行命令）。\n` +
          `请优先使用 PowerShell 兼容的语法：\n` +
          `- 取当前日期时间：Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz' 或 Get-Date -UFormat '%Y-%m-%d %H:%M:%S'\n` +
          `- 列出文件：Get-ChildItem（别名 ls、dir），复制：Copy-Item，删除：Remove-Item（别名 rm、del），移动：Move-Item（别名 mv）\n` +
          `- 不要使用 GNU date '+%Y...'、ls -la --color=auto、sed -i、grep -P 等 GNU/Linux 专用命令，除非你确认 PowerShell 等价命令能工作\n` +
          `- 命令含单引号、双引号、$、反引号时务必用 PowerShell 语法转义，避免 -Command 拼接出错`
        : `\n\n[运行环境] 当前操作系统：${process.platform}。Shell：bash。`;
      // 回复格式：structured（默认，结构化 Markdown）/ plain（简洁纯文本）
      const replyFormat = this.config.get<string>('agentConfig.replyFormat', 'structured');
      const replyRule = replyFormat === 'plain' ? '' : REPLY_FORMAT_STRUCTURED;
      // W3：当 PlanManager 启用时，注入任务规划引导
      const planGuide = this.planManager ? PLAN_GUIDE : '';
      // 基础 Prompt = 核心身份准则 + 模式专属 Prompt + 用户自定义 Prompt
      const fullBasePrompt = `${BASE_SYSTEM_PROMPT}\n\n${basePrompt}${customPrompt ? `\n\n${customPrompt}` : ''}`;
      let systemPrompt = fullBasePrompt + planGuide + shellInfo + replyRule;

      // 本地记忆：自动加载与当前工作区匹配的历史记忆（偏好/项目事实/摘要），
      // 让模型在多次调用之间延续上下文，用户无需重复交代相同背景
      const memorySettings = { ...MEMORY_DEFAULT_SETTINGS, ...(this.config.get<any>('memory.settings', {}) || {}) };
      if (this.memoryStore && memorySettings.enabled && memorySettings.autoLoad) {
        try {
          const memBlock = await this.memoryStore.buildInjection(workspaceId, memorySettings.injectBudgetChars);
          if (memBlock) systemPrompt += memBlock;
        } catch (err: any) {
          dbgLog(`[memory] injection failed: ${err.message}`);
        }
      }

      const tools = await this.toolManager.getAvailableTools(mode);
      const maxTurns = this.config.get<number>('agentConfig.maxTurns', 50);
      const messages = this.buildMessages(systemPrompt, history, prompt, images, files);

      let turn = 0;
      let currentMessages = messages;
      const totalUsage: any = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        model: '',
        prompt_tokens_details: { cached_tokens: 0, cache_miss_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      };
      // 反幻觉：记录本轮会话实际调用过的工具名集合，用于检测 AI 是否声称做了未做的事
      const sessionToolNames = new Set<string>();
      let hallucinationWarned = false;

      while (turn < maxTurns && this.runningSessions.get(sessionId)) {
        turn++;
        dbgLog(`[run] turn=${turn} session=${sessionId} msgCount=${currentMessages.length}`);

        const apiConfig = this.resolveApiConfig(turn, prompt, images);
        if (!apiConfig) {
          emit({ type: 'error', sessionId, data: { error: '未配置 API，请在设置中添加模型配置' } });
          return { success: false, error: '未配置 API' };
        }

        const response = await this.llmProvider.chat({
          apiConfig,
          messages: currentMessages,
          tools,
          temperature: this.config.get<number>('agentConfig.temperature', 0.7),
          topP: this.config.get<number>('agentConfig.topP', 1.0),
          stream: true,
          onStream: (delta: string) => {
            emit({ type: 'stream', sessionId, data: { delta } });
          },
          // W1：传递 signal + fallback + 重试/超时
          signal: abortController.signal,
          fallbackConfigs: this.getFallbackConfigs(),
          retry: {
            maxRetries: this.config.get<number>('agentConfig.maxRetries', 3),
            baseDelayMs: this.config.get<number>('agentConfig.retryBaseDelayMs', 1000),
            maxDelayMs: this.config.get<number>('agentConfig.retryMaxDelayMs', 8000),
          },
          timeout: {
            perAttemptTimeoutMs: this.config.get<number>('agentConfig.llmTimeoutMs', 60000),
            totalTimeoutMs: this.config.get<number>('agentConfig.llmTotalTimeoutMs', 180000),
          },
        });

        const assistantContent = response.content || '';
        const thinking = response.thinking || '';
        const toolCalls = response.toolCalls || [];
        if (response.usage) {
          totalUsage.prompt_tokens += response.usage.prompt_tokens || 0;
          totalUsage.completion_tokens += response.usage.completion_tokens || 0;
          totalUsage.total_tokens += response.usage.total_tokens || 0;
          // 累计缓存命中/未命中/写入等明细，供前端按真实 token 预估计费
          const pd = response.usage.prompt_tokens_details;
          if (pd) {
            totalUsage.prompt_tokens_details.cached_tokens += pd.cached_tokens || 0;
            totalUsage.prompt_tokens_details.cache_miss_tokens += pd.cache_miss_tokens || 0;
            totalUsage.prompt_tokens_details.cache_write_tokens += pd.cache_write_tokens || 0;
          }
          const cd = response.usage.completion_tokens_details;
          if (cd) {
            totalUsage.completion_tokens_details.reasoning_tokens += cd.reasoning_tokens || 0;
          }
        }
        // 记录实际使用的模型名，供前端预估计费金额（官网最新价格）
        totalUsage.model = apiConfig.model || totalUsage.model;
        // W11：更新 context 追踪并 emit 状态事件
        const contextState = this.contextTracker.update(
          sessionId,
          apiConfig.model,
          currentMessages,
          response.usage
        );
        emit({ type: 'context_state', sessionId, data: contextState });
        dbgLog(`[run] turn=${turn} contentLen=${assistantContent.length} toolCalls=${toolCalls.length}${toolCalls.map((c: any) => ` [${c.name}]`).join('')}`);

        if (thinking) {
          emit({ type: 'thinking', sessionId, data: { thinking } });
        }

        // 反幻觉：无工具调用的最终回复，先检测再 emit，避免把编造内容直接展示给用户
        if (!toolCalls || toolCalls.length === 0) {
          if (!hallucinationWarned) {
            const hallucination = this.detectHallucination(assistantContent, sessionToolNames);
            if (hallucination) {
              hallucinationWarned = true;
              dbgLog(`[run] hallucination detected: ${hallucination}`);
              // 注入用户消息让 LLM 重新生成，必须实际调用工具
              currentMessages.push(
                { role: 'assistant', content: assistantContent },
                {
                  role: 'user',
                  content: `⚠️ 系统检测到你的回复可能存在虚假描述：${hallucination}\n请重新回复：\n- 若该操作确实未执行：不要声称已完成，先调用工具实际执行，再如实报告结果；\n- 若该操作是在本对话之前的轮次中完成的：请明确说明完成时间与依据，不要含糊表述为刚完成；\n- 无论如何，绝不假装做了没做的事，工具没返回的成功不算成功。`,
                },
              );
              continue;
            }
          }
          if (assistantContent) {
            emit({ type: 'assistant', sessionId, data: { content: assistantContent } });
          }
          emit({ type: 'done', sessionId, data: { turns: turn, usage: totalUsage } });
          // 对话完成后的自动记忆提取（后台执行，不阻塞返回；失败静默）
          if (this.memoryStore) {
            void this.autoExtractMemories({ sessionId, workspaceId, prompt, assistantContent });
          }
          return { success: true };
        }

        if (assistantContent) {
          emit({ type: 'assistant', sessionId, data: { content: assistantContent } });
        }

        // W2 新增：并行工具调度
        // 1) 先统一 emit tool_call 让 UI 同步显示所有调用
        for (const call of toolCalls) {
          emit({ type: 'tool_call', sessionId, data: call });
        }

        const autoApproveRun = autoApprove ?? this.config.get<boolean>('agentConfig.autoApproveTools', false);
        const toolConcurrency = this.config.get<number>('agentConfig.toolConcurrency', 4);
        const policyMap = await this.buildToolPolicyMap();

        const scheduledResults = await scheduleToolCalls(
          toolCalls.map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments })),
          {
            concurrencyLimit: toolConcurrency,
            policyMap,
            execute: async (call) => {
              dbgLog(`[run] executing tool=${call.name} id=${call.id} autoApprove=${autoApproveRun}`);

              // 单个工具的审批（仍串行，但不同工具之间可并发）
              if (!autoApproveRun) {
                const approved = await this.requestToolApproval(sessionId, call as any);
                dbgLog(`[run] approval ${approved ? 'granted' : 'rejected'} for ${call.name}`);
                if (!approved) {
                  emit({ type: 'tool_result', sessionId, data: { toolCallId: call.id, result: '已拒绝' } });
                  return { __rejected: true, tool_call_id: call.id, content: '用户拒绝了此工具调用' };
                }
              }

              const result = await this.toolManager.execute(call.name, call.arguments);
              // 反幻觉：记录实际执行过的工具名
              sessionToolNames.add(call.name);
              const resultPreview = (typeof result === 'string'
                ? result
                : (result as any)?.output ?? (result as any)?.error ?? JSON.stringify(result)
              ).slice(0, 200);
              dbgLog(`[run] tool=${call.name} done: ${resultPreview}`);
              emit({ type: 'tool_result', sessionId, data: { toolCallId: call.id, result } });
              return result;
            },
          }
        );

        // 按 toolCalls 原始顺序生成 tool 消息（scheduleToolCalls 已保证顺序）
        const toolResults: any[] = [];
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          const res = scheduledResults[i].result;
          if (res && (res as any).__rejected) {
            toolResults.push({ tool_call_id: call.id, role: 'tool', content: (res as any).content });
          } else {
            toolResults.push({
              tool_call_id: call.id,
              role: 'tool',
              content: typeof res === 'string' ? res : JSON.stringify(res),
            });
          }
        }

        // 必须转成 OpenAI 标准格式：assistant.tool_calls 需 type/function 包装、arguments 为 JSON 字符串
        // tool 消息需 tool_call_id 字段，否则第二轮 API 请求会 400 或静默失败
        currentMessages = [
          ...currentMessages,
          {
            role: 'assistant',
            content: assistantContent || null,
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: {
                name: c.name,
                arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
              },
            })),
          },
          ...toolResults,
        ];
      }

      dbgLog(`[run] finished after ${turn} turns`);
      emit({ type: 'done', sessionId, data: { turns: turn, usage: totalUsage } });
      return { success: true };
    } catch (err: any) {
      dbgLog(`[run] ERROR: ${err.message}`);
      emit({ type: 'error', sessionId, data: { error: err.message } });
      return { success: false, error: err.message };
    } finally {
      this.runningSessions.delete(sessionId);
      this.abortControllers.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    // W1：真正中断正在进行的 LLM 流（fetch / reader.read 会被 signal 触发 abort）
    const ctrl = this.abortControllers.get(sessionId);
    if (ctrl) {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
      this.abortControllers.delete(sessionId);
    }
    // 拒绝所有未响应的工具审批
    for (const [requestId, resolver] of this.toolApprovals.entries()) {
      try {
        resolver(false);
      } catch {
        /* ignore */
      }
      this.toolApprovals.delete(requestId);
    }
    this.runningSessions.delete(sessionId);
  }

  /** 本次会话中 AI 修改过的文件列表（用于回滚/展示） */
  getModifiedFiles(): string[] {
    return this.toolManager.getModifiedFiles();
  }

  resolveToolApproval(requestId: string, approved: boolean): void {
    const resolver = this.toolApprovals.get(requestId);
    if (resolver) {
      resolver(approved);
      this.toolApprovals.delete(requestId);
    }
  }

  /**
   * 反幻觉检测：AI 在不带工具调用的最终回复中声称"已修改/测试通过"等操作，
   * 但整个会话流程从未实际调用过对应类别的工具 → 疑似编造。
   * 返回需澄清的描述；未检出返回 null。仅为兜底启发式，主防线在 system prompt。
   */
  private detectHallucination(content: string, sessionToolNames: Set<string>): string | null {
    if (!content) return null;
    const calledAny = (names: string[]) => names.some((n) => sessionToolNames.has(n));
    const writeTools = ['write_to_file', 'apply_diff', 'create_file', 'replace_in_file', 'rewrite_file', 'delete_file', 'rename_file', 'edit_file'];
    const execTools = ['execute_command', 'run_command'];

    const claims: string[] = [];
    // 1) 文件改动声称（修改/创建/写入/删除 + 明确宾语），但无写类工具执行记录
    const wroteClaim =
      /(?:已|我已经?)?(?:修改|更改|更新|优化|重构|新建|创建|写入|保存|删除|移除|补全)[^。！？\n]{0,12}(?:文件|代码|接口|函数|组件|配置|bug|Bug|BUG|问题|功能|README|readme|页面|文档)/.test(content) ||
      /已(?:完成|实现)[^。！？\n]{0,10}(?:修改|功能|重构|任务)/.test(content);
    if (wroteClaim && !calledAny(writeTools)) {
      claims.push('声称已修改/创建了文件，但没有文件写入类工具的执行记录');
    }
    // 2) 测试/构建/运行成功声称，但无命令执行工具记录
    const execClaim =
      /(?:测试|构建|编译|运行|验证|启动|执行)(?:已通过|通过|成功|完成|正常)/.test(content) ||
      /(?:通过了?测试|全部通过|构建成功|编译成功|运行成功|验证通过)/.test(content);
    if (execClaim && !calledAny(execTools)) {
      claims.push('声称测试/构建/运行已成功，但没有命令执行类工具的记录');
    }
    // 3) 声称读取/查看过具体文件内容，但无读取类工具记录
    const readClaim = /(?:查看了?|读(?:取|了)|检查了?|确认了?)[^。！？\n]{0,10}(?:文件|代码|源码|配置)/.test(content) &&
      !/(?:参考|根据|基于)已读取/.test(content);
    const readTools = ['read_file', 'get_file_outline', 'semantic_search', 'search_files', 'project_structure'];
    if (readClaim && !calledAny(readTools)) {
      claims.push('声称查看/读取了文件，但没有读取类工具的执行记录');
    }
    return claims.length > 0 ? claims.join('；') : null;
  }

  private buildMessages(systemPrompt: string, history: any[], prompt: string, images?: string[], files?: RunParams['files']): any[] {
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    // 历史裁剪：默认只保留最近 MAX_HISTORY_MESSAGES 条消息，防止多轮对话 prompt token 无限增长。
    // maxMode=true 时完整保留历史（尊重用户「Max 模式」意图）。
    const maxMode = this.config.get<boolean>('agentConfig.maxMode', false) === true;
    const maxHistory = this.config.get<number>('agentConfig.maxHistoryMessages', 20);
    let hist = Array.isArray(history) ? history : [];
    if (!maxMode && hist.length > maxHistory) {
      hist = hist.slice(hist.length - maxHistory);
    }
    for (const msg of hist) {
      if (msg.role === 'system') continue;
      if (msg.role === 'user') messages.push({ role: 'user', content: msg.content });
      else if (msg.role === 'assistant') messages.push({ role: 'assistant', content: msg.content });
    }
    // 用户上传文件：把文本内容拼到本次提问后，让 AI 能直接分析/处理。
    // 注意：文件内容只注入当前这轮，不写入历史 messages，避免多轮对话反复重复占用上下文。
    let text = prompt;
    if (files && files.length > 0) {
      const parts: string[] = [prompt];
      for (const f of files) {
        const sizeKB = f.size >= 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${f.size} B`;
        const truncNote = f.truncated ? `（内容过长已截断，仅展示前一部分）` : '';
        parts.push(
          `\n\n[用户上传的文件「${f.name}」(${sizeKB})${truncNote}，请分析或按需处理]\n` +
          `---- ${f.name} 内容开始 ----\n${f.content}\n---- ${f.name} 内容结束 ----`
        );
      }
      text = parts.join('\n');
    }
    if (images && images.length > 0) {
      const content: any[] = [{ type: 'text', text }];
      for (const img of images) {
        content.push({ type: 'image_url', image_url: { url: img.startsWith('data:') ? img : `data:image/png;base64,${img}` } });
      }
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: text });
    }
    return messages;
  }

  /**
   * W6：解析本轮应使用的 API 配置
   * - 第一轮（turn=0）启用路由决策（@mention 优先 / 任务特征 / 用户配置 / active 兜底）
   * - 后续轮次继续使用第一轮选定的配置，避免多轮间模型漂移
   */
  private resolveApiConfig(turn: number, prompt: string, images?: string[]): any {
    const configs = this.config.getApiKeyConfigs();
    const activeId = this.config.get<string>('activeApiConfigId');
    if (!configs || configs.length === 0) return null;

    const enableRouting = this.config.get<boolean>('agentConfig.enableRouting', true);
    if (!enableRouting || turn !== 0) {
      return configs.find((c: any) => c.id === activeId) || configs[0];
    }
    try {
      const userRouting = this.config.get<any>('agentConfig.routing') || undefined;
      const decision = decideModelFromPromptWithImages(
        prompt || '',
        configs as any,
        activeId,
        Array.isArray(images) && images.length > 0,
        userRouting
      );
      dbgLog(`[routing] turn=0 reason=${decision.reason} model=${decision.apiConfig.model} tier=${decision.caps.tier}`);
      return decision.apiConfig;
    } catch (err: any) {
      dbgLog(`[routing] failed: ${err.message}, fallback to active`);
      return configs.find((c: any) => c.id === activeId) || configs[0];
    }
  }

  private getActiveApiConfig(): any {
    const configs = this.config.getApiKeyConfigs();
    const activeId = this.config.get<string>('activeApiConfigId');
    return configs.find((c: any) => c.id === activeId) || configs[0];
  }

  /**
   * W1 新增：构建 Fallback 链
   * 优先级：1) 显式 fallbackModelIds 配置 2) 其它已启用的 API 配置
   * 主配置失败后依次尝试，跳过已禁用或同 model 的配置
   */
  private getFallbackConfigs(): any[] {
    const primary = this.getActiveApiConfig();
    if (!primary) return [];
    const all = this.config.getApiKeyConfigs().filter((c: any) => c && !c.disabled);
    const explicit = this.config.get<string[]>('agentConfig.fallbackModelIds', []) || [];

    let fallbacks: any[] = [];
    if (explicit.length > 0) {
      fallbacks = explicit
        .map((id) => all.find((c: any) => c.id === id))
        .filter((c: any) => c && c.id !== primary?.id);
    } else {
      fallbacks = all.filter((c: any) => c.id !== primary?.id);
    }
    return fallbacks.slice(0, 3); // 最多 3 个 fallback，避免 fallback 链过长
  }

  /**
   * 对话完成后的自动记忆提取（后台执行）：
   * 开启 memory.settings.autoExtract 时，用 LLM 提炼本轮值得长期保存的信息并写入记忆库
   */
  private async autoExtractMemories(opts: { sessionId: string; workspaceId: string; prompt: string; assistantContent: string }): Promise<void> {
    const memoryStore = this.memoryStore;
    if (!memoryStore) return;
    const settings = { ...MEMORY_DEFAULT_SETTINGS, ...(this.config.get<any>('memory.settings', {}) || {}) };
    if (!settings.enabled || !settings.autoExtract) return;
    const apiConfig = this.getActiveApiConfig();
    if (!apiConfig) return;
    const answer = (opts.assistantContent || '').trim();
    if (!answer || answer.startsWith('Error:')) return;
    try {
      const src = `[用户请求]\n${opts.prompt.slice(0, 800)}\n\n[AI 回复]\n${answer.slice(0, 3000)}`;
      const response = await this.llmProvider.chat({
        apiConfig,
        messages: [
          { role: 'system', content: MEMORY_EXTRACT_SYSTEM },
          { role: 'user', content: src },
        ],
        temperature: 0.2,
        stream: false,
      });
      const parsed = parseExtractedMemories(response.content || '');
      let added = 0;
      for (const m of parsed.slice(0, 3)) {
        const res = await memoryStore.add({
          content: m.content,
          type: m.type,
          scope: m.scope,
          workspaceId: m.scope === 'workspace' ? opts.workspaceId : undefined,
          importance: m.importance,
          expiresInDays: MEMORY_LIMITS.autoExpireDays,
          source: 'auto',
        });
        if (res.success) added++;
      }
      dbgLog(`[memory] autoExtract session=${opts.sessionId} saved=${added}/${parsed.length}`);
    } catch (err: any) {
      dbgLog(`[memory] autoExtract failed: ${err.message}`);
    }
  }

  /**
   * W2：构建工具并发策略映射
   * 内置工具按 DEFAULT_TOOL_POLICIES，MCP 工具默认全局串行（安全保守）
   */
  private async buildToolPolicyMap(): Promise<Record<string, import('../tools/ParallelToolScheduler').ParallelPolicy>> {
    const policyMap: Record<string, import('../tools/ParallelToolScheduler').ParallelPolicy> = { ...DEFAULT_TOOL_POLICIES };
    try {
      const mcpTools = await this.mcpHub.getAllTools();
      for (const t of mcpTools || []) {
        // MCP 工具默认全局串行；若服务端声明 parallel='safe' 则允许并发
        policyMap[`mcp__${t.serverId}__${t.name}`] = (t as any).parallel || 'global-serial';
      }
    } catch {
      /* ignore mcp errors */
    }
    return policyMap;
  }

  /**
   * AI 一键增强：把用户输入的简短/模糊描述重写为更清晰、详细、可执行的提示词
   */
  async enhancePrompt(text: string): Promise<{ success: boolean; enhanced?: string; error?: string }> {
    const apiConfig = this.getActiveApiConfig();
    if (!apiConfig) {
      return { success: false, error: '未配置 API，请在设置中添加模型配置' };
    }
    try {
      const response = await this.llmProvider.chat({
        apiConfig,
        messages: [
          {
            role: 'system',
            content: '你是一个专业的提示词优化助手。请把用户输入的简短、模糊、口语化的需求，改写成一条清晰、具体、结构化的高质量提示词，让 AI 编程助手能准确理解并执行。要求：1) 保留原意，不添油加醋；2) 补充必要的上下文、目标和验收标准；3) 用简洁的祈使句；4) 直接输出优化后的提示词本身，不要任何解释、前缀或引号。',
          },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        stream: false,
      });
      const enhanced = (response.content || '').trim();
      if (!enhanced) {
        return { success: false, error: '增强结果为空' };
      }
      return { success: true, enhanced };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * 手动上下文压缩：用 LLM 把早期对话历史摘要为一段文本。
   * 供 session:summarize IPC 调用（UI 上的「压缩上下文」按钮）。
   */
  async summarizeContext(sessionId: string, messages: any[]): Promise<string> {
    const apiConfig = this.getActiveApiConfig();
    if (!apiConfig) {
      throw new Error('未配置 API，无法压缩上下文');
    }
    const msgs = Array.isArray(messages) ? messages : [];
    // 保留最近 6 轮 user/assistant，压缩更早的历史
    const conversation = msgs.filter((m: any) => m.role !== 'system');
    const userIndices: number[] = [];
    for (let i = 0; i < conversation.length; i++) {
      if (conversation[i].role === 'user') userIndices.push(i);
    }
    if (userIndices.length <= 6) {
      return '(历史较短，无需压缩)';
    }
    const splitUserIdx = userIndices[userIndices.length - 6];
    const toCompress = conversation.slice(0, splitUserIdx);
    const src = toCompress
      .map((m: any) => {
        const role = m.role === 'assistant' ? 'AI' : '用户';
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${role}: ${c.slice(0, 1500)}`;
      })
      .join('\n\n');
    const response = await this.llmProvider.chat({
      apiConfig,
      messages: [
        { role: 'system', content: SUMMARIZE_CONTEXT_PROMPT },
        { role: 'user', content: src.slice(0, 12000) },
      ],
      temperature: 0.3,
      stream: false,
    });
    return (response.content || '').trim() || '(压缩失败：摘要为空)';
  }

  private async requestToolApproval(sessionId: string, toolCall: any): Promise<boolean> {
    // W7：先评估审批策略（信任规则）
    const decision = this.approvalPolicy.evaluate({ name: toolCall.name, arguments: toolCall.arguments || {} });
    if (decision.action === 'allow') {
      dbgLog(`[approval] auto-allow ${toolCall.name}: ${decision.reason}`);
      return true;
    }
    if (decision.action === 'deny') {
      dbgLog(`[approval] auto-deny ${toolCall.name}: ${decision.reason}`);
      return false;
    }
    // ask：弹窗等用户决策
    const requestId = randomUUID();
    // 用稳定主窗口引用，回退到焦点窗口/所有窗口，避免窗口失焦时审批请求发不出去导致工具卡死
    const win = this.windowAdapter.getMainWindow()
      || BrowserWindow.getFocusedWindow()
      || BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('tool:approve-request', { requestId, sessionId, toolCall });
    }
    return new Promise<boolean>((resolve) => {
      this.toolApprovals.set(requestId, resolve);
      // 60秒超时自动拒绝
      setTimeout(() => {
        if (this.toolApprovals.has(requestId)) {
          this.toolApprovals.delete(requestId);
          resolve(false);
        }
      }, 60000);
    });
  }

  /** W7：添加信任规则（运行时 API，UI 调用） */
  addApprovalRule(rule: ApprovalRule): void {
    this.approvalPolicy.add(rule);
    const current = this.config.get<ApprovalRule[]>('agentConfig.approvalRules', []) || [];
    current.push({ ...rule, createdAt: rule.createdAt || Date.now() });
    this.config.set('agentConfig.approvalRules', current);
  }

  /** W7：列出当前规则 */
  listApprovalRules(): ApprovalRule[] {
    return this.approvalPolicy.list();
  }

  /** W7：删除规则 */
  removeApprovalRule(index: number): boolean {
    const ok = this.approvalPolicy.remove(index);
    if (ok) {
      this.config.set('agentConfig.approvalRules', this.approvalPolicy.list());
    }
    return ok;
  }

  /** W7：启动时从 ConfigAdapter 加载规则 */
  loadApprovalRules(): void {
    const rules = this.config.get<ApprovalRule[]>('agentConfig.approvalRules', []) || [];
    this.approvalPolicy.load(rules);
  }

  /** W11：获取会话的 context 状态 */
  getContextState(sessionId: string): ContextState | undefined {
    return this.contextTracker.get(sessionId);
  }

  /** W11：列出所有会话的 context 状态 */
  listContextStates(): ContextState[] {
    return this.contextTracker.list();
  }

  /** W11：删除会话时清理 */
  removeContextState(sessionId: string): void {
    this.contextTracker.remove(sessionId);
  }
}
