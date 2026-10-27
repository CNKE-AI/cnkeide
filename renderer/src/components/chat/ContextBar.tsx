import React from 'react';
import { useUiStore } from '../../store/uiStore';
import { ChevronDown, ChevronRight, Gauge } from 'lucide-react';

/** 上下文占用进度条：实时显示当前会话的 token 占用比例 */
const ContextBar: React.FC = () => {
  const { contextUsage, contextExpanded, setContextExpanded } = useUiStore();

  if (!contextUsage) return null;

  const pct = Math.round(contextUsage.ratio * 100);
  const color =
    contextUsage.level === 'critical'
      ? 'bg-rose-500'
      : contextUsage.level === 'warning'
        ? 'bg-amber-500'
        : 'bg-emerald-500';
  const textColor =
    contextUsage.level === 'critical'
      ? 'text-rose-400'
      : contextUsage.level === 'warning'
        ? 'text-amber-400'
        : 'text-emerald-400';

  return (
    <div className="@container px-4 py-2 border-b border-border/70 bg-secondary/10">
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => setContextExpanded(!contextExpanded)}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="上下文占用详情"
        >
          {contextExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Gauge className="w-3 h-3" />
          <span>上下文</span>
        </button>
        <div className="flex-1 min-w-[32px] h-1.5 bg-secondary rounded-full overflow-hidden">
          <div
            className={`h-full ${color} transition-all duration-300 rounded-full`}
            style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
          />
        </div>
        {/* 窄栏（可拖到 220px）下完整 token 数字会把进度条挤没：容器查询决定是否显示明细 */}
        <span
          className={`text-[11px] tabular-nums font-medium shrink-0 ${textColor}`}
          title={`${contextUsage.estimatedTokens.toLocaleString()} / ${contextUsage.maxContextTokens.toLocaleString()} tokens`}
        >
          <span className="hidden @[250px]:inline">
            {contextUsage.estimatedTokens.toLocaleString()} / {contextUsage.maxContextTokens.toLocaleString()}{' '}
          </span>
          ({pct}%)
        </span>
      </div>
      {contextExpanded && (
        <div className="mt-1.5 pl-5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>模型：{contextUsage.model || '—'}</span>
          <span>消息数：{contextUsage.messageCount}</span>
          <span>输入 tokens：{contextUsage.promptTokens.toLocaleString()}</span>
          <span>输出 tokens：{contextUsage.completionTokens.toLocaleString()}</span>
          <span>字符数：{contextUsage.currentChars.toLocaleString()}</span>
          <span className={textColor}>
            状态：{contextUsage.level === 'safe' ? '充足' : contextUsage.level === 'warning' ? '偏高' : '即将超限'}
          </span>
        </div>
      )}
    </div>
  );
};

export default ContextBar;
