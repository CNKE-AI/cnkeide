/**
 * PPT 智能审校（生成前静态检查 + 自动修复）
 *
 * 目标：在 pptxgenjs 生成前把「排版错误、文字溢出、数据失真」消灭在源头。
 * 分两级：
 * - fixed：能安全自动修的（超长截断、要点拆分、图表数据截齐），直接修并记录
 * - warning：不能自动修的（空标题、图片路径缺失），报告给前端展示
 *
 * 与 pptRenderer 的 HTML audit（渲染后视觉自检）互补：
 * 这里管 PPTX 原生导出路径，纯静态规则，零成本。
 */

export interface AuditIssue {
  /** warning = 需用户注意；fixed = 已自动修复 */
  level: 'warning' | 'fixed';
  /** 页码（0 = 全局） */
  slide: number;
  message: string;
}

export interface AuditChartInput {
  type?: 'bar' | 'line' | 'pie';
  labels?: string[];
  series?: { name: string; values: number[] }[];
}

export interface AuditSlideInput {
  title?: string;
  subtitle?: string;
  bullets?: { text: string; level?: number }[];
  chart?: AuditChartInput;
  image?: { path?: string; data?: string; w?: number; h?: number };
  /** 页面角色（cover/toc/section/content/data/closing）——版式依据，必须透传 */
  role?: 'cover' | 'toc' | 'section' | 'content' | 'data' | 'closing';
  /** 目录页条目（role=toc） */
  tocItems?: string[];
  /** 数据页核心数字（role=data），如 "23%" */
  metric?: string;
  /** 核心数字的标签 */
  metricLabel?: string;
  /** 底部图注/补充说明 */
  note?: string;
}

export interface AuditOutlineInput {
  title?: string;
  author?: string;
  slides?: AuditSlideInput[];
}

export interface AuditResult<T> {
  /** 修复后的数据（新对象，不修改入参） */
  data: T;
  issues: AuditIssue[];
  /** 是否不存在未修复的 warning */
  passed: boolean;
}

/** 页标题安全上限（32px 标题位、13.3 英寸宽版心） */
const MAX_TITLE_LEN = 18;
/** 单条要点安全上限（16px 正文、行高 24，5 条要点不溢出） */
const MAX_BULLET_LEN = 42;
/** 单页要点数上限 */
const MAX_BULLETS = 6;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 超长要点拆分为多条（按标点优先切） */
function splitBullet(text: string): string[] {
  const parts = text.split(/(?<=[。；;，,、])|(?<=——)/).filter((p) => p.trim());
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= MAX_BULLET_LEN) {
      out.push(p.trim());
    } else {
      // 标点切完还超长 → 按长度硬切
      for (let i = 0; i < p.length; i += MAX_BULLET_LEN) {
        out.push(p.slice(i, i + MAX_BULLET_LEN).trim());
      }
    }
  }
  return out.filter(Boolean);
}

/**
 * 审校并修复大纲（PPTX 导出前调用）。
 * 返回修复后的新对象 + 问题清单（fixed 已修 / warning 需人工确认）。
 */
export function auditOutline(outline: AuditOutlineInput): AuditResult<AuditOutlineInput> {
  const issues: AuditIssue[] = [];
  const src = outline || { slides: [] };
  const srcSlides = Array.isArray(src.slides) ? src.slides : [];

  // ---- 全局：演示文稿标题 ----
  let docTitle = String(src.title || '');
  if (!docTitle.trim()) {
    docTitle = '未命名演示文稿';
    issues.push({ level: 'warning', slide: 0, message: '演示文稿标题为空，已填占位「未命名演示文稿」' });
  }

  // ---- 逐页 ----
  const slides: AuditSlideInput[] = srcSlides.map((s, idx) => {
    const page = idx + 1;
    const fixed: AuditSlideInput = { ...s };

    // 标题
    const t = String(fixed.title || '').trim();
    if (!t) {
      issues.push({ level: 'warning', slide: page, message: `第 ${page} 页标题为空，请补充` });
      fixed.title = `第 ${page} 页`;
    } else if (t.length > MAX_TITLE_LEN) {
      issues.push({ level: 'fixed', slide: page, message: `第 ${page} 页标题 ${t.length} 字超限，已截断到 ${MAX_TITLE_LEN} 字` });
      fixed.title = truncate(t, MAX_TITLE_LEN);
    }

    // 副标题
    if (fixed.subtitle && String(fixed.subtitle).length > 30) {
      issues.push({ level: 'fixed', slide: page, message: `第 ${page} 页副标题过长，已截断` });
      fixed.subtitle = truncate(String(fixed.subtitle), 30);
    }

    // 要点：拆分超长 + 截断超量
    const bullets = Array.isArray(fixed.bullets) ? fixed.bullets : [];
    const expanded: { text: string; level?: number }[] = [];
    for (const b of bullets) {
      const text = String(b?.text ?? '').trim();
      if (!text) continue;
      if (text.length > MAX_BULLET_LEN) {
        const parts = splitBullet(text);
        // 拆完总量可能超页容量 → 只保留前几条并提示
        for (const p of parts) expanded.push({ text: p, level: b?.level });
        issues.push({ level: 'fixed', slide: page, message: `第 ${page} 页有要点长 ${text.length} 字，已按标点拆分为 ${parts.length} 条` });
      } else {
        expanded.push({ text, level: b?.level });
      }
    }
    if (expanded.length > MAX_BULLETS) {
      issues.push({ level: 'fixed', slide: page, message: `第 ${page} 页要点 ${expanded.length} 条超上限，已保留前 ${MAX_BULLETS} 条（要点精炼是排版不溢出的第一保证）` });
      fixed.bullets = expanded.slice(0, MAX_BULLETS);
    } else {
      fixed.bullets = expanded;
    }
    if (expanded.length === 0 && !fixed.chart && !fixed.image) {
      issues.push({ level: 'warning', slide: page, message: `第 ${page} 页无要点/图表/图片，输出将为空页` });
    }

    // 图表：数据一致性
    if (fixed.chart) {
      const c = { ...fixed.chart };
      const labels = Array.isArray(c.labels) ? c.labels.map(String) : [];
      const series = Array.isArray(c.series) ? c.series.map((x) => ({ ...x, values: Array.isArray(x.values) ? [...x.values] : [] })) : [];
      if (labels.length === 0 || series.length === 0 || series.some((s2) => s2.values.length === 0)) {
        issues.push({ level: 'warning', slide: page, message: `第 ${page} 页图表数据不完整（labels/series/values 有空），已忽略该图表` });
        fixed.chart = undefined;
      } else {
        const labelLen = labels.length;
        series.forEach((ser) => {
          if (ser.values.length !== labelLen) {
            issues.push({ level: 'fixed', slide: page, message: `第 ${page} 页图表系列「${ser.name}」数据量(${ser.values.length})与类目数(${labelLen})不一致，已截齐` });
            ser.values = ser.values.slice(0, labelLen);
            while (ser.values.length < labelLen) ser.values.push(0);
          }
        });
        // 饼图单系列语义：多系列只保留第一个
        if (c.type === 'pie' && series.length > 1) {
          issues.push({ level: 'fixed', slide: page, message: `第 ${page} 页饼图多系列无意义，已保留第一系列` });
          c.series = series.slice(0, 1);
        } else {
          c.series = series;
        }
        c.labels = labels;
        fixed.chart = c;
      }
    }

    // 图片：路径/数据缺失提示（失真检查在 PptxTools 生成时按实际尺寸做，那里有 w/h）
    if (fixed.image && !fixed.image.path && !fixed.image.data) {
      issues.push({ level: 'warning', slide: page, message: `第 ${page} 页图片缺少 path/data，已忽略` });
      fixed.image = undefined;
    }

    return fixed;
  });

  return {
    data: { ...src, title: docTitle, slides },
    issues,
    passed: issues.every((i) => i.level === 'fixed'),
  };
}

/**
 * 图片宽高比失真检查（PPTX 生成时调用）
 *
 * @param ratio 图片显示宽高比（w/h）
 * @param natural 原图宽高比（w/h）
 * @returns 失真超 20% 返回 true
 */
export function isImageDistorted(ratio: number, natural: number): boolean {
  if (!Number.isFinite(ratio) || !Number.isFinite(natural) || natural <= 0) return false;
  return Math.abs(ratio - natural) / natural > 0.2;
}

/** 审校问题清单 → 前端可读摘要 */
export function summarizeIssues(issues: AuditIssue[]): string {
  if (issues.length === 0) return '审校通过：无排版风险';
  const fixed = issues.filter((i) => i.level === 'fixed').length;
  const warn = issues.filter((i) => i.level === 'warning').length;
  const parts: string[] = [];
  if (fixed) parts.push(`自动修复 ${fixed} 处`);
  if (warn) parts.push(`${warn} 处需人工确认`);
  return `审校完成：${parts.join('，')}`;
}
