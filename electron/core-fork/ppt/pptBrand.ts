/**
 * PPT 企业品牌配置
 *
 * 企业级刚需：Logo、企业色、字体、公司名、页脚。
 * - 存储在 ConfigAdapter 的 ppt.brand key（userData/config/app-config.json）
 * - 生成 PPTX 时品牌色优先于主题色（企业视觉统一）
 * - Logo 注入封面右上角 + 内容页右下角
 * - 页脚：公司名 + 页码（内容页）
 */

export interface PptBrand {
  /** 是否启用品牌元素（关闭时完全用主题默认） */
  enabled: boolean;
  /** 公司名称（封面/页脚） */
  companyName: string;
  /** Logo 图片绝对路径（png/jpg，建议透明底） */
  logoPath: string;
  /** 企业主色（hex，含 #；空串 = 用主题默认） */
  primary: string;
  /** 企业辅色 */
  secondary: string;
  /** 强调色 */
  accent: string;
  /** 正文字体（如 "Microsoft YaHei"；空 = pptxgenjs 默认） */
  fontFamily: string;
  /** 页脚附加文本（如 slogan / 部门名；空 = 不显示） */
  footerText: string;
}

export const DEFAULT_BRAND: PptBrand = {
  enabled: false,
  companyName: '',
  logoPath: '',
  primary: '',
  secondary: '',
  accent: '',
  fontFamily: '',
  footerText: '',
};

/** 归一化用户输入的品牌配置（容错：去空白、hex 补 #） */
export function normalizeBrand(raw: any): PptBrand {
  const b = { ...DEFAULT_BRAND, ...(raw || {}) };
  const hex = (c: string) => {
    const s = String(c || '').trim();
    if (!s) return '';
    return /^#?[0-9a-fA-F]{6}$/.test(s) ? (s.startsWith('#') ? s : `#${s}`) : '';
  };
  return {
    enabled: !!b.enabled,
    companyName: String(b.companyName || '').trim(),
    logoPath: String(b.logoPath || '').trim(),
    primary: hex(b.primary),
    secondary: hex(b.secondary),
    accent: hex(b.accent),
    fontFamily: String(b.fontFamily || '').trim(),
    footerText: String(b.footerText || '').trim(),
  };
}

/**
 * 品牌色合并主题色：品牌色优先，缺的回退主题色。
 * 返回 pptxgenjs 可用的无 # 6 位 hex。
 */
export function mergeBrandColors(
  brand: PptBrand | null | undefined,
  themeColors: { primary: string; secondary: string; accent: string; background: string },
): { primary: string; secondary: string; accent: string; background: string } {
  const toHex = (c: string, fallback: string) => {
    const s = String(c || '').replace('#', '');
    return /^[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : fallback.replace('#', '').toUpperCase();
  };
  return {
    primary: toHex(brand?.enabled ? brand.primary : '', themeColors.primary),
    secondary: toHex(brand?.enabled ? brand.secondary : '', themeColors.secondary),
    accent: toHex(brand?.enabled ? brand.accent : '', themeColors.accent),
    background: toHex(themeColors.background, 'FFFFFF'),
  };
}
