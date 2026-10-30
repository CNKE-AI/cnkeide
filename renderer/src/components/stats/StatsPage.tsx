import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Clock3,
  Cpu,
  MessageSquare,
  Minus,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { useStatsStore } from '../../store/statsStore';
import { useChatStore } from '../../store/chatStore';
import { toast } from '../../utils/toast';
import RingGauge from './RingGauge';
import TrendChart from './TrendChart';
import DistributionBars from './DistributionBars';
import InsightList from './InsightList';
import HistoryTable from './HistoryTable';
import type { BarItem } from './DistributionBars';
import type { StatsRange } from '../../global';

/**
 * 历史统计看板（整页浮层）。
 *
 * 布局遵循「先结论后明细」的阅读顺序：
 *   1. 顶部工具栏：时间范围 / 工作区 / 关键词 / 刷新（所有筛选条件集中在一处）
 *   2. 核心指标：4 个圆环（缓存命中率、工具成功率、活跃日占比、日均强度）+ 综合活跃度评分
 *   3. 用量趋势：真实用量 + 7 日移动平均 + 统计模型的 7 天预测与置信区间
 *   4. 结构分布：模型 token 占比、工具调用频率、24 小时时段分布
 *   5. 模型结论：由 StatsModel 生成的文字洞察（增长、异常、集中度、健康度…）
 *   6. 历史明细：可排序、可翻页的会话表，点击任意一行回到该会话继续
 *
 * 所有聚合都在主进程完成（stats:dashboard / stats:sessions），
 * 此处只做展示与筛选条件驱动，避免上千条会话在渲染层反复遍历。
 */

const RANGES: { key: StatsRange; label: string }[] = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: '90d', label: '近 90 天' },
  { key: 'all', label: '全部' },
];

function compact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtClock(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 通用卡片容器：标题行 + 右上角附加信息 + 内容区 */
const Card: React.FC<{
  title: string;
  icon?: React.ReactNode;
  extra?: React.ReactNode;
  className?: string;
  bodyClass?: string;
  children: React.ReactNode;
}> = ({ title, icon, extra, className = '', bodyClass = '', children }) => (
  <section
    className={`flex flex-col rounded-xl border border-border/70 bg-card/40 backdrop-blur-sm overflow-hidden ${className}`}
  >
    <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/60 bg-secondary/20">
      <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-foreground/85">
        {icon}
        {title}
      </span>
      {extra && <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">{extra}</span>}
    </header>
    <div className={`flex-1 min-h-0 px-3 py-3 ${bodyClass}`}>{children}</div>
  </section>
);

/** 24 小时时段分布：纯 div 柱状，命中区带 tooltip */
const HourlyBars: React.FC<{ hourly: number[] }> = ({ hourly }) => {
  const max = Math.max(1, ...hourly);
  const peak = hourly.indexOf(Math.max(...hourly));
  if (hourly.every((v) => v === 0)) {
    return <div className="py-8 text-center text-xs text-muted-foreground">暂无调用记录</div>;
  }
  return (
    <div>
      <div className="flex items-end gap-[3px] h-[86px]">
        {hourly.map((v, h) => (
          <div
            key={h}
            className="group relative flex-1 flex items-end h-full"
            title={`${String(h).padStart(2, '0')}:00 – ${String(h).padStart(2, '0')}:59 · ${v} 次工具调用`}
          >
            <div
              className={`w-full rounded-sm transition-all duration-500 ${
                h === peak
                  ? 'bg-gradient-to-t from-amber-500/80 to-yellow-300/90'
                  : 'bg-gradient-to-t from-violet-600/70 to-fuchsia-400/70 group-hover:from-violet-500 group-hover:to-fuchsia-300'
              }`}
              style={{ height: v === 0 ? 0 : `${Math.max(4, (v / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[9.5px] text-muted-foreground/70 tabular-nums">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
      <div className="mt-1.5 text-[10px] text-muted-foreground">
        高峰时段 <span className="text-amber-300 tabular-nums">{String(peak).padStart(2, '0')}:00</span>
        <span className="mx-1 opacity-50">·</span>
        峰值 <span className="tabular-nums text-foreground/70">{max}</span> 次
      </div>
    </div>
  );
};

interface Props {
  /** 关闭看板（由布局层决定回到哪个页面，页面本身不关心全局导航状态） */
  onClose: () => void;
}

const StatsPage: React.FC<Props> = ({ onClose }) => {
  const {
    range,
    workspaceId,
    keyword,
    sortBy,
    dashboard,
    pageData,
    loading,
    error,
    refreshedAt,
    setRange,
    setWorkspace,
    setKeyword,
    setSortBy,
    setPage,
    refresh,
  } = useStatsStore();

  /** 搜索框本地态：输入即时反馈，300ms 后才落到 store 触发重算，避免每敲一个字都全量聚合 */
  const [kwInput, setKwInput] = useState(keyword);

  /** 导出：菜单展开态 + 进行中标记（保存框可能停留很久，期间要禁用按钮防重复点击） */
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  /**
   * 导出当前筛选结果。
   *
   * 传的是 store 里的筛选条件而不是页面上看到的分页数据 —— 用户点"导出"期待的是
   * 这一整套筛选结果，只有第一页数据会让人误以为丢数据。
   */
  const handleExport = async (format: 'csv' | 'markdown') => {
    setExportOpen(false);
    if (exporting) return;
    setExporting(true);
    try {
      const res = await window.cnke.stats.export({ range, workspaceId, keyword, sortBy }, format);
      if (!res.success) throw new Error(res.error || '导出失败');
      // 用户在保存框点了取消：这不是错误，不必弹提示打扰
      if (res.data?.canceled) return;
      const rows = res.data?.rows ?? 0;
      toast.success(
        format === 'csv'
          ? `已导出 ${rows} 条明细（CSV）`
          : `已导出统计报告（Markdown，含 ${rows} 条明细）`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  // 打开看板即拉一次数据（store 是全局单例，重复打开会命中上次结果并随后刷新）
  useEffect(() => {
    void useStatsStore.getState().refresh();
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 搜索防抖
  useEffect(() => {
    if (kwInput === keyword) return;
    const timer = setTimeout(() => setKeyword(kwInput), 300);
    return () => clearTimeout(timer);
  }, [kwInput, keyword, setKeyword]);

  /** 从统计明细跳回对话：恢复该会话后自动关闭看板，形成「统计 → 明细 → 原文」闭环 */
  const handleOpenSession = useCallback(
    async (sessionId: string, wsId: string) => {
      try {
        await useChatStore.getState().switchSession(wsId, sessionId);
      } finally {
        onClose();
      }
    },
    [onClose],
  );

  const summary = dashboard?.summary;
  const trend = dashboard?.trend;

  const modelBars: BarItem[] = useMemo(
    () =>
      (dashboard?.models ?? []).map((m, i) => ({
        label: m.model || '未知模型',
        share: m.share,
        display: `${compact(m.tokens)} token`,
        sub: `${m.messages} 条消息`,
        tone: (['violet', 'cyan', 'amber', 'emerald', 'rose'] as const)[i % 5],
      })),
    [dashboard?.models],
  );

  const toolBars: BarItem[] = useMemo(
    () =>
      (dashboard?.tools ?? []).map((t, i) => ({
        label: t.tool,
        share: t.share,
        display: `${t.count} 次`,
        sub: t.failures > 0 ? `${t.failures} 次失败` : undefined,
        tone: t.failures > 0 ? 'amber' : (['cyan', 'violet', 'emerald', 'rose'] as const)[i % 4],
      })),
    [dashboard?.tools],
  );

  const forecastTotal = useMemo(
    () => (trend?.forecast ?? []).reduce((acc, p) => acc + p.tokens, 0),
    [trend?.forecast],
  );
  // 有效样本不足时模型不给预测，此时不画预测图例，改为说明原因，避免"图例在、线不见"
  const hasForecast = (trend?.forecast.length ?? 0) > 0;

  const isEmpty = !loading && summary != null && summary.sessions === 0;

  // 选择范围比实际数据跨度更宽时（例如只有 45 天历史却选 90 天），前半段全为 0，
  // 模型给不出环比增长率。此时不能沿用回归方向箭头，否则「上升箭头 + 缺少对比基期」自相矛盾。
  const hasGrowth = trend?.growthRate != null;
  const DirectionIcon = !hasGrowth
    ? Minus
    : trend?.direction === 'up'
      ? TrendingUp
      : trend?.direction === 'down'
        ? TrendingDown
        : Minus;
  const directionTone = !hasGrowth
    ? 'text-muted-foreground'
    : trend?.direction === 'up'
      ? 'text-emerald-300'
      : trend?.direction === 'down'
        ? 'text-amber-300'
        : 'text-muted-foreground';

  return (
    /*
     * 必须落在标题栏下方（父容器 relative + absolute inset-0），不能用 fixed inset-0：
     * 标题栏高 38.5px 且是 WebkitAppRegion: 'drag'，拖拽区优先级高于普通命中测试，
     * 覆盖上去会让本页顶部工具栏（时间范围 / 刷新 / 关闭）全部点不动。
     */
    <div className="absolute inset-0 z-30 flex flex-col bg-background text-foreground">
      {/* ===== 顶部工具栏 ===== */}
      <header className="shrink-0 border-b border-border bg-secondary/30 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3 px-4 h-11">
          <div className="flex items-center gap-2 min-w-0">
            <BarChart3 className="w-4 h-4 text-violet-400 shrink-0" />
            <span className="text-sm font-semibold brand-gradient whitespace-nowrap">历史统计</span>
            <span className="text-[10.5px] text-muted-foreground truncate hidden md:inline">
              基于本地历史会话的用量分析 · 数据不出本机
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* 时间范围 */}
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setRange(r.key)}
                  className={`px-2.5 py-1 text-[11px] transition-colors ${
                    range === r.key
                      ? 'bg-violet-500/25 text-violet-200'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
              title="重新计算统计数据"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </button>

            {/* 导出：CSV 拿去二次分析，Markdown 直接贴周报 */}
            <div className="relative">
              {exportOpen && (
                <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
              )}
              <button
                type="button"
                onClick={() => setExportOpen((v) => !v)}
                disabled={exporting || !dashboard || dashboard.summary.messages === 0}
                className="relative z-50 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                title="导出当前筛选范围的数据"
              >
                <Download className={`w-3 h-3 ${exporting ? 'animate-pulse' : ''}`} />
                {exporting ? '导出中…' : '导出'}
              </button>

              {exportOpen && (
                <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                  <button
                    type="button"
                    onClick={() => void handleExport('csv')}
                    className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-muted/70"
                  >
                    <FileSpreadsheet className="mt-0.5 w-3.5 h-3.5 shrink-0 text-emerald-400" />
                    <span className="min-w-0">
                      <span className="block text-[11.5px] text-foreground/90">CSV 明细</span>
                      <span className="block text-[10px] text-muted-foreground">
                        每条会话一行，含 token / 工具 / 模型
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleExport('markdown')}
                    className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-muted/70"
                  >
                    <FileText className="mt-0.5 w-3.5 h-3.5 shrink-0 text-violet-400" />
                    <span className="min-w-0">
                      <span className="block text-[11.5px] text-foreground/90">Markdown 报告</span>
                      <span className="block text-[10px] text-muted-foreground">
                        概览 / 趋势 / 分布 / 结论，可直接贴周报
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title="关闭统计看板 (Esc)"
              aria-label="关闭统计看板"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 第二行：筛选条件 */}
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            工作区
            <select
              value={workspaceId}
              onChange={(e) => setWorkspace(e.target.value)}
              className="rounded-md border border-border bg-background/60 px-2 py-1 text-[11px] text-foreground/90 outline-none focus:border-violet-500/60 max-w-[220px]"
            >
              <option value="all">全部工作区</option>
              {(pageData?.workspaces ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}（{w.sessions}）
                </option>
              ))}
            </select>
          </label>

          <div className="relative flex items-center">
            <Search className="absolute left-2 w-3 h-3 text-muted-foreground pointer-events-none" />
            <input
              value={kwInput}
              onChange={(e) => setKwInput(e.target.value)}
              placeholder="搜索会话标题 / 内容 / 模型"
              className="w-[220px] rounded-md border border-border bg-background/60 pl-7 pr-6 py-1 text-[11px] text-foreground/90 placeholder:text-muted-foreground/70 outline-none focus:border-violet-500/60"
            />
            {kwInput && (
              <button
                type="button"
                onClick={() => setKwInput('')}
                className="absolute right-1.5 text-muted-foreground hover:text-foreground"
                title="清空"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/80">
            {loading ? (
              <>
                <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                正在计算…
              </>
            ) : (
              <>
                <Clock3 className="w-2.5 h-2.5" />
                数据截至 {refreshedAt ? fmtClock(refreshedAt) : '—'}
              </>
            )}
          </span>
        </div>
      </header>

      {/* ===== 内容区 ===== */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-300">
            统计模型计算失败：{error}
          </div>
        )}

        {isEmpty ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/40 py-16 text-center">
            <BarChart3 className="w-8 h-8 text-muted-foreground/50" />
            <div className="text-sm text-foreground/80">当前筛选范围内还没有历史记录</div>
            <p className="max-w-md text-[11.5px] leading-relaxed text-muted-foreground">
              先回到对话面板和 AI 交流几轮，再看板就会自动统计出趋势、指标与结论。
              也可以放宽时间范围或清空搜索词。
            </p>
          </div>
        ) : (
          <>
            {/* 核心指标 + 综合活跃度 */}
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-3">
              <Card
                title="核心指标"
                icon={<Zap className="w-3.5 h-3.5 text-violet-400" />}
                className="xl:col-span-9"
                extra={<span>共 {summary?.sessions ?? 0} 个会话 · 跨 {summary?.spanDays ?? 0} 天</span>}
              >
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
                  {(dashboard?.kpis ?? []).map((kpi) => (
                    <RingGauge key={kpi.key} kpi={kpi} />
                  ))}
                </div>

                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-border/60 pt-2.5">
                  {[
                    { label: '消息总数', value: String(summary?.messages ?? 0) },
                    { label: 'Token 总量', value: compact(summary?.totalTokens ?? 0) },
                    { label: '平均每会话', value: compact(summary?.avgTokensPerSession ?? 0) },
                    {
                      label: '峰值日',
                      value: summary?.peakDate
                        ? `${summary.peakDate.slice(5)} · ${compact(summary.peakTokens)}`
                        : '—',
                    },
                  ].map((item) => (
                    <div key={item.label} className="rounded-lg bg-secondary/25 px-2.5 py-1.5">
                      <div className="text-[10px] text-muted-foreground">{item.label}</div>
                      <div className="text-[13px] font-medium text-foreground/90 tabular-nums truncate">
                        {item.value}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card
                title="综合活跃度"
                icon={<Cpu className="w-3.5 h-3.5 text-cyan-400" />}
                className="xl:col-span-3"
              >
                <div className="flex flex-col h-full justify-center gap-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-3xl font-semibold text-violet-300 tabular-nums">
                      {dashboard?.activityScore ?? 0}
                    </span>
                    <span className="text-[11px] text-muted-foreground">/ 100</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-border/60 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-400 transition-[width] duration-500"
                      style={{ width: `${Math.max(2, Math.min(100, dashboard?.activityScore ?? 0))}%` }}
                    />
                  </div>
                  <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                    活跃日 40% + 工具成功率 30% + 缓存 20% + 强度 10%
                  </p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <span className="rounded border border-border/70 bg-secondary/30 px-1.5 py-0.5 text-[10px] text-foreground/75">
                      活跃 {summary?.activeDays ?? 0}/{summary?.spanDays ?? 0} 天
                    </span>
                    <span className="rounded border border-border/70 bg-secondary/30 px-1.5 py-0.5 text-[10px] text-foreground/75">
                      缓存 {(summary?.cacheHitRate ?? 0).toFixed(0)}%
                    </span>
                  </div>
                </div>
              </Card>
            </div>

            {/* 用量趋势 */}
            <Card
              title="用量趋势与预测"
              icon={<TrendingUp className="w-3.5 h-3.5 text-emerald-400" />}
              extra={
                <>
                  {trend && (
                    <span className={`inline-flex items-center gap-0.5 ${directionTone}`}>
                      <DirectionIcon className="w-3 h-3" />
                      {trend.growthRate == null
                        ? '前半程无数据，暂无环比'
                        : `${trend.growthRate > 0 ? '+' : ''}${trend.growthRate.toFixed(1)}%`}
                    </span>
                  )}
                  {trend && <span className="opacity-50">·</span>}
                  {trend && <span>移动均值 {compact(trend.movingAvg)}</span>}
                  {trend && <span className="opacity-50">·</span>}
                  {trend && <span>R² {trend.r2.toFixed(2)}</span>}
                </>
              }
            >
              <TrendChart daily={dashboard?.daily ?? []} forecast={trend?.forecast ?? []} height={230} />

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-[10.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-[2px] rounded bg-violet-400" />
                  每日 token 用量
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-[2px] rounded bg-cyan-400" />
                  7 日移动平均
                </span>
                {hasForecast ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2.5 h-[2px] rounded bg-amber-400" />
                    未来 7 天预测（含 95% 置信区间）
                  </span>
                ) : (
                  <span className="text-muted-foreground/70">有效使用天数不足，暂不给出预测</span>
                )}
                {hasForecast && (
                  <span className="ml-auto text-foreground/70">
                    预测合计 <span className="tabular-nums text-amber-300">{compact(forecastTotal)}</span> token
                  </span>
                )}
                {trend && trend.anomalies.length > 0 && (
                  <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">
                    {trend.anomalies.length} 个异常日
                  </span>
                )}
              </div>
            </Card>

            {/* 结构分布 */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <Card
                title="模型用量分布"
                icon={<Cpu className="w-3.5 h-3.5 text-violet-400" />}
                extra={<span>按 token 占比</span>}
              >
                <DistributionBars items={modelBars} emptyText="暂无模型用量数据" limit={6} />
              </Card>

              <Card
                title="工具使用频率"
                icon={<Wrench className="w-3.5 h-3.5 text-emerald-400" />}
                extra={<span>失败率 {(summary?.toolFailureRate ?? 0).toFixed(1)}%</span>}
              >
                <DistributionBars items={toolBars} emptyText="暂无工具调用记录" limit={6} />
              </Card>

              <Card
                title="时段活跃分布"
                icon={<Clock3 className="w-3.5 h-3.5 text-amber-400" />}
                extra={<span>0-23 时</span>}
              >
                <HourlyBars hourly={dashboard?.hourly ?? new Array(24).fill(0)} />
              </Card>
            </div>

            {/* 模型结论 */}
            <Card
              title="统计模型结论"
              icon={<MessageSquare className="w-3.5 h-3.5 text-violet-400" />}
              extra={<span>规则 + 回归/移动平均/异常检测</span>}
            >
              <InsightList insights={dashboard?.insights ?? []} />
            </Card>

            {/* 历史明细 */}
            <Card
              title="历史记录明细"
              icon={<BarChart3 className="w-3.5 h-3.5 text-cyan-400" />}
              extra={<span>点击任意一行可回到该会话继续</span>}
              bodyClass="pb-2.5"
            >
              <HistoryTable
                pageData={pageData}
                sortBy={sortBy}
                loading={loading}
                onSort={(s) => setSortBy(s)}
                onPageChange={(p) => setPage(p)}
                onOpen={(sid, wsId) => {
                  void handleOpenSession(sid, wsId);
                }}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
};

export default StatsPage;
