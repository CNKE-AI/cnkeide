import React, { useState } from 'react';
import { useUiStore, PlanStep } from '../../store/uiStore';
import {
  CheckCircle2, Circle, Loader2, XCircle, MinusCircle, ListTodo,
  ChevronDown, ChevronRight,
} from 'lucide-react';

const STATUS_META: Record<PlanStep['status'], { icon: React.ReactNode; cls: string; label: string }> = {
  pending: { icon: <Circle className="w-3.5 h-3.5" />, cls: 'text-muted-foreground', label: '待处理' },
  running: { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, cls: 'text-cyan-400', label: '执行中' },
  completed: { icon: <CheckCircle2 className="w-3.5 h-3.5" />, cls: 'text-emerald-400', label: '已完成' },
  failed: { icon: <XCircle className="w-3.5 h-3.5" />, cls: 'text-rose-400', label: '失败' },
  skipped: { icon: <MinusCircle className="w-3.5 h-3.5" />, cls: 'text-amber-400/70', label: '已跳过' },
};

/** 计划面板：可视化展示 AI 的任务计划步骤与执行进度 */
const PlanPanel: React.FC<{ sessionId?: string }> = ({ sessionId }) => {
  const { plan, setPlan } = useUiStore();
  const applyPlan = (result: any) => { if (result?.plan) setPlan({ ...result, plan: result.plan, progress: result.progress }); };
  const skipStep = async (id: string) => sessionId && applyPlan(await window.cnke.plan.skip(sessionId, id));
  const retryStep = async (id: string) => sessionId && applyPlan(await window.cnke.plan.retry(sessionId, id));
  const abandonPlan = async () => sessionId && applyPlan(await window.cnke.plan.abandon(sessionId));
  // 默认展开；步骤多时用户可手动收起，避免长计划占满对话区
  const [collapsed, setCollapsed] = useState(false);

  if (!plan || plan.steps.length === 0) return null;

  const { progress } = plan;
  const total = progress?.total ?? plan.steps.length;
  // progress 缺失时用本地 steps 兜底统计，保证计数器不会一直显示 0/N
  const doneCount = progress?.done ?? plan.steps.filter((s) => s.status === 'completed').length;
  const failedCount = progress?.failed ?? plan.steps.filter((s) => s.status === 'failed').length;
  const donePct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="mx-3 mt-3 rounded-xl border border-border/80 bg-card/70 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/10 hover:bg-secondary/20 transition-colors"
        title={collapsed ? '展开计划' : '收起计划'}
      >
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground min-w-0">
          {collapsed
            ? <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
          <ListTodo className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
          <span className="truncate">{plan.title}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
          {failedCount > 0 && <span className="text-rose-400">失败 {failedCount}</span>}
          {sessionId && <span onClick={(e) => { e.stopPropagation(); void abandonPlan(); }} className="text-rose-300 hover:text-rose-200">中止</span>}
          <span className="tabular-nums font-medium">
            {doneCount}/{total}
          </span>
        </div>
      </button>

      {/* 进度条 */}
      <div className="h-0.5 bg-secondary/40">
        <div
          className={`h-full transition-all duration-300 ${failedCount > 0 ? 'bg-rose-500' : 'bg-cyan-500'}`}
          style={{ width: `${donePct}%` }}
        />
      </div>

      {!collapsed && (
        <ul className="px-3 py-2 space-y-1">
          {plan.steps.map((step, idx) => {
            const meta = STATUS_META[step.status] || STATUS_META.pending;
            // 后端字段异常时兜底显示序号，避免出现无文字的空白行
            const label = step.title?.trim() || `步骤 ${idx + 1}`;
            const detail = [step.toolName, step.filePath].filter(Boolean).join(' · ');
            return (
              <li key={step.id} className="flex items-start gap-2 text-[12px]">
                <span className={`mt-0.5 shrink-0 ${meta.cls}`}>{meta.icon}</span>
                <span className="flex-1 leading-snug min-w-0">
                  <span
                    className={
                      step.status === 'failed'
                        ? 'text-rose-300/90'
                        : step.status === 'completed'
                          ? 'text-foreground/70'
                          : 'text-foreground'
                    }
                  >
                    {label}
                  </span>
                  {detail && (
                    <span className="block text-[10px] text-muted-foreground/70 truncate" title={detail}>
                      {detail}
                    </span>
                  )}
                  {step.error && <span className="block text-[10px] text-rose-300/80 truncate" title={step.error}>{step.error}</span>}
                  {sessionId && (step.status === 'pending' || step.status === 'failed' || step.status === 'skipped') && (
                    <span className="mt-1 flex gap-2 text-[10px]">
                      {step.status === 'pending' && <button type="button" onClick={() => void skipStep(step.id)} className="text-amber-300 hover:text-amber-200">跳过</button>}
                      {step.status !== 'pending' && <button type="button" onClick={() => void retryStep(step.id)} className="text-cyan-300 hover:text-cyan-200">重试</button>}
                    </span>
                  )}
                </span>
                {step.status !== 'pending' && (
                  <span className={`text-[10px] shrink-0 ${meta.cls}`}>{meta.label}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default PlanPanel;
