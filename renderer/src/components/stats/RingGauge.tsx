import React from 'react';
import type { StatsRingKpi } from '../../global';

/**
 * 圆环指标（纯 SVG，无图表库依赖）。
 *
 * 结构对齐参考稿：灰色轨道 + 彩色进度弧 + 中心大字 + 下方标签/说明。
 * value 变化时用 stroke-dashoffset 的 transition 做平滑动画，
 * 切换时间范围时能看到环"涨落"，比直接跳变更容易感知趋势。
 */

const TONE_STYLES: Record<
  StatsRingKpi['tone'],
  { from: string; to: string; text: string; glow: string }
> = {
  violet: { from: '#c084fc', to: '#8b5cf6', text: 'text-violet-300', glow: 'rgba(139,92,246,0.35)' },
  amber: { from: '#fcd34d', to: '#f59e0b', text: 'text-amber-300', glow: 'rgba(245,158,11,0.35)' },
  cyan: { from: '#67e8f9', to: '#0ea5e9', text: 'text-cyan-300', glow: 'rgba(14,165,233,0.35)' },
  emerald: { from: '#6ee7b7', to: '#10b981', text: 'text-emerald-300', glow: 'rgba(16,185,129,0.35)' },
};

const SIZE = 96;
const STROKE = 7;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

interface Props {
  kpi: StatsRingKpi;
}

const RingGauge: React.FC<Props> = ({ kpi }) => {
  const tone = TONE_STYLES[kpi.tone] ?? TONE_STYLES.violet;
  const ratio = Math.max(0, Math.min(100, kpi.value)) / 100;
  const offset = CIRCUMFERENCE * (1 - ratio);
  const gradientId = `ring-${kpi.key}`;

  return (
    <div className="flex flex-col items-center gap-2 px-2 py-3" title={kpi.sub}>
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="block">
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={tone.from} />
              <stop offset="100%" stopColor={tone.to} />
            </linearGradient>
          </defs>
          {/* 轨道 */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke="currentColor"
            className="text-border/70"
            strokeWidth={STROKE}
          />
          {/* 进度弧 */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1)', filter: `drop-shadow(0 0 5px ${tone.glow})` }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`text-xl font-semibold tabular-nums ${tone.text}`}>{kpi.display}</span>
        </div>
      </div>
      <div className="text-[12px] font-medium text-foreground/85 text-center leading-tight">{kpi.label}</div>
      <div className="text-[10.5px] text-muted-foreground text-center leading-tight max-w-[132px]">{kpi.sub}</div>
    </div>
  );
};

export default RingGauge;
