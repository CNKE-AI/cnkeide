/**
 * ReportExport —— 统计看板导出（W20）
 *
 * 把 W18 已经算好的看板 + 明细行，转成两种可直接用的格式：
 *   1. CSV（明细）—— 丢进 Excel / 表格工具做二次分析
 *   2. Markdown（报告）—— 直接贴进周报、Issue、文档
 *
 * 设计约束：
 *   1. **纯函数 + 零依赖**（不 import electron / 不碰 fs），tsx 单测无需启动 Electron；
 *   2. 中文在 Excel 里默认乱码，CSV 必须加 UTF-8 BOM；
 *   3. 单元格内容来自用户的历史会话（标题、摘要），必须按 RFC4180 转义，
 *      并挡住 `=`/`+`/`-`/`@` 开头的公式注入 —— Excel 打开别人的 CSV 会执行公式，
 *      这是真实的钓鱼面（CSV injection）。
 */

import type { SessionRow, StatsRange } from './HistoryStats';
import { formatCompact, type StatsDashboard } from './StatsModel';

/** Markdown 报告里明细表最多列多少行（再多就不是"报告"而是数据转储了） */
export const MD_MAX_ROWS = 50;

/** Excel 识别 UTF-8 靠这个 BOM，缺了就是一堆乱码 */
export const UTF8_BOM = '\uFEFF';

export interface ReportMeta {
  range?: StatsRange;
  /** 工作区显示名（已由调用方算好，导出层不猜路径） */
  workspaceLabel?: string;
  keyword?: string;
  generatedAt?: number;
}

const RANGE_LABEL: Record<string, string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
  '90d': '近 90 天',
  all: '全部时间',
};

/** 本地时间 `YYYY-MM-DD HH:mm:ss`（与用户系统日历一致，不用 UTC） */
export function formatTime(ts: number | null | undefined): string {
  if (!ts || typeof ts !== 'number' || ts <= 0) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 千分位，便于人读（CSV 里保持纯数字，交给表格工具自己格式化） */
function grouped(n: number): string {
  return Math.round(n || 0).toLocaleString('en-US');
}

/**
 * 转义一个 CSV 单元格。
 *
 * - 含 `,` / `"` / 换行 → 整体加引号，内部 `"` 变成 `""`（RFC4180）
 * - 以 `= + - @` 或 Tab/CR 开头 → 前置单引号，避免被 Excel 当公式执行
 *   （`-` 开头只在确实是数字时才放过，否则 `-10` 这种负值会被莫名加上引号）
 */
/** 把任意值转成单元格文本；对象走 JSON，避免出现 "[object Object]" */
function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function csvCell(value: unknown): string {
  const raw = toText(value);
  const text = raw.replace(/\r\n|\r|\n/g, '\n');
  if (text === '') return '';

  const isNumberLike = /^-?\d+(\.\d+)?$/.test(text);
  const looksLikeFormula = /^[=+@\t]/.test(text) || (text.startsWith('-') && !isNumberLike);
  const safe = looksLikeFormula ? `'${text}` : text;

  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 明细表头（顺序即列顺序，改这里要同步 buildCsvReport 的行构造） */
export const CSV_HEADERS = [
  '会话ID',
  '标题',
  '工作区',
  '模式',
  '创建时间',
  '更新时间',
  '消息数',
  '用户消息',
  '助手消息',
  '工具调用',
  '工具失败',
  '输入token',
  '输出token',
  '总token',
  '模型',
  '时长(分钟)',
  '摘要',
] as const;

/**
 * 生成 CSV 明细。
 *
 * 返回值带 UTF-8 BOM，调用方直接按 utf8 写文件即可，不需要再自己加。
 */
export function buildCsvReport(rows: SessionRow[], meta: ReportMeta = {}): string {
  const lines: string[] = [CSV_HEADERS.join(',')];

  for (const r of rows || []) {
    lines.push(
      [
        csvCell(r.id),
        csvCell(r.title),
        csvCell(r.workspaceId || '（未归属）'),
        csvCell(r.mode),
        csvCell(formatTime(r.createdAt)),
        csvCell(formatTime(r.updatedAt)),
        csvCell(r.messages),
        csvCell(r.userMessages),
        csvCell(r.assistantMessages),
        csvCell(r.toolCalls),
        csvCell(r.toolFailures),
        csvCell(r.promptTokens),
        csvCell(r.completionTokens),
        csvCell(r.totalTokens),
        csvCell(r.models.join(' / ')),
        csvCell(Math.round((r.durationMs || 0) / 60000)),
        csvCell(r.preview),
      ].join(','),
    );
  }

  // 尾注不写进 CSV（会破坏表格结构），筛选条件放在文件名 + Markdown 报告里
  void meta;
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

function table(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/**
 * 生成 Markdown 报告：先结论后明细，和看板本身的阅读顺序一致，
 * 这样贴进周报时不用重新组织语言。
 */
export function buildMarkdownReport(
  dashboard: StatsDashboard,
  rows: SessionRow[],
  meta: ReportMeta = {},
): string {
  const s = dashboard.summary;
  const at = meta.generatedAt ?? dashboard.generatedAt;
  const rangeLabel = RANGE_LABEL[dashboard.range] || dashboard.range;
  const wsLabel = meta.workspaceLabel || '全部工作区';
  const kw = (meta.keyword || '').trim();

  const out: string[] = [];
  out.push('# CnkeIDE 使用统计报告');
  out.push('');
  out.push(
    `> 生成时间：${formatTime(at)} · 范围：${rangeLabel} · 工作区：${wsLabel}${kw ? ` · 关键词：\`${kw}\`` : ''}`,
  );
  out.push('');

  if (s.messages === 0) {
    out.push('当前筛选范围内没有历史记录，请放宽时间范围或清空关键词后重试。');
    out.push('');
    return out.join('\n');
  }

  // ===== 概览 =====
  out.push('## 概览');
  out.push('');
  out.push(
    table(
      ['指标', '数值'],
      [
        ['会话数', grouped(s.sessions)],
        ['消息数', `${grouped(s.messages)}（用户 ${grouped(s.userMessages)} / 助手 ${grouped(s.assistantMessages)}）`],
        ['工具调用', `${grouped(s.toolCalls)}（失败 ${grouped(s.toolFailures)}，失败率 ${s.toolFailureRate}%）`],
        ['总 token', `${grouped(s.totalTokens)}（输入 ${grouped(s.promptTokens)} / 输出 ${grouped(s.completionTokens)}）`],
        ['缓存命中率', `${s.cacheHitRate}%（${grouped(s.cachedTokens)} token 命中）`],
        ['活跃天数', `${s.activeDays} / ${s.spanDays} 天`],
        ['单会话均值', `${grouped(s.avgTokensPerSession)} token，${s.avgMessagesPerSession} 条消息`],
        ['综合活跃度', `${dashboard.activityScore} / 100`],
      ],
    ),
  );
  out.push('');

  // ===== 核心指标 =====
  if (dashboard.kpis.length > 0) {
    out.push('## 核心指标');
    out.push('');
    out.push(table(['指标', '数值', '说明'], dashboard.kpis.map((k) => [k.label, k.display, k.sub])));
    out.push('');
  }

  // ===== 趋势 =====
  const t = dashboard.trend;
  out.push('## 用量趋势');
  out.push('');
  out.push(
    table(
      ['项目', '数值'],
      [
        ['趋势方向', t.direction === 'up' ? '上行' : t.direction === 'down' ? '回落' : '平稳'],
        ['斜率', `${t.slope >= 0 ? '+' : ''}${t.slope} token/天`],
        ['拟合优度', `R² = ${t.r2}`],
        ['近 7 日均值', grouped(t.movingAvg)],
        ['前后半程变化', t.growthRate === null ? '样本不足' : `${t.growthRate > 0 ? '+' : ''}${t.growthRate}%`],
        ['峰值日', s.peakDate ? `${s.peakDate}（${grouped(s.peakTokens)} token）` : '无'],
      ],
    ),
  );
  out.push('');

  if (t.forecast.length > 0) {
    out.push('### 未来 7 天预测');
    out.push('');
    out.push(
      table(
        ['日期', '预测 token', '区间下限', '区间上限'],
        t.forecast.map((f) => [f.date, grouped(f.tokens), grouped(f.lower), grouped(f.upper)]),
      ),
    );
    out.push('');
  }

  if (t.anomalies.length > 0) {
    out.push('### 异常用量日');
    out.push('');
    out.push(
      table(
        ['日期', 'token', '偏离标准差'],
        t.anomalies.slice(0, 10).map((a) => [a.date, grouped(a.tokens), a.z]),
      ),
    );
    out.push('');
  }

  // ===== 分布 =====
  if (dashboard.models.length > 0) {
    out.push('## 模型分布');
    out.push('');
    out.push(
      table(
        ['模型', '消息数', 'token', '占比'],
        dashboard.models.map((m) => [m.model, m.messages, grouped(m.tokens), `${m.share}%`]),
      ),
    );
    out.push('');
  }

  if (dashboard.tools.length > 0) {
    out.push('## 工具分布');
    out.push('');
    out.push(
      table(
        ['工具', '调用次数', '失败次数', '占比'],
        dashboard.tools
          .slice(0, 15)
          .map((x) => [x.tool, x.count, x.failures, `${x.share}%`]),
      ),
    );
    out.push('');
  }

  // ===== 结论 =====
  if (dashboard.insights.length > 0) {
    out.push('## 结论与建议');
    out.push('');
    const icon = (lv: string) => (lv === 'good' ? '✅' : lv === 'warn' ? '⚠️' : 'ℹ️');
    for (const ins of dashboard.insights) {
      out.push(`- ${icon(ins.level)} **${ins.title}** — ${ins.detail}`);
    }
    out.push('');
  }

  // ===== 明细 =====
  out.push('## 会话明细');
  out.push('');
  if (!rows || rows.length === 0) {
    out.push('（无数据）');
    out.push('');
  } else {
    const shown = rows.slice(0, MD_MAX_ROWS);
    out.push(
      table(
        ['时间', '标题', '消息', '工具', 'token', '模型'],
        shown.map((r) => [
          formatTime(r.updatedAt),
          r.title,
          r.messages,
          r.toolCalls,
          formatCompact(r.totalTokens),
          r.models.join(' / ') || '—',
        ]),
      ),
    );
    out.push('');
    if (rows.length > shown.length) {
      out.push(`> 共 ${rows.length} 条会话，此处仅列出最近 ${shown.length} 条；完整明细见同目录 CSV。`);
      out.push('');
    }
  }

  return out.join('\n');
}

/** 建议的文件名（不含目录）：统计报告-20261028-1530.csv */
export function suggestFileName(format: 'csv' | 'markdown', now: number = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return format === 'csv' ? `统计报告-${stamp}.csv` : `统计报告-${stamp}.md`;
}
