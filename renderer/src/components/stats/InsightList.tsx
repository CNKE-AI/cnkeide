import React from 'react';
import { AlertTriangle, CheckCircle2, Info, Sparkles } from 'lucide-react';
import type { StatsInsight } from '../../global';

/**
 * 统计模型的结论列表。
 *
 * 每条洞察都由主进程的 StatsModel 生成（趋势/预测/异常/集中度/工具健康/缓存/时段），
 * 这里只负责把 level 翻译成颜色与图标，保证「图表 → 结论」的阅读顺序：
 * 先看圆环与趋势，再看结论确认模型怎么解读这些数字。
 */

const LEVEL_STYLE: Record<
  StatsInsight['level'],
  { icon: React.ReactNode; wrap: string; title: string; badge: string }
> = {
  good: {
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    wrap: 'border-emerald-500/30 bg-emerald-500/[0.07]',
    title: 'text-emerald-300',
    badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  },
  warn: {
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
    wrap: 'border-amber-500/30 bg-amber-500/[0.07]',
    title: 'text-amber-300',
    badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  },
  info: {
    icon: <Info className="w-3.5 h-3.5" />,
    wrap: 'border-violet-500/30 bg-violet-500/[0.07]',
    title: 'text-violet-300',
    badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  },
};

interface Props {
  insights: StatsInsight[];
}

const InsightList: React.FC<Props> = ({ insights }) => {
  if (!insights || insights.length === 0) {
    return <div className="py-8 text-center text-xs text-muted-foreground">暂无可解读的结论</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {insights.map((insight, i) => {
        const style = LEVEL_STYLE[insight.level] ?? LEVEL_STYLE.info;
        return (
          <div
            key={`${insight.title}-${i}`}
            className={`flex gap-2.5 rounded-lg border px-3 py-2.5 ${style.wrap}`}
          >
            <div className={`mt-0.5 shrink-0 ${style.title}`}>{style.icon}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <span className={`text-[12px] font-medium leading-snug ${style.title}`}>{insight.title}</span>
                {insight.metric && (
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] tabular-nums ${style.badge}`}>
                    {insight.metric}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{insight.detail}</p>
            </div>
          </div>
        );
      })}
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/70 px-0.5">
        <Sparkles className="w-3 h-3" />
        结论由本地统计模型基于历史会话实时计算，数据不出本机
      </div>
    </div>
  );
};

export default InsightList;
