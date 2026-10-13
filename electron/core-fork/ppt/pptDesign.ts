import type { LayoutId } from './pptThemes';

export interface AiPptPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
}

export type AiPptArtDirection = 'education' | 'culture' | 'technology' | 'healthcare' | 'business';

export interface AiPptDesign {
  /** 使用现有可编辑版式骨架，绝不下载或套用外部 PPT 模板。 */
  themeId: 'business' | 'academic' | 'chinese' | 'illustration';
  /** 本地矢量场景方向，用于生成类似专业模板的插画构图。 */
  artDirection: AiPptArtDirection;
  palette: AiPptPalette;
  fontFamily: string;
  visualStyle: string;
  rationale: string;
}

export interface AiPptSlideHint {
  title?: string;
  role?: LayoutId;
  bullets?: string[];
  chart?: unknown;
}

const FALLBACK_PALETTES: Record<AiPptDesign['themeId'], AiPptPalette> = {
  business: { primary: '#1E3A8A', secondary: '#7C3AED', accent: '#06B6D4', background: '#F8FAFC' },
  academic: { primary: '#0F172A', secondary: '#0F766E', accent: '#0891B2', background: '#FFFFFF' },
  chinese: { primary: '#7F1D1D', secondary: '#A16207', accent: '#0F766E', background: '#FEF3C7' },
  illustration: { primary: '#BE185D', secondary: '#EA580C', accent: '#059669', background: '#FFF7ED' },
};

const VALID_THEME_IDS = new Set<AiPptDesign['themeId']>(Object.keys(FALLBACK_PALETTES) as AiPptDesign['themeId'][]);
const VALID_FONTS = new Set(['Microsoft YaHei', 'PingFang SC', 'Source Han Sans SC', 'Source Han Serif SC', 'KaiTi', 'SimSun']);

function normalizeHex(value: unknown, fallback: string): string {
  const hex = String(value || '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : fallback;
}

/**
 * 约束 LLM 的设计输出：AI 可决定风格和配色，但所有值必须落到本地可渲染的安全集合。
 * 这让预览与 PPTX 导出能消费同一份设计方案，而不会引入不稳定的 HTML/CSS 模板。
 */
export function normalizeAiPptDesign(raw: unknown, fallbackThemeId: string = 'business'): AiPptDesign {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const themeId = VALID_THEME_IDS.has(source.themeId as AiPptDesign['themeId'])
    ? source.themeId as AiPptDesign['themeId']
    : (VALID_THEME_IDS.has(fallbackThemeId as AiPptDesign['themeId'])
      ? fallbackThemeId as AiPptDesign['themeId']
      : 'business');
  const defaults = FALLBACK_PALETTES[themeId];
  const paletteRaw = source.palette && typeof source.palette === 'object'
    ? source.palette as Record<string, unknown>
    : {};
  const requestedFont = String(source.fontFamily || '').trim();

  const requestedArt = String(source.artDirection || '');
  const artDirection: AiPptArtDirection = ['education', 'culture', 'technology', 'healthcare', 'business'].includes(requestedArt)
    ? requestedArt as AiPptArtDirection
    : (themeId === 'chinese' ? 'culture' : themeId === 'illustration' ? 'education' : 'business');
  return {
    themeId,
    artDirection,
    palette: {
      primary: normalizeHex(paletteRaw.primary, defaults.primary),
      secondary: normalizeHex(paletteRaw.secondary, defaults.secondary),
      accent: normalizeHex(paletteRaw.accent, defaults.accent),
      background: normalizeHex(paletteRaw.background, defaults.background),
    },
    fontFamily: VALID_FONTS.has(requestedFont) ? requestedFont : 'Microsoft YaHei',
    visualStyle: String(source.visualStyle || '专业简约').slice(0, 48),
    rationale: String(source.rationale || '依据主题和内容自动选择配色与版式。').slice(0, 120),
  };
}

export function buildAiPptDesignPrompt(input: {
  topic: string;
  scenarioName?: string;
  slides: AiPptSlideHint[];
}): string {
  const slideHints = input.slides.slice(0, 20).map((slide, index) => ({
    page: index + 1,
    title: String(slide.title || '').slice(0, 80),
    role: slide.role || 'content',
    bulletCount: Array.isArray(slide.bullets) ? slide.bullets.length : 0,
    hasChart: !!slide.chart,
  }));
  return `你是专业演示文稿设计总监。请为以下 PPT 生成一份“原创视觉设计方案”。\n\n主题：${input.topic}\n场景：${input.scenarioName || '通用演示'}\n页面摘要：${JSON.stringify(slideHints)}\n\n严格只输出 JSON，不要 markdown：\n{\n  "themeId": "business|academic|chinese|illustration",
  "artDirection": "education|culture|technology|healthcare|business",\n  "palette": {"primary":"#RRGGBB","secondary":"#RRGGBB","accent":"#RRGGBB","background":"#RRGGBB"},\n  "fontFamily": "Microsoft YaHei|PingFang SC|Source Han Sans SC|Source Han Serif SC|KaiTi|SimSun",\n  "visualStyle": "不超过24字的原创风格名称",\n  "rationale": "不超过80字，说明为何适合该主题"\n}\n\n要求：这是本地代码自动绘制的原创 PPT，不使用、不下载、不套用任何外部 PPT 模板。颜色必须满足专业、清晰、易读；正文背景优先浅色。`;
}
