/**
 * ProviderCapabilities - LLM Provider/Model 能力矩阵（W6）
 *
 * 路由决策的核心：根据 model 名称推断能力，避免对每个 API 探测。
 * 推断规则（按优先级）：
 * 1. 显式 model 覆盖（用户在 run() 传入 model）
 * 2. provider 字段 + 关键字匹配（如 "deepseek-reasoner" → 含 reasoning）
 * 3. 兜底：通用能力（functionCall=true, vision=false, reasoning=false）
 *
 * 国内 T0 模型覆盖：
 * - DeepSeek (chat / coder / reasoner)
 * - 通义千问 (max / plus / turbo / qwen3-thinking)
 * - GLM (4-plus / 4-flash)
 * - Kimi (k2)
 * - 文心 (ernie-4.5)
 * - 国产中转（NewAPI / OneAPI / 自定义）
 */

export interface ModelCapabilities {
  /** OpenAI 风格 function calling */
  functionCall: boolean;
  /** 视觉（图） */
  vision: boolean;
  /** 思考链（DeepSeek-R1 / Qwen3-Thinking / o1） */
  reasoning: boolean;
  /** 流式响应 */
  streaming: boolean;
  /** 上下文 token 上限（0 = 未知） */
  maxContextTokens: number;
  /** 模型档位（用于路由） */
  tier: 'flagship' | 'standard' | 'fast' | 'reasoning';
  /** 模型类型标签（用于 LLM 决策时披露） */
  label: string;
}

const TIER_FAST: ModelCapabilities = {
  functionCall: true, vision: false, reasoning: false, streaming: true,
  maxContextTokens: 128_000, tier: 'fast', label: '快速',
};
const TIER_STANDARD: ModelCapabilities = {
  functionCall: true, vision: false, reasoning: false, streaming: true,
  maxContextTokens: 128_000, tier: 'standard', label: '标准',
};
const TIER_FLAGSHIP: ModelCapabilities = {
  functionCall: true, vision: true, reasoning: false, streaming: true,
  maxContextTokens: 200_000, tier: 'flagship', label: '旗舰',
};
const TIER_REASONING: ModelCapabilities = {
  functionCall: true, vision: false, reasoning: true, streaming: true,
  maxContextTokens: 128_000, tier: 'reasoning', label: '推理',
};

interface Rule {
  test: (model: string) => boolean;
  caps: ModelCapabilities;
}

/** 模型匹配规则（按顺序匹配，第一个命中即用） */
const RULES: Rule[] = [
  // DeepSeek
  { test: (m) => /deepseek-(?:r1|reasoner|reasoning)/i.test(m), caps: TIER_REASONING },
  { test: (m) => /deepseek-coder/i.test(m), caps: { ...TIER_STANDARD, label: 'DeepSeek-Coder' } },
  { test: (m) => /deepseek-v3|deepseek-chat/i.test(m), caps: TIER_FLAGSHIP },

  // Qwen
  { test: (m) => /qwen3-?(?:plus|max|235b|72b).*thinking|qwen.*thinking/i.test(m), caps: TIER_REASONING },
  { test: (m) => /qwen-max|qwen3-max|qwen-?3-?max/i.test(m), caps: TIER_FLAGSHIP },
  { test: (m) => /qwen-plus|qwen-?3-?plus/i.test(m), caps: TIER_STANDARD },
  { test: (m) => /qwen-turbo|qwen-?3-?turbo|qwen-long/i.test(m), caps: TIER_FAST },
  { test: (m) => /qwen-?vl|qwen-vision|qvq/i.test(m), caps: { ...TIER_FLAGSHIP, label: 'Qwen-VL' } },

  // GLM
  { test: (m) => /glm-?4-?plus|glm-?4-?air|glm-4-?0520|glm-z1/i.test(m), caps: TIER_FLAGSHIP },
  { test: (m) => /glm-?4-?flash|glm-?4-?long/i.test(m), caps: TIER_STANDARD },

  // Kimi
  { test: (m) => /kimi[-_]?k2|moonshot.*k2/i.test(m), caps: TIER_FLAGSHIP },
  { test: (m) => /kimi|moonshot/i.test(m), caps: TIER_STANDARD },

  // 文心
  { test: (m) => /ernie-?4\.?5|ernie-?bot-?4|ernie-?3\.?5/i.test(m), caps: TIER_FLAGSHIP },
  { test: (m) => /ernie-?(?:speed|turbo)/i.test(m), caps: TIER_FAST },

  // 智谱
  { test: (m) => /chatglm/i.test(m), caps: TIER_STANDARD },

  // Doubao / 字节
  { test: (m) => /doubao-?pro|doubao-1\.5-pro/i.test(m), caps: TIER_FLAGSHIP },
  { test: (m) => /doubao-?lite|doubao-1\.5-lite/i.test(m), caps: TIER_FAST },

  // OpenAI o 系列
  { test: (m) => /^o1|o3|o4/i.test(m), caps: TIER_REASONING },
  { test: (m) => /gpt-4o|chatgpt-4o/i.test(m), caps: TIER_FLAGSHIP },
  { test: (m) => /gpt-4-turbo|gpt-4-32k/i.test(m), caps: TIER_STANDARD },
  { test: (m) => /gpt-3\.5|gpt-3\.5-turbo/i.test(m), caps: TIER_FAST },

  // Claude
  { test: (m) => /claude-?3-?7-?sonnet|claude-sonnet-4|claude-3-5-sonnet/i.test(m), caps: TIER_FLAGSHIP },
  { test: (m) => /claude-?3-?5-?haiku|claude-haiku/i.test(m), caps: TIER_FAST },
  { test: (m) => /claude-?3-?opus|claude-opus/i.test(m), caps: TIER_FLAGSHIP },

  // Gemini
  { test: (m) => /gemini-2\.0|gemini-1\.5-pro/i.test(m), caps: TIER_FLAGSHIP },
  { test: (m) => /gemini-1\.5-flash|gemini-2\.0-flash/i.test(m), caps: TIER_FAST },
];

/** 默认能力（兜底） */
const DEFAULT_CAPS: ModelCapabilities = TIER_STANDARD;

/** 探测模型能力 */
export function detectCapabilities(modelName: string): ModelCapabilities {
  if (!modelName) return DEFAULT_CAPS;
  const m = modelName.toLowerCase().trim();
  for (const rule of RULES) {
    if (rule.test(m)) {
      return { ...rule.caps, label: rule.caps.label };
    }
  }
  return DEFAULT_CAPS;
}

/** 从 prompt 提取 @model 指令 */
export function extractModelMention(prompt: string): { mention: string | null; cleanPrompt: string } {
  if (!prompt) return { mention: null, cleanPrompt: '' };
  // 匹配开头的 @xxx（最多取到第一个空白）
  const m = prompt.match(/^\s*@([\w.\-]+)\s+/);
  if (!m) return { mention: null, cleanPrompt: prompt };
  const mention = m[1].toLowerCase();
  const cleanPrompt = prompt.slice(m[0].length);
  return { mention, cleanPrompt };
}

/** 根据 model 简称找最可能的真实 model 名（用于路由查表） */
export function resolveModelAlias(alias: string, allModelNames: string[]): string | null {
  if (!alias) return null;
  const a = alias.toLowerCase();
  // 完全匹配
  const exact = allModelNames.find((n) => n.toLowerCase() === a);
  if (exact) return exact;
  // 包含匹配
  const partial = allModelNames.find((n) => n.toLowerCase().includes(a));
  if (partial) return partial;
  return null;
}
