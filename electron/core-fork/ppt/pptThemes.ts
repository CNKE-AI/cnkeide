/**
 * PPT 内置主题 + 版式骨架
 *
 * 设计原则（重要）：
 * 1. 每个主题除配色外，还提供 6 套预设版式（cover/toc/section/content/data/closing）
 * 2. 每套版式 = 一段严格的版式规范 prompt：字号梯度 / 元素清单 / 间距 / 颜色用法
 * 3. system prompt 强制 LLM 只能从这 6 套里选，禁止自创装饰
 *
 * 为什么这样设计：
 * 之前的 LLM 即便给了配色 prompt，输出仍是「AI 半吊子审美」（堆 gradient +
 * glassmorphism + 大 emoji + 大字号）。真正专业的演示文稿是版式驱动的——
 * 设计师先选版式再填内容，而不是从零排版。
 */

export interface PptTheme {
  id: string;
  name: string;
  description: string;
  colors: { primary: string; secondary: string; accent: string; background: string };
  icon: string;
  /** 6 套版式骨架 */
  layouts: Record<LayoutId, LayoutSpec>;
}

export type LayoutId = 'cover' | 'toc' | 'section' | 'content' | 'data' | 'closing';

export interface LayoutSpec {
  id: LayoutId;
  /** 中文名（给 LLM 看） */
  name: string;
  /** 一句话用途 */
  purpose: string;
  /** 给 LLM 的版式规范 prompt */
  prompt: string;
}

/**
 * 通用 6 套版式骨架（与主题无关；主题只决定配色和细节调整）
 * 每个版式的 prompt 都极度具体：字号、留白、元素清单、颜色用法
 */
const LAYOUT_TEMPLATES: Record<LayoutId, Omit<LayoutSpec, 'id'>> = {
  cover: {
    name: '封面页',
    purpose: '演示文稿第一页：演示主题 + 副标题 + 日期/作者',
    prompt: `
【版式：封面页（cover）】—— 严格按以下规范，禁止自创元素：
- 整页背景：使用主题 primary 渐变到 secondary（linear-gradient 135deg）
- 主标题：字号 72px，加粗，行高 1.1，居中或左对齐，单行不超过 12 字（可换行）
- 副标题：字号 24px，weight 300，主标题下方 60px 间距，opacity 0.7
- 右上角：作者/日期小字 14px，opacity 0.5
- 左下角：accent 色的 4px × 80px 竖条作为唯一装饰
- 禁止：emoji、玻璃卡片、多个数字框、backdrop-filter、图标
- 元素清单只能有这 4 个：背景 + 主标题 + 副标题 + 左下竖条
- 留白：上下各 18%，左右各 12%
`.trim(),
  },
  toc: {
    name: '目录页',
    purpose: '演示文稿概览：3-6 个章节标题列表',
    prompt: `
【版式：目录页（toc）】—— 严格按以下规范，禁止自创元素：
- 整页背景：主题 background 纯色，无渐变
- 页面顶部：标题「目录」或「CONTENTS」+ accent 色 3px 短横线（80px 宽）
  - 标题字号 36px，weight 600
- 中部：3-6 个章节条目，单列布局，左对齐
  - 条目格式：序号 14px（accent 色） + 标题 22px（primary 色，weight 500）
  - 条目间垂直间距 28px
- 禁止：emoji / 玻璃卡片 / 渐变背景 / 多列网格
- 元素清单只能有这 3 个：顶部标题 + 短横线 + 章节条目列表
- 留白：顶部 15%，左 12%
`.trim(),
  },
  section: {
    name: '分节页',
    purpose: '章节起始：突出当前章节标题',
    prompt: `
【版式：分节页（section）】—— 严格按以下规范，禁止自创元素：
- 整页背景：主题 primary 色纯色（不是渐变）
- 居中放置：章节序号 + 章节标题
- 章节序号：12px，accent 色，居中，字距 4px，置于章节标题上方 40px
- 章节标题：56px，weight 700，纯白或 background 的对比色，居中，单行
- 章节标题下方 60px：accent 色 4px × 60px 短横线
- 禁止：渐变背景 / 装饰图标 / 副标题 / 多个色块 / emoji
- 元素清单只能有这 4 个：纯色背景 + 序号 + 标题 + 短横线
- 留白：上下 30%
`.trim(),
  },
  content: {
    name: '内容页（列表/段落）',
    purpose: '正文要点展示：标题 + 3-5 条要点',
    prompt: `
【版式：内容页（content）】—— 严格按以下规范，禁止自创元素：
- 整页背景：主题 background 色
- 左上：页面标题 32px，weight 600，primary 色，标题下方 16px 处有 accent 色 2px × 40px 短横线
- 标题下方 60px 开始：3-5 条要点，单列左对齐
  - 要点样式：12px accent 色方块（8px × 8px，绝对定位在要点文字左侧）+ 要点文字 18px，weight 400，行高 1.8
  - 要点间垂直间距 24px
- 禁止：emoji / 卡片容器 / backdrop-filter / 多列网格 / 大字号数字
- 元素清单只能有这 3 个：标题 + 短横线 + 要点列表
- 留白：顶部 12%，左 12%，要点区最大宽度 800px
`.trim(),
  },
  data: {
    name: '数据页（单指标+说明）',
    purpose: '强调 1 个核心数字 + 简短解读',
    prompt: `
【版式：数据页（data）】—— 严格按以下规范，禁止自创元素：
- 整页背景：主题 background 色
- 左上：页面标题 28px，weight 600，primary 色
- 页面中部偏左：超大数字 96px，weight 700，accent 色，行高 1
- 数字右侧 32px：标签 18px，weight 500，primary 色（单行）和解读 14px，opacity 0.7（最多 2 行）
- 页面底部 1/4 处：纯文本补充说明 16px，weight 400，opacity 0.7，单行
- 禁止：emoji / 玻璃容器 / 多个数字框 / 大图标 / 渐变
- 元素清单只能有这 4 个：标题 + 数字 + 标签解读 + 底部说明
- 留白：顶部 18%，左 12%，数字垂直居中
`.trim(),
  },
  closing: {
    name: '结尾页',
    purpose: '总结/感谢/联系方式',
    prompt: `
【版式：结尾页（closing）】—— 严格按以下规范，禁止自创元素：
- 整页背景：主题 primary 渐变到 secondary（同 cover）
- 居中：「感谢观看 / Thank You」 64px，weight 700
- 下方 80px：副标题 20px，weight 300，opacity 0.7（如联系方式 / Q&A）
- 左下角：accent 色 4px × 80px 竖条（同 cover 一致，保持视觉闭环）
- 禁止：emoji / 玻璃卡片 / 多段文字 / 装饰图标 / 大段联系信息
- 元素清单只能有这 4 个：背景 + 主标题 + 副标题 + 左下竖条
- 留白：上下 28%
`.trim(),
  },
};

/**
 * 主题细节调整：每个主题对版式做差异化（字号微调、留白微调）
 */
const THEME_OVERRIDES: Record<string, Partial<Record<LayoutId, string>>> = {
  academic: {
    // 学术风：更克制、字号偏小、留白更大
    cover: '主标题改用宋体（Source Han Serif）；字号降到 64px；左下竖条改 2px 宽。',
    content: '字号：标题 28px，要点 16px；要点间间距 28px；颜色用纯黑（#0f172a）；不用 accent 色装饰方块，改用 1px 实线项目符号。',
    closing: '主标题改用宋体；字号降到 56px；副标题用纯黑（背景浅色场景）',
  },
  chinese: {
    // 中国风：楷体/宋体 + 暗金色装饰
    cover: '主标题改用楷体（STKaiti / KaiTi）；字号 64px；左下竖条改暗金色 a16207。',
    content: '标题 30px 楷体；要点 17px 宋体；装饰方块改为 4px × 4px 暗金小方。',
    closing: '主标题改用楷体；字号 56px；暗金装饰。',
  },
  illustration: {
    // 插画风：圆角 + emoji 可用 + 暖色调
    cover: '主标题 80px，weight 800；左下竖条改 6px × 80px 圆角矩形（粉色）。',
    content: '标题 36px；要点 18px，行高 1.9；装饰方块改 8px × 8px 圆角（薄荷绿）；可用 1-2 个 emoji 作为要点前缀（⚠️ 限 1.5em 字号）。',
  },
  // business 用默认即可
};

function buildLayouts(themeId: string): Record<LayoutId, LayoutSpec> {
  const out = {} as Record<LayoutId, LayoutSpec>;
  (Object.keys(LAYOUT_TEMPLATES) as LayoutId[]).forEach((id) => {
    const base = LAYOUT_TEMPLATES[id];
    const override = THEME_OVERRIDES[themeId]?.[id];
    out[id] = {
      id,
      name: base.name,
      purpose: base.purpose,
      prompt: override ? `${base.prompt}\n【本主题细节】${override}` : base.prompt,
    };
  });
  return out;
}

const BASE_THEMES: Array<Omit<PptTheme, 'layouts'>> = [
  {
    id: 'business',
    name: '商业/产品风',
    description: '深蓝 + 紫渐变，推介路演、公司介绍、季度汇报',
    icon: 'Briefcase',
    colors: { primary: '#1e3a8a', secondary: '#7c3aed', accent: '#06b6d4', background: '#f8fafc' },
  },
  {
    id: 'academic',
    name: '简约学术风',
    description: '黑白调为主，薄荷绿/青色点缀，论文汇报、课堂讲义、教学',
    icon: 'GraduationCap',
    colors: { primary: '#0f172a', secondary: '#14b8a6', accent: '#0891b2', background: '#ffffff' },
  },
  {
    id: 'chinese',
    name: '中国风',
    description: '水墨、乌龙茶、中国红 + 金边，营销、传统主题、节庆',
    icon: 'Mountain',
    colors: { primary: '#7f1d1d', secondary: '#a16207', accent: '#0f766e', background: '#fef3c7' },
  },
  {
    id: 'illustration',
    name: '轻松插画风',
    description: '活泼、插画 / emoji 丰富，读书分享、节日、个人发展',
    icon: 'Smile',
    colors: { primary: '#ec4899', secondary: '#f59e0b', accent: '#10b981', background: '#fff7ed' },
  },
];

export const PPT_THEMES: PptTheme[] = BASE_THEMES.map((t) => ({
  ...t,
  layouts: buildLayouts(t.id),
}));

export function findTheme(id: string): PptTheme | undefined {
  return PPT_THEMES.find((t) => t.id === id);
}

/** 列出所有版式 ID（用于 prompt 提示 LLM） */
export const LAYOUT_IDS: LayoutId[] = ['cover', 'toc', 'section', 'content', 'data', 'closing'];