import React from 'react';

/**
 * 横向占比条：用于「模型分布」「工具使用频率」。
 *
 * 用 div + width% 而不是 SVG —— 条数少、需要文字省略号与 hover 提示，
 * HTML 布局比 SVG 更好控制，也天然跟随主题色。
 */

export interface BarItem {
  label: string;
  /** 0-100 */
  share: number;
  /** 右侧主数值，如 "6.0k token" */
  display: string;
  /** 次要说明，如 "2 次失败" */
  sub?: string;
  tone?: 'violet' | 'cyan' | 'amber' | 'emerald' | 'rose';
}

const TONE_BG: Record<NonNullable<BarItem['tone']>, string> = {
  violet: 'bg-gradient-to-r from-violet-500/80 to-fuchsia-400/80',
  cyan: 'bg-gradient-to-r from-cyan-500/80 to-sky-400/80',
  amber: 'bg-gradient-to-r from-amber-500/80 to-yellow-400/80',
  emerald: 'bg-gradient-to-r from-emerald-500/80 to-teal-400/80',
  rose: 'bg-gradient-to-r from-rose-500/80 to-pink-400/80',
};

interface Props {
  items: BarItem[];
  emptyText?: string;
  /** 最多显示几条，其余折叠成"其他" */
  limit?: number;
}

const DistributionBars: React.FC<Props> = ({ items, emptyText = '暂无数据', limit = 6 }) => {
  if (!items || items.length === 0) {
    return <div className="py-8 text-center text-xs text-muted-foreground">{emptyText}</div>;
  }

  const shown = items.slice(0, limit);
  const rest = items.slice(limit);
  const merged: BarItem[] =
    rest.length > 0
      ? [
          ...shown,
          {
            label: `其他 ${rest.length} 项`,
            share: Math.max(0, 100 - shown.reduce((a, b) => a + b.share, 0)),
            display: '',
            tone: 'violet',
          },
        ]
      : shown;

  return (
    <div className="flex flex-col gap-2.5">
      {merged.map((item, i) => (
        <div key={`${item.label}-${i}`} className="group" title={item.sub ? `${item.label} · ${item.sub}` : item.label}>
          <div className="flex items-center justify-between gap-2 text-[11.5px] mb-1">
            <span className="truncate text-foreground/85 max-w-[58%]">{item.label}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {item.display || `${Math.round(item.share * 10) / 10}%`}
              {item.display && (
                <span className="ml-1.5 text-[10.5px] opacity-70">{Math.round(item.share * 10) / 10}%</span>
              )}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-border/50 overflow-hidden">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ease-out ${TONE_BG[item.tone ?? 'violet']}`}
              style={{ width: `${Math.max(1.5, Math.min(100, item.share))}%` }}
            />
          </div>
          {item.sub && <div className="mt-0.5 text-[10px] text-muted-foreground/80 truncate">{item.sub}</div>}
        </div>
      ))}
    </div>
  );
};

export default DistributionBars;
