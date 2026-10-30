import React, { useMemo, useRef, useState } from 'react';
import type { StatsDailyPoint, StatsForecastPoint } from '../../global';

/**
 * 用量趋势图（纯 SVG 手绘，零图表库依赖）。
 *
 * 三层信息：
 *   1. 面积+折线：每日真实 token 用量
 *   2. 虚线：7 日移动平均（把空白天/单日尖峰的抖动压掉，看趋势更准）
 *   3. 后半段虚线+带状：统计模型的未来 7 天预测及置信区间
 *
 * 说明：SVG 用 preserveAspectRatio="none" 横向铺满容器，因此所有几何图形都加了
 * vectorEffect="non-scaling-stroke" 保证线宽不被拉伸；文字与 hover 圆点改用 HTML 定位，
 * 避免被非等比缩放拉成椭圆/变形。
 */

const W = 1000;
const H = 260;
const PAD = { left: 8, right: 8, top: 16, bottom: 10 };

interface Props {
  daily: StatsDailyPoint[];
  forecast: StatsForecastPoint[];
  /** 图表高度（px） */
  height?: number;
}

interface HoverState {
  index: number;
  xPct: number;
  yPct: number;
}

function movingAverage(values: number[], window = 7): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(sum / Math.min(i + 1, window));
  }
  return out;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

const TrendChart: React.FC<Props> = ({ daily, forecast, height = 240 }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const geo = useMemo(() => {
    const actual = daily.map((p) => p.totalTokens);
    const n = actual.length;
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;

    const maxActual = Math.max(0, ...actual);
    const maxForecastMid = Math.max(0, ...forecast.map((f) => f.tokens));
    const maxBandUpper = Math.max(0, ...forecast.map((f) => f.upper));
    /**
     * Y 轴定标策略：区间带「不太夸张」时把上界也算进来（完整看到喇叭口），
     * 一旦上界超过基准的 1.6 倍（典型如历史逐日抖动很大，残差 σ 被放大），
     * 就只按真实用量定标并让 clipPath 截断区间带——否则真实曲线会被压成贴底的直线。
     */
    const dataMax = Math.max(maxActual, maxForecastMid);
    const scaleMax = maxBandUpper <= dataMax * 1.6 ? Math.max(dataMax, maxBandUpper) : dataMax;
    const maxY = Math.max(1, scaleMax) * 1.12;

    const xAt = (i: number, total: number) =>
      total <= 1 ? PAD.left + innerW / 2 : PAD.left + (i / (total - 1)) * innerW;
    const yAt = (v: number) => PAD.top + innerH - (Math.max(0, v) / maxY) * innerH;

    const totalPoints = n + forecast.length;
    const actualPts = actual.map((v, i) => [xAt(i, totalPoints), yAt(v)] as const);
    const forecastPts = forecast.map((f, i) => [xAt(n + i, totalPoints), yAt(f.tokens)] as const);
    const maPts = movingAverage(actual, 7).map((v, i) => [xAt(i, totalPoints), yAt(v)] as const);

    const toPath = (pts: readonly (readonly [number, number])[]) =>
      pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

    const areaPath =
      actualPts.length > 0
        ? `${toPath(actualPts)} L${actualPts[actualPts.length - 1][0].toFixed(2)},${(PAD.top + innerH).toFixed(2)} L${actualPts[0][0].toFixed(2)},${(PAD.top + innerH).toFixed(2)} Z`
        : '';

    // 置信带：上界从左到右 + 下界从右到左闭合成多边形
    const upper = forecast.map((f, i) => [xAt(n + i, totalPoints), yAt(f.upper)] as const);
    const lower = forecast.map((f, i) => [xAt(n + i, totalPoints), yAt(f.lower)] as const);
    const bandPath =
      upper.length > 0
        ? `${toPath(upper)} ${[...lower].reverse().map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`).join(' ')} Z`
        : '';

    // 预测线从左端点接上实际线末端，视觉上不断裂
    const forecastPath =
      forecastPts.length > 0 && actualPts.length > 0
        ? toPath([actualPts[actualPts.length - 1], ...forecastPts])
        : '';

    const gridValues = [0, 0.25, 0.5, 0.75, 1].map((r) => ({
      y: PAD.top + innerH - r * innerH,
      value: Math.round(maxY * r),
    }));

    return {
      actualPts,
      maPts,
      forecastPts,
      areaPath,
      bandPath,
      bandUpper: upper,
      bandLower: lower,
      forecastPath,
      toPath,
      gridValues,
      totalPoints,
      xAt,
      yAt,
      maxY,
      innerH,
    };
  }, [daily, forecast]);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el || geo.totalPoints === 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const innerWRatio = (W - PAD.left - PAD.right) / W;
    const rel = Math.max(0, Math.min(1, (ratio - PAD.left / W) / innerWRatio));
    const index = Math.round(rel * (geo.totalPoints - 1));
    const xAbs = geo.xAt(index, geo.totalPoints);
    const isForecast = index >= daily.length;
    const value = isForecast ? forecast[index - daily.length]?.tokens ?? 0 : daily[index]?.totalTokens ?? 0;
    const yAbs = geo.yAt(value);
    setHover({ index, xPct: (xAbs / W) * 100, yPct: (yAbs / H) * 100 });
  };

  if (geo.totalPoints === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
        该时间范围内没有用量数据
      </div>
    );
  }

  const hoverIsForecast = hover ? hover.index >= daily.length : false;
  const hoverPoint = hover ? (hoverIsForecast ? forecast[hover.index - daily.length] : null) : null;
  const hoverDay = hover && !hoverIsForecast ? daily[hover.index] : null;

  return (
    <div className="flex flex-col gap-1.5">
      {/* 图例 */}
      <div className="flex items-center gap-4 text-[10.5px] text-muted-foreground px-0.5">
        <span className="flex items-center gap-1">
          <span className="w-3 h-0.5 rounded bg-violet-400" />
          每日 token
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-0.5 rounded bg-cyan-300/80" />
          7 日均线
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-0.5 rounded bg-amber-300/80" style={{ backgroundImage: 'repeating-linear-gradient(90deg,#fcd34d 0 4px,transparent 4px 8px)' }} />
          未来 7 天预测
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative select-none"
        style={{ height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-full block overflow-visible"
          role="img"
          aria-label="每日 token 用量趋势与未来预测"
        >
          <defs>
            <linearGradient id="trend-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a855f7" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#a855f7" stopOpacity="0.02" />
            </linearGradient>
            {/* 绘图区裁切：置信区间上界超出坐标范围时在顶部截断，而不是溢出画布 */}
            <clipPath id="trend-clip">
              <rect x={0} y={PAD.top} width={W} height={geo.innerH} />
            </clipPath>
          </defs>

          {/* 横向网格 + Y 轴刻度 */}
          {geo.gridValues.map((g) => (
            <g key={g.y}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={g.y}
                y2={g.y}
                stroke="currentColor"
                className="text-border/40"
                strokeWidth={1}
                strokeDasharray="3 5"
                vectorEffect="non-scaling-stroke"
              />
              <text x={PAD.left + 2} y={g.y - 3} className="fill-muted-foreground" style={{ fontSize: 9 }}>
                {compact(g.value)}
              </text>
            </g>
          ))}

          {/* 实际面积 + 折线 */}
          {geo.areaPath && <path d={geo.areaPath} fill="url(#trend-area)" />}
          <path
            d={geo.toPath(geo.actualPts)}
            fill="none"
            stroke="#a855f7"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* 7 日均线 */}
          <path
            d={geo.toPath(geo.maPts)}
            fill="none"
            stroke="#67e8f9"
            strokeOpacity={0.75}
            strokeWidth={1.4}
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
          />

          {/* 预测置信带 + 预测线（裁切到绘图区，避免上界溢出） */}
          <g clipPath="url(#trend-clip)">
            {geo.bandPath && (
              <>
                <path d={geo.bandPath} fill="#fbbf24" fillOpacity={0.09} stroke="none" />
                {/* 区间上下边界补一条细虚线，让「带」在深色背景上更易辨识 */}
                <path
                  d={geo.toPath(geo.bandUpper)}
                  fill="none"
                  stroke="#fbbf24"
                  strokeOpacity={0.3}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={geo.toPath(geo.bandLower)}
                  fill="none"
                  stroke="#fbbf24"
                  strokeOpacity={0.3}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
            {geo.forecastPath && (
              <path
                d={geo.forecastPath}
                fill="none"
                stroke="#fbbf24"
                strokeWidth={1.8}
                strokeDasharray="6 5"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>

          {/* 今天与预测的分界 */}
          {forecast.length > 0 && daily.length > 0 && (
            <line
              x1={geo.xAt(daily.length - 1, geo.totalPoints)}
              x2={geo.xAt(daily.length - 1, geo.totalPoints)}
              y1={PAD.top}
              y2={PAD.top + geo.innerH}
              stroke="currentColor"
              className="text-amber-400/40"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* hover 竖线 */}
          {hover && (
            <line
              x1={(hover.xPct / 100) * W}
              x2={(hover.xPct / 100) * W}
              y1={PAD.top}
              y2={PAD.top + geo.innerH}
              stroke="currentColor"
              className="text-foreground/25"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {/* hover 圆点（用 HTML 画，避免非等比缩放变形） */}
        {hover && (
          <span
            className={`absolute w-2 h-2 rounded-full ring-2 ring-background -translate-x-1/2 -translate-y-1/2 ${
              hoverIsForecast ? 'bg-amber-300' : 'bg-violet-400'
            }`}
            style={{ left: `${hover.xPct}%`, top: `${hover.yPct}%` }}
          />
        )}

        {/* hover 提示卡 */}
        {hover && (
          <div
            className="pointer-events-none absolute z-10 min-w-[132px] rounded-lg border border-border bg-popover/95 backdrop-blur px-2.5 py-2 shadow-xl"
            style={{
              left: `calc(${hover.xPct}% + 10px)`,
              top: 4,
              transform: hover.xPct > 70 ? 'translateX(-110%)' : undefined,
            }}
          >
            {hoverIsForecast && hoverPoint ? (
              <>
                <div className="text-[11px] font-medium text-amber-300">{hoverPoint.date}（预测）</div>
                <div className="mt-1 text-[11px] text-foreground/90">
                  预计 <span className="font-semibold tabular-nums">{compact(hoverPoint.tokens)}</span> token
                </div>
                <div className="text-[10.5px] text-muted-foreground tabular-nums">
                  区间 {compact(hoverPoint.lower)} ~ {compact(hoverPoint.upper)}
                </div>
              </>
            ) : hoverDay ? (
              <>
                <div className="text-[11px] font-medium text-foreground/90">{hoverDay.date}</div>
                <div className="mt-1 text-[11px] text-foreground/90">
                  <span className="font-semibold tabular-nums text-violet-300">{compact(hoverDay.totalTokens)}</span> token
                </div>
                <div className="text-[10.5px] text-muted-foreground">
                  {hoverDay.messages} 条消息 · {hoverDay.sessions} 个会话 · {hoverDay.toolCalls} 次工具
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* X 轴：起止与中间刻度（HTML 渲染，清晰不模糊） */}
      <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
        <span>{daily[0]?.date.slice(5) ?? ''}</span>
        <span>{daily[Math.floor(daily.length / 2)]?.date.slice(5) ?? ''}</span>
        <span>{forecast.length > 0 ? `${forecast[forecast.length - 1].date.slice(5)}（预测）` : daily[daily.length - 1]?.date.slice(5) ?? ''}</span>
      </div>
    </div>
  );
};

export default TrendChart;
