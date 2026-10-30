import { LLMProvider } from '../llm/LLMProvider';
import { routeFastestModel, selectRoutingCandidates } from '../llm/ModelRouter';
import { readModelLatency } from '../llm/ModelLatency';
import { resolveConversation, conversationInstruction } from './ConversationRouter';
import { ToolManager, SUBAGENT_TOOL_NAME, AUTOFIX_TOOL_NAME } from '../tools/ToolManager';
import { runTests as runProjectTests } from '../tools/TestRunner';
import { runAutoFixLoop, formatAutoFixReport, clampRounds } from './AutoFixLoop';
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
import { SkillRegistry } from '../skills/SkillRegistry';
import { BUILTIN_PROMPT_SKILLS } from '../skills/builtins';
import { ApprovalPolicy, ApprovalRule, PolicyDecision } from '../checkpoint/ApprovalPolicy';
import { evaluatePermission, normalizeMode, PermissionResult } from '../checkpoint/PermissionTier';
import { ContextTracker, ContextState } from './ContextTracker';
import { ContextCompressor } from './ContextCompressor';
import { SubAgentManager, SubAgentType, SubAgentResult, SubAgentExecutor, EXPLORE_TOOLS } from './SubAgentManager';
import { loadProjectInstructions } from './ProjectInstructions';
import { detectCapabilities } from '../llm/ProviderCapabilities';
import { RagManager } from '../rag/RagManager';
import { MockImageGenAdapter, OpenAIImageGenAdapter } from '../tools/ImageGenTools';
import { randomUUID } from 'node:crypto';
// 诊断日志：定位"对话没反应/工具卡住"问题。默认关闭，需 CNKE_DEBUG_LOG 环境变量开启。
import { dbgLog } from '../util/dbgLog';

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
  /** RAG 文档索引（可选）；由主进程创建并在全部会话中复用。 */
  ragManager?: RagManager;
  /** P0：统一的技能注册表，提供本地包扫描和提示词技能组合 */
  skillRegistry: SkillRegistry;
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
  autoInteraction?: boolean;
  originalPrompt?: string;
}

export interface AgentEvent {
  type: 'start' | 'thinking' | 'assistant' | 'tool_call' | 'tool_result' | 'tool_progress' | 'done' | 'error' | 'stream' | 'context_state' | 'model_fallback' | 'context_compressed' | 'approval_request' | 'approval_resolved' | 'autofix_progress' | 'model_routed';
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
//
// 说明：这里的每一条都对应一个真实出现过的渲染缺陷，不是风格偏好。
// 见 renderer/src/components/chat/Markdown.tsx 的 CodeBlock——单行内容若被
// 包进围栏代码块，会渲染成占满宽度的空灰框（截图里的 create_file /
// apply_diff / rename_file 就是这种退化形态）。
const REPLY_FORMAT_STRUCTURED = `


[回复格式要求] 你的最终回复请使用结构正确、语义合理、渲染稳定的 Markdown（若只需一句简短确认则可例外）：
不出现标题层级混乱、列表嵌套错误、代码块未闭合、表格错位、加粗斜体滥用。

一、代码块（最容易出错，重点遵守）
1. 只有"多行代码、脚本、配置、命令片段、JSON、YAML、日志、目录树"才用 \`\`\` 围栏代码块，并务必标注语言（如 \`\`\`bash、\`\`\`python、\`\`\`json、\`\`\`text）。
2. 单行内容一律不要用围栏代码块，包括：文件名、路径、工具名、函数名、参数、字段名、键名、命令名、枚举值。这些一律用行内代码 \` \`（单个反引号）包裹。
   - 正确：用 \`apply_diff\` 做精确替换，涉及 \`AgentManager.ts\`。
   - 错误：把 \`apply_diff\` 单独放进三反引号代码块（会渲染成一个占满宽度的空灰框）。
3. 围栏必须成对闭合，开启与闭合的反引号数量一致；代码块内不要出现未转义的三反引号。
4. 代码块前后各留一个空行，不要紧贴段落文字。
5. 代码块内只放代码本身，不要写行号、不要写"输出："之类的前缀说明，说明文字放在代码块外面。

二、标题
6. 从 ## 起用（# 一级标题留给消息本身，不要使用）。层级严格递进，不要从 ## 直接跳到 ####，不要用标题代替普通强调。
7. 一次回复内标题不超过两级；内容不足一个小节时，用加粗短句而不是标题。

三、列表
8. 要点用 - 无序列表或 1. 有序列表；同层级列表符号保持一致，不要混用 - 和 *。
9. 嵌套必须缩进 2-4 个空格，不要用制表符；嵌套不超过 2 层，超过就考虑改用表格。
10. 列表项内容较长时，续行统一缩进对齐到该项文字起始位置，避免被解析成新列表。
11. 列表项内不要夹入空行（会被解析为松散列表，间距突变）；确需分段时改用小标题。

四、表格
12. 表格必须给出分隔行（| --- | --- |）且每行竖线数量与表头一致；单元格内容不要包含未转义的 |。
13. 列数控制在 2-4 列；单元格文字简短，长内容改写成列表，避免错位与横向溢出。

五、强调与其它
14. 加粗只用于结论、关键参数、风险提示，一段内不超过 2-3 处；不要整段加粗，不要用加粗代替标题。
15. 斜体、删除线原则上不用；不要用连续多个星号或下划线做装饰分隔线，章节之间用空行分隔。
16. 引用外部链接用 [文字](url)，不要裸露长 URL。
17. 路径、文件名、对象名、参数、ID、术语、字段名、键名一律使用行内代码 \` \` 包裹。

六、整体
18. 先给结论：开头用一两句话直接回答核心问题，不要铺垫和客套。
19. 操作步骤分步编号；需要总结时在末尾用「小结」小节，最多 3 条。
20. 长度适中：能列表不写长句，能表格不用段落；不要为凑结构而制造空标题或空列表。
21. 输出前自查：围栏是否成对、表格列数是否一致、列表缩进是否规范、是否存在本该行内代码却被写成代码块的单行内容。`;

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

// W26：git 写操作引导。让模型优先走结构化 git 工具，而不是用 execute_command 拼 shell，
// 否则写操作既绕过了审批规则，也绕过了只读档位拦截。
const GIT_GUIDE = `

[版本控制]
涉及 git 操作时优先使用内置 git 工具，不要用 execute_command 拼 \`git ...\` 命令（后者绕过了审批与只读档位）：
- 查看：git_status（分支 + 变更）、git_diff、git_log
- 分支：git_branch（action=list 列出 / create 新建 / delete 删除 / rename 改名）。新建默认不切换工作区，需要顺带切换时传 checkout=true
- 切换：git_checkout（target 可为分支或提交；从某点新建用 create=true + startPoint）
- 同步：git_fetch 拉取远端引用；git_pull 默认 --ff-only，若历史分叉会失败并返回提示，此时不要自作主张 merge，先问用户是否改用 rebase=true
- 推送：git_push 从不 force；main/master 是受保护分支，除非用户明确同意，否则不要传 allowProtected=true
- 提交：git_commit 只提交已暂存内容；执行前先确认用户意图与提交信息
分支名必须是合法 ref（不含空格、~ ^ : ? * [ \\ .. 等）。只读档位下所有写操作会被拦截，此时只做只读操作并告知用户原因。`;


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
  /**
   * 每会话的事件发送器。run() 主流程里 emit 由参数传入，
   * 但审批发生在 run 的闭包之外（requestToolApproval / abort），
   * 这里保存一份引用，让这些路径也能把事件推给渲染层。
   */
  private sessionEmitters: Map<string, (event: AgentEvent) => void> = new Map();
  /** 待审批工具请求：requestId → { sessionId, resolver }（按会话隔离，abort 时只拒绝本会话） */
  private toolApprovals: Map<string, { sessionId: string; resolver: (approved: boolean) => void }> = new Map();
  /** W3 新增：PlanManager（可选） */
  private planManager?: PlanManager;
  /** P0：本地/内置技能注册表 */
  private skillRegistry: SkillRegistry;
  /** W7 新增：审批策略（信任规则） */
  private approvalPolicy: ApprovalPolicy = new ApprovalPolicy();
  /**
   * headless（CLI）注入的审批裁决函数。
   * 返回 true/false 表示直接放行/拒绝且不等待界面响应；返回 undefined 则回落默认流程。
   * GUI 场景不注入，行为与之前完全一致。
   */
  private approvalHandler?: (toolCall: any) => boolean | undefined | Promise<boolean | undefined>;
  /** W11 新增：上下文窗口实时追踪 */
  private contextTracker: ContextTracker = new ContextTracker();
  /** 浏览器初始化只执行一次，图片适配器则会在每次运行前读取最新配置。 */
  private browserInit?: Promise<void>;
  /** 技能目录扫描缓存时间戳：目录内容短时间内不会变，避免每条消息都重扫磁盘 */
  private lastSkillScanAt = 0;
  /** W8：上下文自动压缩器（超阈值时把早期历史摘要为单条 system 消息） */
  private contextCompressor = new ContextCompressor();
  /** W8：子 Agent 委派管理器（delegate_subagent 工具的实现方） */
  private subAgentManager = new SubAgentManager();

  constructor(config: AgentConfig) {
    this.config = config.config;
    this.mcpHub = config.mcpHub;
    this.windowAdapter = config.windowAdapter;
    this.checkpointManager = config.checkpointManager;
    this.memoryStore = config.memoryStore;
    this.planManager = config.planManager;
    this.skillRegistry = config.skillRegistry;
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
      ragManager: config.ragManager,
    });

    // 预热浏览器适配器：enablePlaywright 内部是动态 import('playwright')，
    // 首次调用要几十到几百毫秒。放在构造期后台跑，用户第一条消息不必等这一下。
    if (this.config.get<boolean>('agentConfig.browserAutomation.enabled', true)) {
      this.browserInit = this.toolManager.enablePlaywright().then(() => undefined).catch(() => undefined);
    }
  }

  /** 在工具列表发送给模型前准备可选运行时能力，失败时保留清晰的降级提示。 */
  private async prepareOptionalTools(): Promise<void> {
    if (this.config.get<boolean>('agentConfig.browserAutomation.enabled', true) && !this.browserInit) {
      this.browserInit = this.toolManager.enablePlaywright().then(() => undefined).catch(() => undefined);
    }
    await this.browserInit;

    const imageConfig = this.config.get<{ enabled?: boolean; apiConfigId?: string }>('agentConfig.imageGeneration', {});
    if (!imageConfig?.enabled) {
      this.toolManager.setImageGenAdapter(new MockImageGenAdapter());
      return;
    }

    const apiConfigs = this.config.getApiKeyConfigs();
    const id = imageConfig.apiConfigId || this.config.get<string>('activeApiConfigId', '');
    const api = apiConfigs.find((item: any) => item.id === id);
    if (api?.apiKey && api?.baseUrl) {
      this.toolManager.setImageGenAdapter(new OpenAIImageGenAdapter(api.apiKey, api.baseUrl.replace(/\/$/, '')));
    } else {
      this.toolManager.setImageGenAdapter(new MockImageGenAdapter());
    }
  }

  async run(params: RunParams, emit: (event: AgentEvent) => void): Promise<{ success: boolean; error?: string; aborted?: boolean }> {
    const { sessionId, workspaceId, prompt, images, files, autoApprove } = params;
    const conversation = resolveConversation(
      params.originalPrompt ?? prompt, workspaceId, params.history,
      params.autoInteraction === true ? undefined : params.mode,
    );
    const mode = conversation.decision.mode;
    const history = conversation.history;

    if (this.runningSessions.get(sessionId)) {
      return { success: false, error: '该会话正在运行中' };
    }
    this.runningSessions.set(sessionId, true);

    // W1 新增：为本次会话创建 AbortController，abort() 调用会中断 LLM 流与读流
    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);
    // 保存 emit 引用，供审批等非主流程路径回推事件；同时通知渲染层本轮开始（用于计时/阶段态）
    this.sessionEmitters.set(sessionId, emit);
    emit({ type: 'start', sessionId, data: { mode } });

    // 设置工具会话上下文，启用快照回滚
    this.toolManager.setSessionContext(sessionId, workspaceId);

    try {
      await this.prepareOptionalTools();
      const basePrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.ask;
      let customPrompt = this.config.get<string>('agentConfig.systemPrompt', '');
      // 只读刷新本地技能目录。扫描失败不会影响普通对话，也绝不执行技能脚本。
      // 30s 内复用上次扫描结果：技能目录不会在两条消息之间变化，没必要每轮重扫磁盘。
      if (Date.now() - this.lastSkillScanAt > 30000) {
        await this.skillRegistry.scan();
        this.lastSkillScanAt = Date.now();
      }
      const enabledSkills = this.config.get<unknown>('enabledSkills', []);
      // 兼容旧版本：过去点选单个技能会将其完整提示词覆盖进用户自定义字段。
      // 若当前字段与某个已启用内置技能完全相同，运行时去重而不改写用户配置。
      const enabledIds = new Set(Array.isArray(enabledSkills) ? enabledSkills : []);
      if (BUILTIN_PROMPT_SKILLS.some((skill) => enabledIds.has(skill.id) && customPrompt.trim() === skill.systemPrompt.trim())) {
        customPrompt = '';
      }
      const skillPrompt = this.skillRegistry.getEnabledPrompt(enabledSkills);
      const packageSkillGuidance = this.skillRegistry.getEnabledPackageGuidance(enabledSkills);
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
      // W26：ask 模式不带工具，注入 git 引导反而会误导模型，故只在有工具的模式下注入
      const gitGuide = mode === 'ask' || mode === 'architect' ? '' : GIT_GUIDE;
      // 基础 Prompt = 核心身份准则 + 模式专属 Prompt + 用户自定义 Prompt + 全部启用提示词技能。
      // 这避免旧实现“最后点击的技能覆盖前一个技能”的互斥行为。
      const fullBasePrompt = `${BASE_SYSTEM_PROMPT}\n\n${basePrompt}${customPrompt ? `\n\n${customPrompt}` : ''}${skillPrompt}${packageSkillGuidance}`;
      // 工作区锚点：必须显式告知模型当前工作区根目录，否则模型只能靠猜
      // 相对路径（项目里最自然的写法），导致 read_file("src/a.ts") 直接 ENOENT。
      const workspaceInfo = this.buildWorkspaceInfo(workspaceId);
      let systemPrompt = fullBasePrompt + planGuide + gitGuide + workspaceInfo + shellInfo + replyRule + conversationInstruction(conversation.decision);

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

      // W24：仓库级指令文件（AGENTS.md / CNKE.md）。
      // 把项目自己的约定（命名/目录/构建命令/禁区）按目录层级读出来注入，
      // 用户不必每个会话重复交代；开关与预算都在设置面板里可调。
      if (workspaceId && this.config.get<boolean>('agentConfig.useProjectInstructions', true)) {
        try {
          const budget = this.config.get<number>('agentConfig.projectInstructionsBudget', 24000);
          const instructions = await loadProjectInstructions({ root: workspaceId, maxTotalBytes: budget });
          if (instructions.block) {
            systemPrompt += instructions.block;
            dbgLog(
              `[instructions] injected ${instructions.files.length} file(s) / ${instructions.totalBytes}B: ` +
                instructions.files.map((f) => f.relPath).join(', ')
            );
          }
        } catch (err: any) {
          dbgLog(`[instructions] injection failed: ${err.message}`);
        }
      }

      const tools = await this.toolManager.getAvailableTools(mode);
      const maxTurns = this.config.get<number>('agentConfig.maxTurns', 50);
      const messages = this.buildMessages(systemPrompt, history, prompt, images, files);

      let turn = 0;
      let currentMessages = messages;
      // run 级"实际应答配置"缓存：主配置失败被 fallback 替换后，后续 turn 直接沿用，
      // 避免每轮都对失败的主配置重复重试（每次最多 3 次重试 + 超时）。
      // 每次新 run（新消息）都会重置，用户切换模型后下一条消息立即生效。
      let activeRunConfig: any = null;
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

      // 流式增量合并：模型每个 token 都会回调一次，原样转发意味着每秒几十次
      // IPC + 渲染层 setState + Markdown 重解析，长回答时界面明显发卡、主进程也被
      // 序列化拖慢。这里按 40ms / 320 字符合并，视觉上仍是逐字输出，事件量降一个数量级。
      let streamBuf = '';
      let streamTimer: NodeJS.Timeout | null = null;
      let firstTokenAt = 0;
      const flushStream = () => {
        if (streamTimer) {
          clearTimeout(streamTimer);
          streamTimer = null;
        }
        if (!streamBuf) return;
        const delta = streamBuf;
        streamBuf = '';
        emit({ type: 'stream', sessionId, data: { delta } });
      };
      const pushStream = (delta: string) => {
        if (!delta) return;
        if (!firstTokenAt) firstTokenAt = Date.now();
        streamBuf += delta;
        if (streamBuf.length >= 320) {
          flushStream();
          return;
        }
        if (!streamTimer) {
          streamTimer = setTimeout(() => {
            streamTimer = null;
            flushStream();
          }, 40);
        }
      };

      // 工具并行策略在本次 run 内不会变（只依赖内置策略表 + MCP 工具元数据），
      // 提到循环外计算，避免每轮重复读取配置与 MCP 工具列表。
      const toolPolicyMap = await this.buildToolPolicyMap();

      while (turn < maxTurns && this.runningSessions.get(sessionId)) {
        turn++;
        dbgLog(`[run] turn=${turn} session=${sessionId} msgCount=${currentMessages.length}`);

        let apiConfig = activeRunConfig;
        if (!apiConfig) {
          // 历史中含 ≥3 条工具结果视为重工具链任务，路由时直接上旗舰档
          const heavyToolUse = currentMessages.filter((m: any) => m && m.role === 'tool').length >= 3;
          apiConfig = this.resolveApiConfig(turn, prompt, images, mode, (data) => {
            emit({ type: 'model_routed', sessionId, data });
          }, heavyToolUse);
          // 首轮路由结果作为本次 run 的"实际应答配置"缓存，避免多轮漂移。
          if (turn === 1 && apiConfig) activeRunConfig = apiConfig;
        }
        if (!apiConfig) {
          emit({ type: 'error', sessionId, data: { error: '未配置 API，请在设置中添加模型配置' } });
          return { success: false, error: '未配置 API' };
        }

        // W8：请求前先做上下文自动压缩。多轮工具调用（每轮都会追加 assistant + tool 消息）
        // 会让 prompt 持续膨胀，撞上窗口上限后请求直接失败且用户无从下手。
        currentMessages = await this.autoCompressContext(sessionId, currentMessages, apiConfig, emit);

        const llmStart = Date.now();
        const response = await this.llmProvider.chat({
          apiConfig,
          messages: currentMessages,
          tools,
          temperature: this.config.get<number>('agentConfig.temperature', 0.7),
          topP: this.config.get<number>('agentConfig.topP', 1.0),
          stream: true,
          onStream: pushStream,
          // W1：传递 signal + fallback + 重试/超时
          signal: abortController.signal,
          fallbackConfigs: this.getFallbackConfigs(apiConfig),
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
        // 必须先把残留增量落地，再发 assistant/thinking，保证文本顺序正确
        flushStream();
        const llmMs = Date.now() - llmStart;

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
        // 实际应答配置：LLMProvider 主配置失败时会按 fallback 链自动降级，resolvedConfig 才是
        // 真正生成回复的配置。静默降级会让用户以为切换模型成功但实际仍用旧模型（且计费估算
        // 按错误模型计算），因此必须：1) 修正 usage.model 为真实模型；2) 显式通知 UI。
        const actualConfig = response.resolvedConfig || apiConfig;
        if (actualConfig && actualConfig.id !== apiConfig.id) {
          dbgLog(
            `[run] model fallback: requested=${apiConfig.model || '?'} -> actual=${actualConfig.model || '?'}`
          );
          emit({
            type: 'model_fallback',
            sessionId,
            data: {
              requestedModel: apiConfig.model || '',
              actualModel: actualConfig.model || '',
              actualName: actualConfig.name || actualConfig.model || '',
            },
          });
          activeRunConfig = actualConfig;
        }
        // 记录实际使用的模型名，供前端预估计费金额（官网最新价格）
        totalUsage.model = actualConfig.model || totalUsage.model;
        // W11：更新 context 追踪并 emit 状态事件
        const contextState = this.contextTracker.update(
          sessionId,
          actualConfig.model,
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
          // 无 tool_calls 有两种可能：模型正常收尾，或用户 abort 后 LLM 返回截断内容。
          // 后者不能报"完成"，也不应触发记忆提取（残缺回答会被当成结论记住）。
          const abortedHere = !this.runningSessions.get(sessionId);
          emit({ type: 'done', sessionId, data: { turns: turn, usage: totalUsage, aborted: abortedHere } });
          // 对话完成后的自动记忆提取（后台执行，不阻塞返回；失败静默）
          if (this.memoryStore && !abortedHere) {
            void this.autoExtractMemories({ sessionId, workspaceId, prompt, assistantContent });
          }
          return { success: true, aborted: abortedHere };
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
        const toolStart = Date.now();

        const scheduledResults = await scheduleToolCalls(
          toolCalls.map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments })),
          {
            concurrencyLimit: toolConcurrency,
            policyMap: toolPolicyMap,
            execute: async (call) => {
              if (!tools.some((tool) => tool.name === call.name)) {
                const result = { success: false, error: `当前 ${mode} 模式未授权工具 ${call.name}` };
                emit({ type: 'tool_result', sessionId, data: { toolCallId: call.id, result } });
                return result;
              }
              dbgLog(`[run] executing tool=${call.name} id=${call.id} autoApprove=${autoApproveRun}`);

              // W8：子 Agent 委派需要独立的多轮 LLM 循环，ToolManager 承载不了，故在此拦截。
              // 委派本身不是破坏性操作，其内部工具调用各自走审批策略（见 runSubAgent）。
              if (call.name === SUBAGENT_TOOL_NAME) {
                const sub = await this.runSubAgent(
                  sessionId,
                  call.arguments || {},
                  abortController.signal,
                  autoApproveRun
                );
                const text = sub.success
                  ? `[子 Agent 完成] 轮数 ${sub.turns}，工具调用 ${sub.toolCallCount} 次\n\n${sub.output || '(无输出)'}`
                  : `[子 Agent 失败] ${sub.error || '未知错误'}`;
                // 反幻觉：子 Agent 实际执行了工具，记录在案
                sessionToolNames.add(call.name);
                emit({ type: 'tool_result', sessionId, data: { toolCallId: call.id, result: text } });
                dbgLog(`[run] subagent done: success=${sub.success} turns=${sub.turns}`);
                return text;
              }

              // W25：权限档位闸门（先于审批）。只读档下的写文件/执行命令连弹窗都不弹，
              // 直接拦掉并把原因回给模型——否则自动放行模式会把只读档形同虚设。
              const permission = this.evaluateToolPermission(call.name, call.arguments || {});
              if (permission.action === 'deny') {
                const blocked = permission.message || `⛔ 已被权限档位拦截：${permission.reason}`;
                dbgLog(`[permission] deny ${call.name} (mode=${permission.mode}, effect=${permission.effect}): ${permission.reason}`);
                emit({ type: 'tool_result', sessionId, data: { toolCallId: call.id, result: blocked } });
                return { __rejected: true, tool_call_id: call.id, content: blocked };
              }
              dbgLog(`[permission] ${permission.action} ${call.name} (mode=${permission.mode}, effect=${permission.effect})`);

              // 单个工具的审批（仍串行，但不同工具之间可并发）
              if (!autoApproveRun) {
                const approved = await this.requestToolApproval(sessionId, call as any, permission);
                dbgLog(`[run] approval ${approved ? 'granted' : 'rejected'} for ${call.name}`);
                if (!approved) {
                  emit({ type: 'tool_result', sessionId, data: { toolCallId: call.id, result: '已拒绝' } });
                  return { __rejected: true, tool_call_id: call.id, content: '用户拒绝了此工具调用' };
                }
              }

              // W27：自愈循环需要「跑测试 → LLM 改代码 → 再跑」的多轮流程，ToolManager 承载不了，故在此拦截。
              // 注意位置在审批之后：它本身是 exec 类操作，先让用户为"要跑测试并改代码"这件事点一次头。
              if (call.name === AUTOFIX_TOOL_NAME) {
                const text = await this.runAutoFix(
                  sessionId,
                  workspaceId,
                  call.arguments || {},
                  abortController.signal,
                  autoApproveRun
                );
                sessionToolNames.add(call.name);
                emit({ type: 'tool_result', sessionId, data: { toolCallId: call.id, result: text } });
                dbgLog(`[run] autofix done`);
                return text;
              }

              // 中断信号下钻到工具层：abort 后正在跑的长命令/构建会被真正杀掉
              const result = await this.toolManager.execute(
                call.name,
                call.arguments,
                abortController.signal,
                // 长命令（全盘扫描等）的实时进度：转成 tool_progress 事件推给前端
                (p) => emit({ type: 'tool_progress', sessionId, data: { toolCallId: call.id, ...p } }),
              );
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
        const toolMs = Date.now() - toolStart;

        // 每轮耗时拆解：定位"慢"到底花在模型、工具还是审批等待上。
        // ttft（首字延迟）远小于 llm 说明是模型在思考/长输出；tools 占比高说明工具或审批在拖。
        const promptChars = currentMessages.reduce(
          (n, m: any) => n + (typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length),
          0
        );
        dbgLog(
          `[perf] turn=${turn} ttft=${firstTokenAt ? firstTokenAt - llmStart : -1}ms llm=${llmMs}ms ` +
          `tools=${toolMs}ms toolCount=${toolCalls.length} promptChars=${promptChars} msgs=${currentMessages.length}`
        );

        // 按 toolCalls 原始顺序生成 tool 消息（scheduleToolCalls 已保证顺序）
        const toolResults: any[] = [];
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          const res = scheduledResults[i].result;
          if (res && (res).__rejected) {
            toolResults.push({ tool_call_id: call.id, role: 'tool', content: (res).content });
          } else {
            // 剥离变更审查元数据：before/after 全文只给 UI 渲染 diff 用，
            // 进 LLM 上下文会翻倍占用 tokens
            const { diff: _reviewOnly, errorMeta: _uiOnly, ...slim } = typeof res === 'string' ? { text: res } : (res ?? {});
            toolResults.push({
              tool_call_id: call.id,
              role: 'tool',
              content: typeof res === 'string' ? res : JSON.stringify(slim),
            });
          }
        }

        // 单轮预算护栏：即便每个工具已各自截断，一轮里并行多个工具叠加仍可能过大。
        // 按 maxContextTokens 的比例设上限，超出则对所有 tool 结果等比再压一次，
        // 避免"下一轮才触发压缩"之前的这一次请求就已逼近甚至超过上下文窗口。
        this.enforceTurnBudget(toolResults, apiConfig?.model || '');

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
      // 走到循环外有两种情况：模型不再发起工具调用（正常结束），或 runningSessions 被 abort() 清除（用户中止）
      const aborted = !this.runningSessions.get(sessionId);
      emit({ type: 'done', sessionId, data: { turns: turn, usage: totalUsage, aborted } });
      return { success: true, aborted };
    } catch (err: any) {
      dbgLog(`[run] ERROR: ${err.message}`);
      emit({ type: 'error', sessionId, data: { error: err.message } });
      return { success: false, error: err.message };
    } finally {
      // 竞态防护：abort() 后立即重发消息时，旧 run 的 finally 不能清掉新 run 的状态。
      // abort() 会同步删除 Map 条目，随后新 run 重新写入；此处仅当条目仍属于本次 run 时才清理。
      if (this.abortControllers.get(sessionId) === abortController) {
        this.runningSessions.delete(sessionId);
        this.abortControllers.delete(sessionId);
        this.sessionEmitters.delete(sessionId);
      }
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
    // 拒绝本会话所有未响应的工具审批（不能波及其他会话的待审批请求）
    for (const [requestId, entry] of this.toolApprovals.entries()) {
      if (entry.sessionId !== sessionId) continue;
      try {
        entry.resolver(false);
      } catch {
        /* ignore */
      }
      this.toolApprovals.delete(requestId);
    }
    this.runningSessions.delete(sessionId);
    // 审批已全部拒绝并上报 resolved，此时再释放事件发送器
    this.sessionEmitters.delete(sessionId);
  }

  /** 本次会话中 AI 修改过的文件列表（用于回滚/展示） */
  getModifiedFiles(): string[] {
    return this.toolManager.getModifiedFiles();
  }

  resolveToolApproval(requestId: string, approved: boolean): void {
    const entry = this.toolApprovals.get(requestId);
    if (entry) {
      entry.resolver(approved);
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
    const execTools = ['execute_command', 'run_command', 'run_python'];

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

  /**
   * 构造「工作区锚点」提示块。
   *
   * 之前系统提示词完全没有工作区路径，模型只能凭空猜相对路径，
   * 于是 read_file("src/a.ts") 这类调用必然 ENOENT，表现为「识别不了工作区」。
   * 这里把工作区根目录 + 目录清单显式写进提示词，并给出路径书写规范。
   */
  private buildWorkspaceInfo(workspaceId: string): string {
    if (!workspaceId) {
      return '\n\n[工作区] 当前没有打开任何工作区。请先用 list_directory / project_structure 询问用户，不要凭空假设路径。';
    }
    const win = process.platform === 'win32';
    const example = win
      ? `${workspaceId}\\src\\index.ts`
      : `${workspaceId}/src/index.ts`;

    const lines = [
      '',
      '',
      '[工作区]',
      `- 工作区根目录（绝对路径）：${workspaceId}`,
      `- 描述文件时优先用「相对路径」书写，例如 src/index.ts、package.json。`,
      `- 相对路径一律以工作区根目录为基准；工具会自动解析为 ${win ? '\\' : '/'} 分隔的绝对路径，你无需自己拼接。`,
      `- 也可以直接给绝对路径，例如 ${example}。`,
      '- 不要使用 ../ 跳出工作区，也不要假设工作区外存在文件。',
      '- 不确定目录结构时，先调用 list_directory（path 传 "." 表示工作区根目录）或 project_structure 查看。',
    ];
    return lines.join('\n');
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
   * W6/W28：解析本轮应使用的 API 配置
   * - 首轮（turn=1）且模式为 AUTO 时启用路由决策（@mention / 用户配置 / 任务特征 / active 兜底）
   * - 路由候选**仅限内置 API**：自动路由不得把请求打到用户自定义配置
   * - 后续轮次沿用首轮结果（由 run() 中的 activeRunConfig 缓存保证），避免多轮间模型漂移
   */
  private resolveApiConfig(
    turn: number,
    prompt: string,
    images: string[] | undefined,
    mode: AgentMode,
    onDecision?: (data: { model: string; reason: string; taskType: string; mode: 'auto' | 'manual' }) => void,
    heavyToolUse = false
  ): any {
    const configs = this.config.getApiKeyConfigs().filter((c: any) => c && !c.disabled);
    const activeId = this.config.get<string>('activeApiConfigId');
    if (configs.length === 0) return null;

    const automatic = this.config.get<boolean>('agentConfig.enableRouting', true) &&
      this.config.get<string>('modelSelectionMode', 'manual') === 'auto';
    const fallback = configs.find((c: any) => c.id === activeId) || configs[0];
    if (!automatic || turn !== 1) {
      if (turn === 1) onDecision?.({ model: fallback.model, reason: '固定模型', taskType: 'manual', mode: 'manual' });
      return fallback;
    }

    // 仅内置模型参与自动路由；没有内置模型时保持当前模型并明确告警
    const candidates = selectRoutingCandidates(configs as any[]);
    if (candidates.length === 0) {
      dbgLog('[routing] no builtin api config, fallback to active');
      onDecision?.({
        model: fallback.model,
        reason: '未找到可用的内置模型，已沿用当前模型（请等待内置模型同步完成）',
        taskType: 'manual',
        mode: 'manual',
      });
      return fallback;
    }
    const candidateActiveId = candidates.some((c: any) => c.id === activeId) ? activeId : null;

    let decision: any;
    try {
      decision = routeFastestModel(
        prompt || '', candidates as any, candidateActiveId, Array.isArray(images) && images.length > 0,
        mode === 'coder', readModelLatency(this.config),
      );
    } catch (err: any) {
      // 路由失败绝不阻断对话：回退到固定模型并留痕
      dbgLog(`[routing] failed: ${err?.message || err}, fallback to active`);
      onDecision?.({ model: fallback.model, reason: `路由失败已回退：${err?.message || '未知错误'}`, taskType: 'manual', mode: 'manual' });
      return fallback;
    }

    const warnings: string[] = decision.warnings || [];
    const reason = warnings.length ? `${decision.reason}（${warnings.join('；')}）` : decision.reason;
    dbgLog(`[routing] turn=1 reason=${reason} model=${decision.apiConfig.model} tier=${decision.caps.tier} heavy=${heavyToolUse}`);
    onDecision?.({ model: decision.apiConfig.model, reason, taskType: decision.taskType, mode: 'auto' });
    return decision.apiConfig;
  }

  private getActiveApiConfig(): any {
    const configs = this.config.getApiKeyConfigs();
    const activeId = this.config.get<string>('activeApiConfigId');
    return configs.find((c: any) => c.id === activeId) || configs[0];
  }

  /**
   * W1 新增：构建 Fallback 链
   * 优先级：1) 显式 fallbackModelIds 配置 2) 其它已启用的 API 配置
   * 主配置失败后依次尝试，跳过已禁用或同 model 的配置。
   * primary 必须传【本次实际请求的 apiConfig】（而非 config 里的 active），
   * 否则 fallback 命中后链路会与实际请求配置脱节（重复项/漏项）。
   */
  private getFallbackConfigs(primary: any): any[] {
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
    return this.summarizeMessages(toCompress, apiConfig);
  }

  /**
   * W8：把一段历史消息摘要为文本。
   * 「压缩上下文」按钮（手动）与自动压缩共用此实现，避免两处摘要逻辑各自漂移。
   */
  private async summarizeMessages(toCompress: any[], apiConfig?: any): Promise<string> {
    const api = apiConfig || this.getActiveApiConfig();
    if (!api) throw new Error('未配置 API，无法压缩上下文');
    const src = toCompress
      .map((m: any) => {
        const role = m.role === 'assistant' ? 'AI' : m.role === 'tool' ? '工具结果' : '用户';
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${role}: ${c.slice(0, 1500)}`;
      })
      .join('\n\n');
    const response = await this.llmProvider.chat({
      apiConfig: api,
      messages: [
        { role: 'system', content: SUMMARIZE_CONTEXT_PROMPT },
        { role: 'user', content: src.slice(0, 12000) },
      ],
      temperature: 0.3,
      stream: false,
    });
    return (response.content || '').trim() || '(压缩失败：摘要为空)';
  }

  /**
   * 单轮工具结果预算护栏。
   * - 每个工具已在 ToolManager 里被截断到 MAX_TOOL_OUTPUT_CHARS；
   * - 但一轮里并行 N 个工具时，总字符数仍可能逼近上下文窗口；
   * - 这里按 maxContextTokens × ratio 设上限，超出则对所有 tool 消息等比再压一次（保留头尾）。
   * 任何异常都静默跳过——这是防御性兜底，不能因它让整轮对话失败。
   */
  private enforceTurnBudget(toolResults: any[], modelId: string): void {
    try {
      if (!toolResults.length) return;
      const maxContextTokens = detectCapabilities(modelId).maxContextTokens;
      if (!maxContextTokens) return;
      const ratio = this.config.get<number>('agentConfig.toolTurnBudgetRatio', 0.3);
      // chars ≈ tokens × 2（与 ContextCompressor 的估算口径一致）
      const budgetChars = Math.floor(maxContextTokens * ratio * 2);
      let totalChars = 0;
      for (const r of toolResults) {
        if (typeof r.content === 'string') totalChars += r.content.length;
      }
      if (totalChars <= budgetChars) return;

      // 等比缩放：每条 content 按比例裁切，至少保留 1000 字符避免信息完全丢失
      const scale = budgetChars / totalChars;
      for (const r of toolResults) {
        if (typeof r.content !== 'string') continue;
        const keep = Math.max(1000, Math.floor(r.content.length * scale));
        if (r.content.length > keep) {
          const head = r.content.slice(0, Math.floor(keep * 0.7));
          const tail = r.content.slice(r.content.length - Math.floor(keep * 0.25));
          r.content = `${head}\n\n… [本轮预算裁剪] …\n\n${tail}`;
        }
      }
    } catch {
      /* 防御性兜底，静默 */
    }
  }

  /**
   * W8：上下文自动压缩。
   * 触发条件：估算 token ≥ 模型上下文窗口 × triggerRatio，且早期对话轮数多于保留轮数。
   * 任何失败都原样返回消息列表——压缩是优化手段，不能因此让整轮对话失败。
   */
  private async autoCompressContext(
    sessionId: string,
    messages: any[],
    apiConfig: any,
    emit: (event: AgentEvent) => void
  ): Promise<any[]> {
    if (this.config.get<boolean>('agentConfig.autoCompressContext', true) === false) return messages;
    try {
      const maxContextTokens = detectCapabilities(apiConfig?.model || '').maxContextTokens;
      if (!maxContextTokens) return messages;
      const options = {
        maxContextTokens,
        triggerRatio: this.config.get<number>('agentConfig.autoCompressTriggerRatio', 0.8),
        keepRecentTurns: this.config.get<number>('agentConfig.autoCompressKeepTurns', 6),
      };
      if (!this.contextCompressor.shouldCompress(messages, options)) return messages;
      const { messages: compressed, stats } = await this.contextCompressor.compress(
        messages,
        (toCompress) => this.summarizeMessages(toCompress, apiConfig),
        options
      );
      if (stats.compressedTurns === 0) return messages;
      dbgLog(
        `[compress] session=${sessionId} msgs ${stats.beforeMessages}->${stats.afterMessages} ` +
          `chars ${stats.beforeChars}->${stats.afterChars} saved~${stats.savedTokens} tokens`
      );
      emit({ type: 'context_compressed', sessionId, data: { ...stats, maxContextTokens } });
      return compressed;
    } catch (err: any) {
      dbgLog(`[compress] failed, keep original messages: ${err.message}`);
      return messages;
    }
  }

  /**
   * W27：执行一次测试自愈循环。
   * 复用 runSubAgent 当"修复者"——它已具备多轮 LLM + 完整工具链 + 审批 + 权限档位，
   * 这里只负责：跑测试 → 解析失败 → 把结构化失败喂过去 → 再跑一遍。
   */
  private async runAutoFix(
    sessionId: string,
    workspaceId: string,
    args: any,
    signal: AbortSignal,
    autoApproveRun: boolean
  ): Promise<string> {
    if (!workspaceId) return '❌ 无当前工作区，无法运行测试';

    const defaultRounds = this.config.get<number>('agentConfig.autoFixMaxRounds', 3);
    const maxRounds = clampRounds(args?.maxRounds ?? defaultRounds);
    const rawFixTurns = Number(args?.fixTurns);
    const fixTurns = Number.isFinite(rawFixTurns) ? Math.max(1, Math.min(20, Math.trunc(rawFixTurns))) : 10;
    const framework = args?.framework;
    const extraArgs = Array.isArray(args?.extraArgs) ? (args.extraArgs as string[]) : undefined;
    const timeoutMs = typeof args?.timeoutMs === 'number' ? args.timeoutMs : undefined;

    this.emitSession(sessionId, {
      type: 'autofix_progress',
      sessionId,
      data: { phase: 'start', maxRounds },
    });

    const report = await runAutoFixLoop(
      {
        signal,
        runTests: () => runProjectTests(workspaceId, { framework, extraArgs, timeoutMs }),
        applyFix: async (prompt) => {
          // 子 Agent 不要再自己跑测试：外层循环会跑，重复跑既慢又会让它误判
          const description = `${prompt}\n\n补充：改完就停，不要自己运行测试（外层会自动重跑）。`;
          const sub = await this.runSubAgent(
            sessionId,
            { description, agentType: 'general-purpose', maxTurns: fixTurns },
            signal,
            autoApproveRun
          );
          return { success: sub.success, output: sub.output, error: sub.error };
        },
        emit: (event) => {
          this.emitSession(sessionId, { type: 'autofix_progress', sessionId, data: event });
        },
      },
      { maxRounds }
    );

    dbgLog(
      `[autofix] reason=${report.stoppedReason} rounds=${report.rounds.length} failures=${report.failures.length}`
    );
    return formatAutoFixReport(report);
  }

  /**
   * W8：执行一次子 Agent 委派。
   * 子 Agent 复用同一个 LLMProvider，但拥有独立 messages（看不到主对话历史），
   * 因此委派时必须在 description 里写清自包含的任务背景。
   * 工具列表按 agentType 过滤，并排除本工具自身以防无限递归。
   */
  private async runSubAgent(
    parentSessionId: string,
    args: any,
    signal: AbortSignal,
    autoApproveRun: boolean
  ): Promise<SubAgentResult> {
    const description = typeof args?.description === 'string' ? args.description.trim() : '';
    if (!description) {
      return { success: false, output: '', turns: 0, toolCallCount: 0, error: '缺少 description 参数' };
    }
    const agentType: SubAgentType = args?.agentType === 'explore' ? 'explore' : 'general-purpose';
    const rawTurns = Number(args?.maxTurns);
    const maxTurns = Number.isFinite(rawTurns) ? Math.max(1, Math.min(30, Math.trunc(rawTurns))) : 10;

    // 仅 ask 模式会裁剪工具白名单，这里取完整工具列表供子 Agent 使用
    const allTools = await this.toolManager.getAvailableTools('coder');
    // 排除委派工具本身：子 Agent 不能再委派，否则会递归
    const usable = allTools.filter((t) => t.name !== SUBAGENT_TOOL_NAME);
    const toolsByType: Record<SubAgentType, any[]> = {
      'general-purpose': usable,
      'explore': usable.filter((t) => EXPLORE_TOOLS.has(t.name)),
    };

    // SubAgentExecutor.getAvailableTools 是同步签名，故工具列表必须提前解析好
    const executor: SubAgentExecutor = {
      getActiveApiConfig: () => this.getActiveApiConfig(),
      getAvailableTools: (type) => toolsByType[type] || toolsByType['general-purpose'],
      callLlm: async ({ apiConfig, messages, tools }) => {
        const r = await this.llmProvider.chat({
          apiConfig,
          messages,
          tools,
          temperature: this.config.get<number>('agentConfig.temperature', 0.7),
          topP: this.config.get<number>('agentConfig.topP', 1.0),
          stream: false,
          signal,
          fallbackConfigs: this.getFallbackConfigs(apiConfig),
          timeout: {
            perAttemptTimeoutMs: this.config.get<number>('agentConfig.llmTimeoutMs', 60000),
            totalTimeoutMs: this.config.get<number>('agentConfig.llmTotalTimeoutMs', 180000),
          },
        });
        return {
          content: r.content || '',
          thinking: r.thinking,
          toolCalls: r.toolCalls || [],
          usage: r.usage,
        };
      },
      executeTool: async (name, toolArgs) => {
        // 委派出去不等于绕过审批：子 Agent 的工具调用沿用与主 Agent 相同的审批策略，
        // 否则写文件/执行命令这类操作会变成用户看不见的"隐身执行"。
        const permission = this.evaluateToolPermission(name, toolArgs || {});
        if (permission.action === 'deny') {
          dbgLog(`[permission] deny subagent tool ${name}: ${permission.reason}`);
          return { success: false, error: permission.message || `已被权限档位拦截：${permission.reason}` };
        }
        if (!autoApproveRun) {
          const approved = await this.requestToolApproval(parentSessionId, { name, arguments: toolArgs }, permission);
          if (!approved) return { success: false, error: '用户拒绝了此工具调用' };
        }
        const r = await this.toolManager.execute(name, toolArgs, signal);
        if (typeof r === 'string') return { success: true, output: r };
        return {
          success: r?.success !== false,
          output: r?.output ?? (r?.success === false ? undefined : JSON.stringify(r)),
          error: r?.error,
        };
      },
      onProgress: (event) => {
        dbgLog(`[subagent] ${event.type}`);
      },
    };

    return this.subAgentManager.runTask(
      { description, agentType, maxTurns, parentSessionId },
      executor,
      signal
    );
  }

  /**
   * 零弹窗白名单：只含"改文件内容且可被快照回滚"的工具。
   * 意图是把审批从"每次编辑都打断"降为"只在破坏性操作时打断"。
   */
  private static readonly ZERO_APPROVAL_TOOLS = new Set(['write_to_file', 'create_file', 'apply_diff']);

  /**
   * 只读工具白名单：读文件/列目录/搜索/检索/git 只读/文档查询都不会产生任何副作用，
   * 却占 Agent 单轮工具调用的绝大多数。逐个弹窗会让每步都停一次人工确认，
   * 端到端耗时被人工点击主导（这是"Agent 很慢"的主要体感来源之一）。
   * 破坏性（删除/重命名）、执行类（execute_command/run_tests/format_code）、
   * 外部副作用（git 提交/图片生成/MCP）仍然逐次审批。
   */
  private static readonly ZERO_APPROVAL_READONLY = new Set([
    'read_file',
    'list_directory',
    'project_structure',
    'get_file_outline',
    'search_files',
    'search_symbol',
    'find_references',
    'semantic_search',
    'grep',
    'git_status',
    'git_diff',
    'git_log',
    'doc_list',
    'doc_query',
    'get_plan',
  ]);

  private isZeroApprovalAllowed(toolName: string): boolean {
    if (this.config.get<boolean>('agentConfig.zeroApprovalMode', true) === false) return false;
    return (
      AgentManager.ZERO_APPROVAL_TOOLS.has(toolName) ||
      AgentManager.ZERO_APPROVAL_READONLY.has(toolName)
    );
  }

  /** 注入 headless 审批裁决（CLI 用）。传 undefined 恢复默认弹窗流程。 */
  setApprovalHandler(handler?: (toolCall: any) => boolean | undefined | Promise<boolean | undefined>): void {
    this.approvalHandler = handler;
  }

  /**
   * W25：权限档位裁决。把用户信任规则（approvalRules）一起喂进去，保证优先级：
   * 用户 deny > 档位硬拦（只读档）> 用户 allow > 档位默认。
   */
  private evaluateToolPermission(name: string, args: Record<string, unknown>): PermissionResult {
    const userDecision = this.approvalPolicy.evaluate({ name, arguments: args });
    return evaluatePermission(
      { name, arguments: args },
      {
        mode: normalizeMode(this.config.get<string>('agentConfig.permissionMode', 'standard')),
        commandAllowlist: this.config.get<string[]>('agentConfig.commandAllowlist', []) || [],
        domainAllowlist: this.config.get<string[]>('agentConfig.domainAllowlist', []) || [],
        userAction: userDecision.matchedRule ? userDecision.action : undefined,
        userReason: userDecision.reason,
        zeroApprovalMode: this.config.get<boolean>('agentConfig.zeroApprovalMode', true) !== false,
      }
    );
  }

  private async requestToolApproval(
    sessionId: string,
    toolCall: any,
    permission?: PermissionResult
  ): Promise<boolean> {
    // W25：档位拒绝优先（外部审批器也不能放行只读档下的写/执行）
    if (permission?.action === 'deny') {
      dbgLog(`[approval] permission-deny ${toolCall.name}: ${permission.reason}`);
      return false;
    }
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
    // headless：由 CLI 注入的裁决器决定，避免无窗口时等待 60s 超时
    if (this.approvalHandler) {
      try {
        const decided = await this.approvalHandler(toolCall);
        if (typeof decided === 'boolean') {
          dbgLog(`[approval] headless ${decided ? 'allow' : 'deny'} ${toolCall.name}`);
          return decided;
        }
      } catch {
        /* 裁决器异常时回落默认流程 */
      }
    }
    // W25：档位判定为放行时不再弹窗（标准档的读/写、完全访问档的全部工具）。
    // 放在外部审批器之后：CLI 注入的 --approve-policy 仍代表用户显式策略，不能被档位默认值架空。
    if (permission?.action === 'allow') {
      dbgLog(`[approval] permission-allow ${toolCall.name} (${permission.matchedBy})`);
      return true;
    }
    // 零弹窗模式（W19）：文件内容编辑类工具直接放行，不打断用户。
    // 仅在"没有任何用户规则命中"时生效，用户显式配置的规则始终优先。
    // 删除/重命名/执行命令/git 提交/MCP 外部副作用工具不在白名单内，仍需审批。
    if (!decision.matchedRule && this.isZeroApprovalAllowed(toolCall.name)) {
      dbgLog(`[approval] zero-popup allow ${toolCall.name}`);
      return true;
    }
    // ask：弹窗等用户决策
    const requestId = randomUUID();
    // 主窗口解析交给 WindowAdapter（内部已回退到非 PPT 的活跃窗口），
    // headless 环境返回 null，直接跳过界面推送。
    const win = this.windowAdapter.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('tool:approve-request', { requestId, sessionId, toolCall });
    }
    // 同步通知渲染层的 Agent 活动面板（独立于审批弹窗，用于阶段态与待审批计数）
    this.emitSession(sessionId, {
      type: 'approval_request',
      sessionId,
      data: { requestId, toolName: toolCall.name, arguments: toolCall.arguments || {} },
    });
    return new Promise<boolean>((resolve) => {
      // 任何一条裁决路径（用户响应 / 超时 / abort）都只上报一次 resolved
      let settled = false;
      const settle = (approved: boolean) => {
        if (settled) return;
        settled = true;
        this.emitSession(sessionId, { type: 'approval_resolved', sessionId, data: { requestId, approved } });
        resolve(approved);
      };
      this.toolApprovals.set(requestId, { sessionId, resolver: settle });
      // 60秒超时自动拒绝
      setTimeout(() => {
        if (this.toolApprovals.has(requestId)) {
          this.toolApprovals.delete(requestId);
          settle(false);
        }
      }, 60000);
    });
  }

  /** 向指定会话的渲染层推送事件（无对应 run 时静默丢弃） */
  private emitSession(sessionId: string, event: AgentEvent): void {
    const emitter = this.sessionEmitters.get(sessionId);
    if (!emitter) return;
    try {
      emitter(event);
    } catch {
      /* 渲染层不可用时不影响主流程 */
    }
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
