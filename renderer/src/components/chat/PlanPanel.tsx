import React from 'react';
import { useUiStore, PlanStep } from '../../store/uiStore';
import { CheckCircle2, Circle, Loader2, XCircle, MinusCircle, ListTodo } from 'lucide-react';

const STATUS_META: Record<PlanStep['status'], { icon: React.ReactNode; cls: string; label: string }> = {
  pending: { icon: <Circle className="w-3.5 h-3.5" />, cls: 'text-muted-foreground', label: '待处理' },
  running: { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, cls: 'text-cyan-400', label: '执行中' },
  completed: { icon: <CheckCircle2 className="w-3.5 h-3.5" />, cls: 'text-emerald-400', label: '已完成' },
  failed: { icon: <XCircle className="w-3.5 h-3.5" />, cls: 'text-rose-400', label: '失败' },
  skipped: { icon: <MinusCircle className="w-3.5 h-3.5" />, cls: 'text-amber-400/70', label: '已跳过' },
};

/** 计划面板：可视化展示 AI 的任务计划步骤与执行进度 */
const PlanPanel: React.FC = () => {
  const { plan } = useUiStore();

  if (!plan || plan.steps.length === 0) return null;

  const { progress } = plan;
  const done = progress?.done ?? 0;
  const total = progress?.total ?? plan.steps.length;
  const failed = progress?.failed ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="mx-3 mt-2 rounded-xl border border-border bg-secondary/20 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/10">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <ListTodo className="w-3.5 h-3.5 text-cyan-400" />
          <span>{plan.title}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {failed > 0 && <span className="text-rose-400">失败 {failed}</span>}
          <span className="tabular-nums">
            {done}/{total}
          </span>
        </div>
      </div>
      <div className="h-1 bg-secondary">
        <div
          className={`h-full transition-all duration-300 ${failed > 0 ? 'bg-rose-500' : 'bg-cyan-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="px-3 py-2 space-y-1">
        {plan.steps.map((step) => {
          const meta = STATUS_META[step.status];
          return (
            <li key={step.id} className="flex items-start gap-2 text-[12px]">
              <span className={`mt-0.5 shrink-0 ${meta.cls}`}>{meta.icon}</span>
              <span className={`flex-1 leading-snug ${step.status === 'failed' ? 'text-rose-300/90' : step.status === 'completed' ? 'text-foreground/70' : 'text-foreground'}`}>
                {step.title}
              </span>
              {step.status !== 'pending' && step.status !== 'running' && (
                <span className={`text-[10px] shrink-0 ${meta.cls}`}>{meta.label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default PlanPanel;
