/**
 * ModelRouter - 任务感知的模型路由（W6 / W28 AUTO）
 *
 * 输入：用户 prompt + 工具列表 + 当前 API 配置列表
 * 输出：本次 run() 应使用的 apiConfig
 *
 * 决策优先级（高 → 低）：
 * 0. 能力硬约束过滤（带图 → 仅保留 vision=true 的模型；过滤先于一切打分）
 * 1. 显式 @model 提及（@deepseek / @qwen-max / @kimi 等）
 * 2. 用户配置 agentConfig.routing.* 默认
 * 3. 任务特征匹配（短问 → fast；长工具链 + 代码 → flagship；推理关键词 → reasoning）
 * 4. activeApiConfigId
 *
 * 约束：全部判定在本地完成，不产生额外 LLM 分类请求。
 */

import { detectCapabilities, extractModelMention, resolveModelAlias, ModelCapabilities } from './ProviderCapabilities';
import { rankByLatency, type LatencyTable } from './ModelLatency';

export function routeFastestModel(
  prompt: string, configs: ApiConfig[], activeId: string | null,
  hasImages: boolean, needsTools: boolean, latency: LatencyTable,
): RoutingDecision {
  const { mention, cleanPrompt } = extractModelMention(prompt);
  const taskType = detectTaskType({ prompt: cleanPrompt, hasImages });
  const eligible = configs.filter((c) => {
    const caps = detectCapabilities(c.model);
    return !c.disabled && (!hasImages || caps.vision) && (!needsTools || caps.functionCall);
  });
  if (!eligible.length) throw new Error('没有满足当前图片/工具能力要求的可用模型');
  const ranked = rankByLatency(eligible, latency);
  const pool = ranked.length ? ranked.map((r) => r.model) : eligible;
  const fallback = routeModel(pool, activeId, { taskType: 'chat', mention, hasImages });
  if (fallback.mention && fallback.reason.startsWith('@mention:')) return fallback;
  const fastest = ranked.find((r) => r.latency !== undefined);
  return {
    ...fallback,
    apiConfig: fastest?.model ?? fallback.apiConfig,
    caps: detectCapabilities((fastest?.model ?? fallback.apiConfig).model),
    taskType,
    mention: null,
    reason: fastest
      ? `AUTO 实测首字最快：${fastest.model.model}（加权 ${Math.round(fastest.latency!)}ms；已测可用模型）`
      : ranked.length
        ? `AUTO 暂无有效测速样本，使用快速档 ${fallback.apiConfig.model}；随实际请求学习`
        : `AUTO 候选暂处失败冷却期，回退 ${fallback.apiConfig.model}`,
  };
}

export interface ApiConfig {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: string;
  disabled?: boolean;
  /** 官方下发的内置配置标记（同步自官方列表） */
  builtin?: boolean;
}

/** 内置（官方）配置判定：`official_` 前缀或显式 builtin 标记 */
export function isBuiltinConfig(config?: { id?: string; builtin?: boolean } | null): boolean {
  if (!config) return false;
  return config.builtin === true || String(config.id || '').startsWith('official_');
}

/**
 * AUTO 路由候选池：**仅内置 API**（产品约束：自动路由不得把请求打到用户自定义配置）。
 * 返回空数组表示没有可用内置模型，由调用方回退到当前固定模型并告警。
 */
export function selectRoutingCandidates<T extends { id?: string; builtin?: boolean; disabled?: boolean }>(
  configs: T[] | null | undefined
): T[] {
  return (configs || []).filter((c) => !!c && !c.disabled && isBuiltinConfig(c));
}

export type TaskType = 'chat' | 'code' | 'reasoning' | 'vision' | 'summarize' | 'plan';

export interface RoutingDecision {
  apiConfig: ApiConfig;
  reason: string;
  taskType: TaskType;
  caps: ModelCapabilities;
  mention: string | null;
  /** 非致命提示（如：无 vision 模型时的降级说明），供 UI / 日志展示 */
  warnings?: string[];
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

/** 强推理信号：出现即为确凿的推理诉求 */
const STRONG_REASONING_SIGNALS: RegExp[] = [
  /推理/,
  /证明/,
  /逐步/,
  /根因|根本原因/,
  /\bprove?\b/i,
  /chain.of.thought/i,
  /step.by.step/i,
];

/** 弱推理信号：单独一个不足以升档，需长度或第二个信号佐证（避免 "why is my button blue" 被判为 reasoning） */
const WEAK_REASONING_SIGNALS: RegExp[] = [
  /分析/,
  /为什么/,
  /思考/,
  /深思/,
  /\breason/i,
  /analy[sz]e/i,
  /\bwhy\b/i,
  /how does/i,
];

/** 弱信号升档所需的提示词长度门槛 */
const REASONING_MIN_LENGTH = 40;

export function countReasoningSignals(prompt: string): number {
  const p = prompt || '';
  if (!p) return 0;
  const strong = STRONG_REASONING_SIGNALS.reduce((n, re) => (re.test(p) ? n + 1 : n), 0);
  const weak = WEAK_REASONING_SIGNALS.reduce((n, re) => (re.test(p) ? n + 1 : n), 0);
  // 强信号按双权重计，保证"请证明…"这类短句直接命中
  return strong * 2 + weak;
}

/** 是否构成"需要推理"的证据：命中原生强信号，或 ≥2 个信号，或 1 个弱信号且提示词足够长 */
export function hasReasoningEvidence(prompt: string): boolean {
  const p = prompt || '';
  if (!p) return false;
  if (STRONG_REASONING_SIGNALS.some((re) => re.test(p))) return true;
  const weak = WEAK_REASONING_SIGNALS.reduce((n, re) => (re.test(p) ? n + 1 : n), 0);
  if (weak >= 2) return true;
  return weak >= 1 && p.length >= REASONING_MIN_LENGTH;
}

/** 推断任务类型（按关键词 / 特征） */
export function detectTaskType(opts: { prompt: string; hasImages?: boolean; heavyToolUse?: boolean }): TaskType {
  if (opts.hasImages) return 'vision';
  const p = opts.prompt || '';
  if (hasReasoningEvidence(p)) return 'reasoning';
  if (/规划|plan|设计|架构|implement|refactor/i.test(p)) return 'plan';
  if (/写代码|code|function|class|实现|重构|fix|bug|修复|写.*函数|写一个/i.test(p)) return 'code';
  if (/总结|摘要|summari[sz]e|压缩上下文/i.test(p)) return 'summarize';
  return 'chat';
}

/** 任务所需的能力硬约束（先过滤，再打分，不可被 tier / 用户偏好覆盖） */
function requiredCapabilities(taskType: TaskType, options: RoutingOptions): { vision: boolean } {
  return { vision: taskType === 'vision' || !!options.hasImages };
}

interface CandidatePool {
  pool: ApiConfig[];
  warnings: string[];
}

/**
 * 按硬约束过滤候选池。
 * - 带图必须有 vision；若全池都不支持，保留原池并给出明确告警（不静默发送，但也不中断对话）。
 */
function buildCandidatePool(enabled: ApiConfig[], taskType: TaskType, options: RoutingOptions): CandidatePool {
  const need = requiredCapabilities(taskType, options);
  const warnings: string[] = [];
  if (!need.vision) return { pool: enabled, warnings };

  const visionPool = enabled.filter((c) => {
    const caps = detectCapabilities(c.model);
    return caps.vision === true;
  });
  if (visionPool.length > 0) return { pool: visionPool, warnings };

  warnings.push('未找到明确支持图片输入的模型，已使用当前模型，建议在设置中配置多模态模型');
  return { pool: enabled, warnings };
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

  const taskType = options.taskType || 'chat';
  const { pool, warnings } = buildCandidatePool(enabled, taskType, options);
  const activeConfig = enabled.find((c) => c.id === activeConfigId);
  const decision = (apiConfig: ApiConfig, reason: string, mention: string | null): RoutingDecision => ({
    apiConfig,
    reason,
    taskType,
    caps: detectCapabilities(apiConfig.model),
    mention,
    warnings: warnings.length ? warnings : undefined,
  });

  // 1) 显式 @model 提及（仍受硬约束：@ 到不支持图片的模型会被拒绝）
  if (options.mention) {
    const allModelNames = enabled.flatMap((c) => [c.model, c.name || '', c.id]);
    const resolved = resolveModelAlias(options.mention, allModelNames);
    if (resolved) {
      const mentioned = enabled.find((c) => c.model === resolved || c.id === resolved || c.name === resolved);
      const allowed = mentioned && pool.some((c) => c.id === mentioned.id);
      if (mentioned && allowed) {
        return decision(mentioned, `@mention: ${options.mention} → ${mentioned.model}`, options.mention);
      }
      if (mentioned) {
        warnings.push(`@${options.mention} 不支持当前任务所需能力，已改由路由器选择`);
      }
    }
  }

  // 2) 用户配置的任务映射
  let target: ApiConfig | undefined;
  let reason = '';
  const userDefaultId = options.userRouting?.[taskType];
  if (userDefaultId) {
    target = pool.find((c) => c.id === userDefaultId);
    if (target) reason = `用户配置 routing.${taskType} → ${target.model}`;
    else if (enabled.some((c) => c.id === userDefaultId)) {
      warnings.push(`routing.${taskType} 指定的模型不满足能力约束，已忽略该映射`);
    }
  }

  // 3) 自动路由：按任务选 tier
  if (!target) {
    const tier = pickTierForTask(taskType, options);
    target = pickByTier(pool, tier);
    if (target) reason = `任务类型 ${taskType} → tier=${tier} → ${target.model}`;
  }

  // 4) 兜底：activeConfigId 或第一个
  if (!target) {
    target = activeConfig || enabled[0];
    reason = `兜底使用 ${target.model}`;
  }

  return decision(target, reason, options.mention ?? null);
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

/** 带 hasImages / heavyToolUse 的高层 API */
export function decideModelFromPromptWithImages(
  prompt: string,
  configs: ApiConfig[],
  activeConfigId: string | null,
  hasImages: boolean,
  userRouting?: Partial<Record<TaskType, string>>,
  heavyToolUse = false
): RoutingDecision {
  const { mention, cleanPrompt } = extractModelMention(prompt);
  const taskType = hasImages ? 'vision' : detectTaskType({ prompt: cleanPrompt, heavyToolUse });
  return routeModel(configs, activeConfigId, {
    mention,
    taskType,
    hasImages,
    heavyToolUse,
    promptLength: cleanPrompt.length,
    needReasoning: taskType === 'reasoning',
    userRouting,
  });
}
