/**
 * StatsModel —— 基于历史记录的统计分析模型（W18 统计看板）
 *
 * 模型能力（全部为无依赖的确定性算法，便于单测）：
 *   1. 趋势拟合：最小二乘线性回归（slope / intercept / R²）
 *   2. 平滑：简单移动平均，用于把"零星空白天"抖动压掉
 *   3. 预测：以近期窗口拟合直线外推，并用残差标准差给出置信带
 *   4. 异常检测：z-score 找出显著偏离均值的日期
 *   5. 指标评分：把多维原始数据折算成 0-100 的圆环指标
 *   6. 洞察生成：把上面的数字翻译成一句人话（含方向/幅度/建议）
 *
 * 说明：数据量是"单人单机 IDE 使用记录"，样本量小（几十~几百天），
 * 因此刻意不用 ARIMA 等重模型——线性趋势 + 移动平均 + z-score 已经足够，
 * 且结果可解释，用户能直接对上自己的使用习惯。
 */

import {
  collectDaily,
  filterSessions,
  hourlyActivity,
  modelDistribution,
  summarize,
  toolDistribution,
  type DailyPoint,
  type ModelSlice,
  type SessionLike,
  type StatsFilter,
  type StatsSummary,
  type ToolSlice,
} from './HistoryStats';

export type InsightLevel = 'good' | 'warn' | 'info';

/**
 * 预测 / 异常检测所需的最少「有数据的天数」。
 * 只看天数不够：把窗口拉宽到 90 天时大量日期是 0，样本仍然只有两三天，
 * 此时的回归与离群判定都没有统计意义，一律跳过。
 */
export const MIN_ACTIVE_DAYS = 3;

export interface Insight {
  level: InsightLevel;
  title: string;
  detail: string;
  /** 关联指标值，前端可做小标签 */
  metric?: string;
}

export interface RingKpi {
  key: string;
  label: string;
  /** 0-100，用于画圆环 */
  value: number;
  /** 圆环中心大字，如 "92.4%" */
  display: string;
  /** 圆环下方说明，如 "1.2k / 1.3k" */
  sub: string;
  tone: 'violet' | 'amber' | 'cyan' | 'emerald';
}

export interface ForecastPoint {
  date: string;
  tokens: number;
  lower: number;
  upper: number;
}

export interface TrendModel {
  /** 日均斜率（token/天） */
  slope: number;
  /** 拟合优度 0-1 */
  r2: number;
  /** 平滑后的日均 token（近 7 天或全窗口） */
  movingAvg: number;
  /** 前半段 vs 后半段的变化率（%），无足够数据时为 null */
  growthRate: number | null;
  /** 预测点 */
  forecast: ForecastPoint[];
  /** 异常日 */
  anomalies: { date: string; tokens: number; z: number }[];
  /** 结论方向 */
  direction: 'up' | 'down' | 'flat';
}

export interface StatsDashboard {
  generatedAt: number;
  range: string;
  summary: StatsSummary;
  kpis: RingKpi[];
  daily: DailyPoint[];
  trend: TrendModel;
  models: ModelSlice[];
  tools: ToolSlice[];
  hourly: number[];
  insights: Insight[];
  /** 综合活跃度评分 0-100 */
  activityScore: number;
}

// ===== 1. 线性回归 =====

export interface RegressionResult {
  slope: number;
  intercept: number;
  /** 决定系数 R²，样本 < 2 或方差为 0 时返回 0 */
  r2: number;
}

/** 最小二乘一元线性回归 y = slope * x + intercept */
export function linearRegression(values: number[]): RegressionResult {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? values[0] : 0, r2: 0 };

  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    sxy += dx * (values[i] - meanY);
    sxx += dx * dx;
  }
  if (sxx === 0) return { slope: 0, intercept: meanY, r2: 0 };

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * i + intercept;
    ssTot += (values[i] - meanY) ** 2;
    ssRes += (values[i] - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, Math.min(1, 1 - ssRes / ssTot));
  return { slope, intercept, r2 };
}

// ===== 2. 移动平均 =====

export function movingAverage(values: number[], window = 7): number[] {
  const w = Math.max(1, Math.floor(window));
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= w) sum -= values[i - w];
    out.push(sum / Math.min(i + 1, w));
  }
  return out;
}

/** 取最后一段的平均值，用于"近 N 天日均" */
export function tailAverage(values: number[], window = 7): number {
  if (values.length === 0) return 0;
  const tail = values.slice(Math.max(0, values.length - Math.max(1, window)));
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

// ===== 3. 预测 =====

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function addDays(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 基于近 fitWindow 天拟合直线并外推 horizon 天。
 * 置信带 = 预测值 ± 1.96 * 残差标准差 * sqrt(1 + 步长/样本量)，随外推距离变宽。
 */
export function forecastSeries(
  daily: DailyPoint[],
  options: { horizon?: number; fitWindow?: number } = {},
): ForecastPoint[] {
  const horizon = Math.max(0, options.horizon ?? 7);
  const fitWindow = Math.max(2, options.fitWindow ?? 14);
  if (horizon === 0 || daily.length === 0) return [];

  const series = daily.slice(Math.max(0, daily.length - fitWindow)).map((p) => p.totalTokens);
  // 有效样本太少（例如刚开始用两天）时回归没有意义，宁可不给预测也不要给一条误导性的直线
  if (series.filter((v) => v > 0).length < MIN_ACTIVE_DAYS) return [];

  const { slope, intercept } = linearRegression(series);
  const residuals = series.map((v, i) => v - (slope * i + intercept));
  const sigma = stdDev(residuals);
  const lastDate = daily[daily.length - 1]?.date ?? new Date().toISOString().slice(0, 10);
  const base = series.length;

  const out: ForecastPoint[] = [];
  for (let i = 1; i <= horizon; i++) {
    const x = base - 1 + i;
    const pred = Math.max(0, slope * x + intercept);
    const band = 1.96 * sigma * Math.sqrt(1 + i / base);
    out.push({
      date: addDays(lastDate, i),
      tokens: Math.round(pred),
      lower: Math.max(0, Math.round(pred - band)),
      upper: Math.round(pred + band),
    });
  }
  return out;
}

// ===== 4. 异常检测 =====

export function detectAnomalies(
  daily: DailyPoint[],
  options: { threshold?: number; field?: keyof DailyPoint } = {},
): { date: string; tokens: number; z: number }[] {
  const threshold = options.threshold ?? 2;
  const field = options.field ?? 'totalTokens';
  const values = daily.map((p) => {
    const v = p[field];
    return typeof v === 'number' ? v : 0;
  });
  if (values.length < 3) return [];
  // 全窗口只有一两天有数据时，"离群"只是"这是唯一干过活的一天"，不构成异常
  if (values.filter((v) => v > 0).length < MIN_ACTIVE_DAYS) return [];

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = stdDev(values);
  if (sd <= 0) return [];

  const out: { date: string; tokens: number; z: number }[] = [];
  values.forEach((v, i) => {
    const z = (v - mean) / sd;
    if (Math.abs(z) >= threshold) {
      out.push({ date: daily[i].date, tokens: Math.round(v), z: Math.round(z * 100) / 100 });
    }
  });
  return out.sort((a, b) => b.z - a.z);
}

// ===== 5. 指标评分（圆环） =====

function pct(v: number): string {
  return `${(Math.round(v * 10) / 10).toFixed(1)}%`;
}

export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function buildKpis(summary: StatsSummary, daily: DailyPoint[]): RingKpi[] {
  const tokenSeries = daily.map((p) => p.totalTokens);
  const peak = Math.max(0, ...tokenSeries);
  const avg = tokenSeries.length > 0 ? tokenSeries.reduce((a, b) => a + b, 0) / tokenSeries.length : 0;

  const toolSuccessRate = summary.toolCalls > 0 ? 100 - summary.toolFailureRate : 100;
  const activeRate = summary.spanDays > 0 ? (summary.activeDays / summary.spanDays) * 100 : 0;
  const intensity = peak > 0 ? (avg / peak) * 100 : 0;

  return [
    {
      key: 'cache',
      label: '缓存命中率',
      value: Math.min(100, summary.cacheHitRate),
      display: pct(summary.cacheHitRate),
      sub: `${formatCompact(summary.cachedTokens)} / ${formatCompact(summary.promptTokens)} 输入 token`,
      tone: 'cyan',
    },
    {
      key: 'tool',
      label: '工具成功率',
      value: Math.min(100, toolSuccessRate),
      display: pct(toolSuccessRate),
      sub: `${formatCompact(summary.toolCalls - summary.toolFailures)} / ${formatCompact(summary.toolCalls)} 次调用`,
      tone: 'emerald',
    },
    {
      key: 'active',
      label: '活跃日占比',
      value: Math.min(100, activeRate),
      display: pct(activeRate),
      sub: `${summary.activeDays} / ${summary.spanDays} 天`,
      tone: 'violet',
    },
    {
      key: 'intensity',
      label: '日均强度',
      value: Math.min(100, intensity),
      display: pct(intensity),
      sub: `日均 ${formatCompact(avg)} / 峰值 ${formatCompact(peak)} token`,
      tone: 'amber',
    },
  ];
}

/** 综合活跃度评分：活跃日占比 40% + 工具成功率 30% + 缓存命中率 20% + 强度 10% */
export function activityScore(summary: StatsSummary, daily: DailyPoint[]): number {
  const tokenSeries = daily.map((p) => p.totalTokens);
  const peak = Math.max(0, ...tokenSeries);
  const avg = tokenSeries.length > 0 ? tokenSeries.reduce((a, b) => a + b, 0) / tokenSeries.length : 0;
  const activeRate = summary.spanDays > 0 ? summary.activeDays / summary.spanDays : 0;
  const toolOk = summary.toolCalls > 0 ? 1 - summary.toolFailureRate / 100 : 1;
  const cache = summary.cacheHitRate / 100;
  const intensity = peak > 0 ? avg / peak : 0;
  return Math.round(activeRate * 40 + toolOk * 30 + cache * 20 + intensity * 10);
}

// ===== 6. 趋势模型 + 洞察 =====

export function buildTrend(daily: DailyPoint[]): TrendModel {
  const values = daily.map((p) => p.totalTokens);
  const { slope, r2 } = linearRegression(values);
  const ma = movingAverage(values, 7);
  const movingAvgValue = ma.length > 0 ? ma[ma.length - 1] : 0;

  // 前后半段对比（至少各 2 天）
  let growthRate: number | null = null;
  if (values.length >= 4) {
    const mid = Math.floor(values.length / 2);
    const before = values.slice(0, mid);
    const after = values.slice(mid);
    const bAvg = before.reduce((a, b) => a + b, 0) / before.length;
    const aAvg = after.reduce((a, b) => a + b, 0) / after.length;
    if (bAvg > 0) growthRate = Math.round(((aAvg - bAvg) / bAvg) * 1000) / 10;
  }

  const direction: TrendModel['direction'] =
    Math.abs(slope) < 1 || r2 < 0.05 ? 'flat' : slope > 0 ? 'up' : 'down';

  return {
    slope: Math.round(slope * 10) / 10,
    r2: Math.round(r2 * 1000) / 1000,
    movingAvg: Math.round(movingAvgValue),
    growthRate,
    forecast: forecastSeries(daily, { horizon: 7 }),
    anomalies: detectAnomalies(daily),
    direction,
  };
}

/** 24 小时活跃度找峰值时段 */
export function peakHour(hourly: number[]): number | null {
  let best = -1;
  let bestV = 0;
  hourly.forEach((v, i) => {
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  });
  return best >= 0 ? best : null;
}

export function buildInsights(input: {
  summary: StatsSummary;
  daily: DailyPoint[];
  trend: TrendModel;
  models: ModelSlice[];
  tools: ToolSlice[];
  hourly: number[];
}): Insight[] {
  const { summary, trend, models, tools, hourly } = input;
  const out: Insight[] = [];

  // 1) 趋势
  if (summary.messages === 0) {
    out.push({
      level: 'info',
      title: '暂无历史数据',
      detail: '当前筛选范围内没有会话记录，切换时间范围或换个工作区后再看。',
    });
    return out;
  }

  if (trend.growthRate !== null) {
    const dir = trend.growthRate > 5 ? 'up' : trend.growthRate < -5 ? 'down' : 'flat';
    const dayAvg = Math.round(summary.totalTokens / Math.max(1, summary.spanDays));
    out.push({
      level: dir === 'up' ? 'warn' : dir === 'down' ? 'good' : 'info',
      title:
        dir === 'up'
          ? `用量上行：后半程较前半程增长 ${trend.growthRate}%`
          : dir === 'down'
            ? `用量回落：后半程较前半程下降 ${Math.abs(trend.growthRate)}%`
            : '用量平稳：前后半程基本持平',
      detail: `当前日均 ${formatCompact(dayAvg)} token，趋势斜率 ${trend.slope >= 0 ? '+' : ''}${trend.slope}/天（拟合优度 R²=${trend.r2.toFixed(2)}）。`,
      metric: `${trend.growthRate > 0 ? '+' : ''}${trend.growthRate}%`,
    });
  }

  // 2) 预测（外推收敛到 0 时也要给结论，否则用户会以为模型没跑）
  const totalForecast = trend.forecast.reduce((a, b) => a + b.tokens, 0);
  if (trend.forecast.length > 0 && totalForecast > 0) {
    const avgDaily = Math.round(totalForecast / trend.forecast.length);
    const last = trend.forecast[trend.forecast.length - 1];
    out.push({
      level: 'info',
      title: `未来 7 天预计消耗 ≈ ${formatCompact(totalForecast)} token`,
      detail: `模型按近 14 天线性趋势外推，日均约 ${formatCompact(avgDaily)} token；第 7 天区间 ${formatCompact(last.lower)}~${formatCompact(last.upper)}（R²=${trend.r2.toFixed(2)}，样本越小误差越大）。`,
      metric: `≈${formatCompact(totalForecast)}`,
    });
  } else if (trend.forecast.length > 0) {
    const activeDays = summary.activeDays;
    out.push({
      level: 'info',
      title: '未来 7 天预计消耗趋近 0（历史数据稀疏）',
      detail: `窗口内只有 ${activeDays} 天有使用记录，近期直线外推收敛到 0。积累更多使用记录后预测才有参考价值。`,
      metric: '≈0',
    });
  }

  // 3) 异常日
  if (trend.anomalies.length > 0) {
    const top = trend.anomalies[0];
    out.push({
      level: 'warn',
      title: `检测到 ${trend.anomalies.length} 个异常用量日`,
      detail: `峰值出现在 ${top.date}（${formatCompact(top.tokens)} token，偏离均值 ${top.z} 个标准差）。常见原因是长会话或多工具并行，可到历史记录里按该日期核对。`,
      metric: top.date,
    });
  }

  // 4) 模型集中度
  if (models.length > 0) {
    const top = models[0];
    const concentration = top.share;
    out.push({
      level: concentration >= 70 ? 'info' : 'good',
      title: `${top.model} 承担 ${concentration}% 的 token`,
      detail:
        models.length === 1
          ? '当前只用了一个模型；如需对比成本与效果，可在设置里补充第二套 API 配置并用 @模型名 指定。'
          : `共 ${models.length} 个模型参与，第二名 ${models[1].model} 占 ${models[1].share}%。${concentration >= 70 ? '依赖较集中，主力模型不可用时可考虑配置 fallback。' : '模型使用较为分散，成本与效果更可控。'}`,
      metric: pct(concentration),
    });
  }

  // 5) 工具健康度
  if (summary.toolCalls > 0) {
    const worst = tools.filter((t) => t.failures > 0).sort((a, b) => b.failures - a.failures)[0];
    if (summary.toolFailureRate >= 10) {
      out.push({
        level: 'warn',
        title: `工具失败率偏高：${pct(summary.toolFailureRate)}`,
        detail: worst
          ? `${worst.tool} 失败 ${worst.failures} 次（共调用 ${worst.count} 次），建议检查参数或路径权限。`
          : `共 ${summary.toolFailures} 次失败，建议检查参数或路径权限。`,
        metric: `${summary.toolFailures} 次`,
      });
    } else {
      out.push({
        level: 'good',
        title: `工具调用健康：成功率 ${pct(100 - summary.toolFailureRate)}`,
        detail: `共 ${summary.toolCalls} 次调用，失败 ${summary.toolFailures} 次。高频工具：${tools
          .slice(0, 3)
          .map((t) => `${t.tool}(${t.count})`)
          .join('、') || '无'}。`,
        metric: pct(100 - summary.toolFailureRate),
      });
    }
  }

  // 6) 缓存效率
  if (summary.promptTokens > 0) {
    out.push({
      level: summary.cacheHitRate < 20 ? 'info' : 'good',
      title: `输入 token 缓存命中 ${pct(summary.cacheHitRate)}`,
      detail:
        summary.cacheHitRate < 20
          ? `仅 ${formatCompact(summary.cachedTokens)} / ${formatCompact(summary.promptTokens)} 命中缓存，重复上下文较多时可开启上下文压缩减少重复输入。`
          : `节省约 ${formatCompact(summary.cachedTokens)} token 的重复输入成本。`,
      metric: pct(summary.cacheHitRate),
    });
  }

  // 7) 活跃时段
  const ph = peakHour(hourly);
  if (ph !== null) {
    out.push({
      level: 'info',
      title: `最活跃时段：${String(ph).padStart(2, '0')}:00 - ${String((ph + 1) % 24).padStart(2, '0')}:00`,
      detail: `该时段共 ${hourly[ph]} 条消息。连续深聊多时，注意会话上下文长度（可用 /summarize 压缩）。`,
    });
  }

  return out;
}

// ===== 7. 组装看板 =====

export function buildDashboard(
  sessions: SessionLike[],
  filter: StatsFilter = {},
  now: number = Date.now(),
): StatsDashboard {
  const scoped = filterSessions(sessions, filter, now);
  const daily = collectDaily(scoped, { range: filter.range, now });
  const summary = summarize(scoped, daily);
  const models = modelDistribution(scoped);
  const tools = toolDistribution(scoped);
  const hourly = hourlyActivity(scoped);
  const trend = buildTrend(daily);

  return {
    generatedAt: now,
    range: filter.range ?? '30d',
    summary,
    kpis: buildKpis(summary, daily),
    daily,
    trend,
    models,
    tools,
    hourly,
    insights: buildInsights({ summary, daily, trend, models, tools, hourly }),
    activityScore: activityScore(summary, daily),
  };
}
