/**
 * PPT 企业级场景体系
 *
 * 职责：
 * - 定义企业高频场景（商务汇报 / 产品发布 / 项目提案 / 年度总结 / 培训课件 / 通用）
 * - 每个场景提供：结构骨架（页序）、推荐主题、推荐页数、图表建议、大纲 prompt 指引
 * - 自动匹配：关键词规则（零成本兜底）+ LLM 分类（准）双通道
 *
 * 设计原则：场景只影响「结构 + 内容侧重」，视觉由主题（pptThemes）决定，
 * 两者正交组合，避免组合爆炸。
 */

import type { LLMProvider } from '../llm/LLMProvider';

export interface ChartHint {
  /** 建议放图表的页（按结构角色匹配，如 "数据表现"） */
  forSection: string;
  type: 'bar' | 'line' | 'pie';
  note: string;
}

export interface PptScenario {
  id: string;
  name: string;
  description: string;
  /** 推荐主题（对应 pptThemes 的 id） */
  recommendedTheme: string;
  /** 推荐页数 */
  recommendedPages: [number, number];
  /**
   * 结构骨架：给 LLM 的页序建议（章节角色序列）。
   * LLM 按此骨架组织大纲，保证企业级「结构清晰」。
   */
  structure: string[];
  /** 图表建议：哪些章节页建议配图表、配什么类型 */
  chartHints: ChartHint[];
  /** 关键词（小写，命中即候选） */
  keywords: string[];
  /** 大纲生成时的附加 prompt 指引（内容侧重、语气、要点风格） */
  outlineGuidance: string;
}

export const PPT_SCENARIOS: PptScenario[] = [
  {
    id: 'business-report',
    name: '商务汇报',
    description: '季度/月度经营汇报、业务进展、数据复盘',
    recommendedTheme: 'business',
    recommendedPages: [10, 15],
    structure: [
      '封面（汇报主题 + 汇报人 + 日期）',
      '目录（3-5 个章节）',
      '核心结论先行（TL;DR：最重要的 3 条结论）',
      '背景与目标',
      '关键进展（分板块陈述）',
      '数据表现（配柱状/折线图）',
      '问题与风险',
      '下一步计划（含时间节点）',
      '资源需求（如需支持）',
      '结尾（感谢页）',
    ],
    chartHints: [
      { forSection: '数据表现', type: 'bar', note: '各业务线/季度对比，柱状图' },
      { forSection: '数据表现', type: 'line', note: '趋势类指标（增长/流失），折线图' },
    ],
    keywords: ['汇报', '季度', '月度', '经营', '业绩', '进展', '复盘', '工作总结汇报', '述职', 'kpi', 'okr', '业务回顾'],
    outlineGuidance: [
      '内容风格：结论先行、数据说话、每页一个明确观点。',
      '要点要求：尽量带量化表述（如「营收同比增长 23%」），无真实数据时用合理示例数据并标注（示例）。',
      '语气：客观、精炼、面向管理层。',
    ].join('\n'),
  },
  {
    id: 'product-launch',
    name: '产品发布',
    description: '新产品/新功能发布、市场推介、路演',
    recommendedTheme: 'business',
    recommendedPages: [10, 14],
    structure: [
      '封面（产品名 + 一句话定位）',
      '目录',
      '痛点与机会（用户/市场现状）',
      '产品方案（核心价值主张）',
      '核心功能亮点（2-3 页，每页一个亮点）',
      '差异化对比（与竞品，可配表格）',
      '市场空间（配饼图/柱状图）',
      '定价与上市计划',
      '路线图（Roadmap 时间线）',
      '结尾（行动号召）',
    ],
    chartHints: [
      { forSection: '市场空间', type: 'pie', note: '市场份额分布，饼图' },
      { forSection: '市场空间', type: 'bar', note: '市场规模增长，柱状图' },
    ],
    keywords: ['发布', '产品', '新功能', '路演', '推介', '上市', '发布会', 'launch', '新品', '解决方案介绍'],
    outlineGuidance: [
      '内容风格：故事线（痛点 → 方案 → 价值 → 行动），有感染力。',
      '要点要求：亮点页每条讲一个用户可感知的价值，避免技术术语堆砌。',
      '语气：自信、聚焦价值、面向客户/投资人。',
    ].join('\n'),
  },
  {
    id: 'project-proposal',
    name: '项目提案',
    description: '项目立项、方案申报、可行性分析',
    recommendedTheme: 'academic',
    recommendedPages: [10, 16],
    structure: [
      '封面（项目名 + 提案方 + 日期）',
      '目录',
      '项目背景与必要性',
      '现状与问题分析',
      '项目目标（可量化）',
      '总体方案（技术/实施路线）',
      '实施计划（里程碑，可配时间线）',
      '预算与资源（可配表格）',
      '风险与应对',
      '预期收益（可配图）',
      '结尾（请求决策/支持）',
    ],
    chartHints: [
      { forSection: '预期收益', type: 'bar', note: '收益/成本对比，柱状图' },
      { forSection: '预算与资源', type: 'pie', note: '预算构成，饼图' },
    ],
    keywords: ['提案', '立项', '方案', '可行性', '申报', '项目计划', 'proposal', '建设方案', '实施方案'],
    outlineGuidance: [
      '内容风格：逻辑严密、论证充分，每个结论有依据。',
      '要点要求：目标必须可量化（SMART），风险页必须给出应对措施。',
      '语气：严谨、面向决策者。',
    ].join('\n'),
  },
  {
    id: 'annual-review',
    name: '年度总结',
    description: '年终总结、年度回顾、个人/团队盘点',
    recommendedTheme: 'chinese',
    recommendedPages: [12, 18],
    structure: [
      '封面（年份 + 主题）',
      '目录',
      '年度概览（大事记/关键数字）',
      '重点工作回顾（分主题 2-4 页）',
      '数据成果（配柱状/折线图）',
      '团队与成长',
      '不足与反思',
      '明年规划（目标 + 关键举措）',
      '致谢',
      '结尾',
    ],
    chartHints: [
      { forSection: '数据成果', type: 'line', note: '全年趋势（12 个月），折线图' },
      { forSection: '数据成果', type: 'bar', note: '年度对比（同比），柱状图' },
    ],
    keywords: ['年度', '年终', '总结', '回顾', '盘点', 'year', 'annual', '这一年', '个人总结'],
    outlineGuidance: [
      '内容风格：有温度也有数据，成果与反思并重。',
      '要点要求：重点工作页按「背景 → 动作 → 结果」组织，结果量化。',
      '语气：真诚、面向团队/上级。',
    ].join('\n'),
  },
  {
    id: 'training',
    name: '培训课件',
    description: '内训课程、知识分享、Onboarding 教程',
    recommendedTheme: 'illustration',
    recommendedPages: [12, 20],
    structure: [
      '封面（课程名 + 讲师）',
      '课程目标（学完能做什么）',
      '目录/课程地图',
      '知识点 1（概念 + 示例）',
      '知识点 2（概念 + 示例）',
      '知识点 3（概念 + 示例）',
      '动手练习/案例演示',
      '常见问题与易错点',
      '小结与自测',
      '结尾（延伸学习资源）',
    ],
    chartHints: [
      { forSection: '小结与自测', type: 'pie', note: '掌握度分布（可选），饼图' },
    ],
    keywords: ['培训', '课件', '教程', '课程', '分享', '教学', 'onboarding', '入门', '讲座', 'workshop', '教学课件'],
    outlineGuidance: [
      '内容风格：由浅入深、每页只讲一个知识点，多用具体示例。',
      '要点要求：概念页给「一句话定义 + 一个例子」；练习页给明确任务。',
      '语气：亲和、面向学员。',
    ].join('\n'),
  },
  {
    id: 'general',
    name: '通用演示',
    description: '未匹配到明确场景时的兜底，通用结构',
    recommendedTheme: 'business',
    recommendedPages: [8, 12],
    structure: [
      '封面',
      '目录',
      '背景/引入',
      '主体内容（2-5 页，按逻辑展开）',
      '数据/论证（可选配图表）',
      '总结',
      '结尾',
    ],
    chartHints: [],
    keywords: [],
    outlineGuidance: '内容风格：结构清晰、要点精炼，适合大多数演示场合。',
  },
];

export function getScenario(id: string): PptScenario {
  return PPT_SCENARIOS.find((s) => s.id === id) ?? PPT_SCENARIOS[PPT_SCENARIOS.length - 1];
}

/**
 * 关键词规则匹配（零成本，作为 LLM 分类的兜底）
 * 命中多个场景时取命中词数最多者；无命中返回 general。
 */
export function detectScenarioByKeyword(topic: string): PptScenario {
  const t = (topic || '').toLowerCase();
  if (!t.trim()) return getScenario('general');
  let best: { s: PptScenario; hits: number } | null = null;
  for (const s of PPT_SCENARIOS) {
    if (s.id === 'general') continue;
    const hits = s.keywords.filter((k) => t.includes(k)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { s, hits };
  }
  return best ? best.s : getScenario('general');
}

/**
 * LLM 场景分类（一次轻量调用）
 *
 * 输出严格 JSON：{"scenario":"场景id","confidence":0-1}
 * 失败（未配置/超时/解析失败）时回退关键词规则，保证一键生成永不因此中断。
 */
export async function detectScenarioByLlm(
  llm: LLMProvider,
  apiConfig: any,
  topic: string,
): Promise<{ scenario: PptScenario; byLlm: boolean; confidence: number }> {
  const fallback = detectScenarioByKeyword(topic);
  try {
    const ids = PPT_SCENARIOS.map((s) => s.id).join(' / ');
    const prompt = [
      `把以下 PPT 主题归类到最合适的场景，只能从这些里选：${ids}。`,
      `场景说明：`,
      ...PPT_SCENARIOS.map((s) => `- ${s.id}：${s.description}`),
      ``,
      `主题：「${topic}」`,
      ``,
      `严格输出 JSON（不要 markdown 代码块）：{"scenario":"场景id","confidence":0到1的数字}`,
    ].join('\n');
    const resp = await llm.chat({
      apiConfig,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });
    let text = (resp.content || '').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    const parsed = JSON.parse(text);
    const id = String(parsed.scenario || '').trim();
    if (PPT_SCENARIOS.some((s) => s.id === id)) {
      return { scenario: getScenario(id), byLlm: true, confidence: Number(parsed.confidence) || 0.8 };
    }
    return { scenario: fallback, byLlm: false, confidence: 0.5 };
  } catch {
    return { scenario: fallback, byLlm: false, confidence: 0.5 };
  }
}

/**
 * 构建场景化大纲 prompt（供 ppt:generateOutline 使用）
 *
 * 相比通用 prompt 的增强：
 * 1. 注入结构骨架 → LLM 按企业级页序组织，而不是自由发挥
 * 2. 注入图表建议 → LLM 可在数据页输出 chart 字段（结构化图表数据）
 * 3. 注入场景化内容指引 → 要点风格匹配场景
 */
export function buildScenarioOutlinePrompt(topic: string, slideCount: number, scenario: PptScenario): string {
  const n = Math.max(1, Math.min(20, slideCount));
  return [
    ...outlinePromptCore(topic, n),
    ``,
    `场景：${scenario.name}（${scenario.description}）。`,
    ``,
    `结构骨架（按此顺序组织页面，可按页数增删中间章节，但必须保留封面/目录/结尾；输出时用 role 字段标注）`,
    ...scenario.structure.map((s, i) => `${i + 1}. ${s}`),
    ``,
    scenario.chartHints.length > 0
      ? [
        `图表建议：在对应数据页输出 chart 字段，类型与用法：`,
        ...scenario.chartHints.map((c) => `- 「${c.forSection}」页：${c.note}`),
        ``,
      ].join('\n')
      : '',
    `本场景要点风格：${scenario.outlineGuidance}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 通用大纲 prompt（无匹配场景时使用）——与场景版共用同一套硬性质量要求 */
export function buildGenericOutlinePrompt(topic: string, slideCount: number): string {
  const n = Math.max(1, Math.min(20, slideCount));
  return [
    ...outlinePromptCore(topic, n),
    ``,
    `建议结构：封面 → 目录 → 背景/引入 → 主体 2-4 页（每页一个论点）→ 数据或论证 → 总结 → 结尾`,
    `本场景要点风格：结论先行，每页一个明确观点；要点带数据或具体动作，避免泛泛而谈。`,
  ].join('\n');
}

/**
 * 大纲 prompt 公共骨架：字段说明 + 质量硬性要求。
 * 重构要点（对标 WPS AI PPT 的策划质量）：
 * - 明确 role 字段 → 版式由代码决定，LLM 只负责标注页面角色
 * - 强制「具体化」：禁止空洞词，要求带数字/动作
 * - 明确每类页面的篇幅与要点数（封面/目录/内容/数据各不相同）
 * - 明确 metric 字段 → 数据页的核心大数字由结构化字段承载
 */
function outlinePromptCore(topic: string, n: number): string[] {
  return [
    `你是资深演示文稿策划专家。请为主题「${topic}」策划一份 ${n} 页的 PPT。`,
    ``,
    `【输出格式】严格输出 JSON，不要 markdown 代码块、不要任何解释文字：`,
    `{"title":"演示文稿总标题（不超过 20 字）","slides":[`,
    `  {"role":"cover","title":"主标题","subtitle":"副标题/汇报人+日期","bullets":[]},`,
    `  {"role":"toc","title":"目录","bullets":[],"tocItems":["第一章标题","第二章标题","第三章标题"]},`,
    `  {"role":"content","title":"页标题","bullets":["要点1","要点2","要点3"]},`,
    `  {"role":"data","title":"页标题","metric":"23%","metricLabel":"营收同比增长","bullets":["解读1","解读2"],"note":"数据来源说明","chart":{"type":"bar","labels":["Q1","Q2","Q3","Q4"],"series":[{"name":"营收(万元)","values":[120,180,240,310]}]}},`,
    `  {"role":"closing","title":"感谢观看","subtitle":"联系方式 / Q&A","bullets":[]}`,
    `]}`,
    ``,
    `【role 取值——必须每页都填，决定版式】`,
    `- cover：封面，全文仅 1 页，必须是第 1 页`,
    `- toc：目录，紧跟封面，tocItems 填 3-6 个章节标题`,
    `- section：章节过渡页（章节数≥3 时用，可省略）`,
    `- content：常规内容页（最常用）`,
    `- data：数据页，必须有 metric 字段（核心数字，如 "23%" "1200万"），建议同时给 chart`,
    `- closing：结尾页，全文仅 1 页，必须是最后 1 页`,
    ``,
    `【硬性质量要求——违反任一条视为不合格】`,
    `1. 内容具体化：每条要点 12-28 字，必须包含数字、案例、动作或结论中的至少一项。`,
    `   反例（禁止）："介绍产品功能"、"提升工作效率"、"加强团队建设"。`,
    `   正例："新增 3 项自动化能力，人均日节省 40 分钟"。`,
    `2. 要点数量：content / data 页必须 3-5 条；cover / toc / closing 页 bullets 为空数组 []。`,
    `3. 逻辑递进：相邻页面之间要有承接关系（问题→分析→方案→收益），不要并列罗列无关话题。`,
    `4. 页标题不超过 15 字，且不能重复。`,
    `5. 数据页要求（role=data）：全文安排 1-3 页；metric 必须是可量化的核心数字字符串；`,
    `   chart 的 values 长度必须等于 labels 长度；如无真实数据，用符合常识的示例数据。`,
    `6. 目标受众默认是管理层/客户，语气专业、克制，不使用夸张营销词和 emoji。`,
  ];
}
