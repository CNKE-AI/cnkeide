/**
 * ModelRouter - 任务感知的模型路由（W6）
 *
 * 输入：用户 prompt + 工具列表 + 当前 API 配置列表
 * 输出：本次 run() 应使用的 apiConfig
 *
 * 决策优先级：
 * 1. 显式 @model 提及（@deepseek / @qwen-max / @kimi 等）
 * 2. 任务特征匹配（短问 → fast；长工具链 + 代码 → flagship；含"推理/分析/证明"关键词 → reasoning）
 * 3. 用户配置 agentConfig.routing.* 默认
 * 4. activeApiConfigId
 */

import { detectCapabilities, extractModelMention, resolveModelAlias, ModelCapabilities } from './ProviderCapabilities';

export interface ApiConfig {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: string;
  disabled?: boolean;
}

export type TaskType = 'chat' | 'code' | 'reasoning' | 'vision' | 'summarize' | 'plan';

export interface RoutingDecision {
  apiConfig: ApiConfig;
  reason: string;
  taskType: TaskType;
  caps: ModelCapabilities;
  mention: string | null;
}

export interface RoutingOptions {
  /** 任务特征 */
  taskType?: TaskType;
  /** 是否包含图片 */
  hasImages?: boolean;
  /** 历史消息中是否含大量工具结果（>=3 个 tool 消息） */
  heavyToolUse?: boolean;
  /** 提示词长度（含 system） */
  promptLength?: number;
  /** 是否有需要"思考"的关键词（推理/证明/分析/为什么） */
  needReasoning?: boolean;
  /** 用户在 prompt 中提及的 @model */
  mention?: string | null;
  /** 用户配置的默认 routing（agentConfig.routing） */
  userRouting?: Partial<Record<TaskType, string>>;
}

const REASONING_KEYWORDS = /推理|分析|证明|为什么|思考|深思|reason|prove|analy[sz]e|why|how does|chain.of.thought/i;

/** 推断任务类型（按关键词 / 特征） */
export function detectTaskType(opts: { prompt: string; hasImages?: boolean; heavyToolUse?: boolean }): TaskType {
  if (opts.hasImages) return 'vision';
  const p = opts.prompt || '';
  if (REASONING_KEYWORDS.test(p)) return 'reasoning';
  if (/规划|plan|设计|架构|implement|refactor/i.test(p)) return 'plan';
  if (/写代码|code|function|class|实现|重构|fix|bug|修复|写.*函数|写一个/i.test(p)) return 'code';
  if (/总结|摘要|summari[sz]e|压缩上下文/i.test(p)) return 'summarize';
  return 'chat';
}

/** 核心路由入口 */
export function routeModel(
  configs: ApiConfig[],
  activeConfigId: string | null,
  options: RoutingOptions
): RoutingDecision {
  const enabled = configs.filter((c) => !c.disabled);

  if (enabled.length === 0) {
    throw new Error('没有可用的 API 配置');
  }

  // 1) 显式 @model 提及
  if (options.mention) {
    const allModelNames = enabled.flatMap((c) => [c.model, c.name || '', c.id]);
    const resolved = resolveModelAlias(options.mention, allModelNames);
    if (resolved) {
      const matched = enabled.find((c) => c.model === resolved || c.id === resolved || c.name === resolved);
      if (matched) {
        return {
          apiConfig: matched,
          reason: `@mention: ${options.mention} → ${matched.model}`,
          taskType: options.taskType || 'chat',
          caps: detectCapabilities(matched.model),
          mention: options.mention,
        };
      }
    }
  }

  // 2) 任务类型路由
  const taskType = options.taskType || 'chat';
  let target: ApiConfig | undefined;
  let reason = '';

  // 用户自定义优先
  const userDefaultId = options.userRouting?.[taskType];
  if (userDefaultId) {
    target = enabled.find((c) => c.id === userDefaultId);
    if (target) reason = `用户配置 routing.${taskType} → ${target.model}`;
  }

  if (!target) {
    // 自动路由：按任务选 tier
    const tier = pickTierForTask(taskType, options);
    target = pickByTier(enabled, tier);
    if (target) reason = `任务类型 ${taskType} → tier=${tier} → ${target.model}`;
  }

  // 3) 兜底：activeConfigId 或第一个
  if (!target) {
    target = enabled.find((c) => c.id === activeConfigId) || enabled[0];
    reason = `兜底使用 ${target.model}`;
  }

  return {
    apiConfig: target,
    reason,
    taskType,
    caps: detectCapabilities(target.model),
    mention: options.mention ?? null,
  };
}

/** 根据任务选 tier */
function pickTierForTask(taskType: TaskType, options: RoutingOptions): 'flagship' | 'standard' | 'fast' | 'reasoning' {
  if (taskType === 'reasoning' || options.needReasoning) return 'reasoning';
  if (taskType === 'vision') return 'flagship';
  if (taskType === 'plan' || options.heavyToolUse) return 'flagship';
  if (taskType === 'code') {
    return options.promptLength && options.promptLength > 8000 ? 'flagship' : 'standard';
  }
  if (taskType === 'summarize') return 'fast';
  return 'fast'; // chat 默认 fast 节省成本
}

/** 从候选配置里挑最匹配 tier 的 */
function pickByTier(configs: ApiConfig[], tier: 'flagship' | 'standard' | 'fast' | 'reasoning'): ApiConfig | undefined {
  // 优先：tier 完全匹配；否则按 tier 优先级退化
  const tierPriority: Record<typeof tier, (typeof tier)[]> = {
    flagship: ['flagship', 'standard', 'fast', 'reasoning'],
    standard: ['standard', 'fast', 'flagship', 'reasoning'],
    fast: ['fast', 'standard', 'flagship', 'reasoning'],
    reasoning: ['reasoning', 'flagship', 'standard', 'fast'],
  };
  for (const t of tierPriority[tier]) {
    const found = configs.find((c) => detectCapabilities(c.model).tier === t);
    if (found) return found;
  }
  return configs[0];
}

/** 高层 API：从 prompt + 全局状态一次性决策 */
export function decideModelFromPrompt(
  prompt: string,
  configs: ApiConfig[],
  activeConfigId: string | null,
  userRouting?: Partial<Record<TaskType, string>>
): RoutingDecision {
  const { mention, cleanPrompt } = extractModelMention(prompt);
  const taskType = detectTaskType({ prompt: cleanPrompt });
  return routeModel(configs, activeConfigId, {
    mention,
    taskType,
    promptLength: cleanPrompt.length,
    needReasoning: taskType === 'reasoning',
    userRouting,
  });
}

/** 带 hasImages 的高层 API */
export function decideModelFromPromptWithImages(
  prompt: string,
  configs: ApiConfig[],
  activeConfigId: string | null,
  hasImages: boolean,
  userRouting?: Partial<Record<TaskType, string>>
): RoutingDecision {
  const { mention, cleanPrompt } = extractModelMention(prompt);
  const taskType = hasImages ? 'vision' : detectTaskType({ prompt: cleanPrompt });
  return routeModel(configs, activeConfigId, {
    mention,
    taskType,
    promptLength: cleanPrompt.length,
    needReasoning: taskType === 'reasoning',
    userRouting,
  });
}
