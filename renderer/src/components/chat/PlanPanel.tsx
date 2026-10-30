import React, { useState } from 'react';
import { useUiStore, derivePlan, PlanStep } from '../../store/uiStore';
import {
  Check, X, Minus, Loader2, ListTodo, ChevronDown, ChevronRight,
} from 'lucide-react';

import { toast } from '../../utils/toast';
import { toolLabel } from '../../store/agentActivityStore';
/**
 * 节点样式：每个步骤对应一个节点，状态通过节点描边/底色区分。
 * line 是节点之间的横向连接线颜色，用来把「已完成 → 当前 → 待执行」串成一条进度轨道。
 */
const NODE_STYLE: Record<
  PlanStep['status'],
  { ring: string; line: string; icon: React.ReactNode | null; label: string; text: string }
> = {
  pending: {
    ring: 'border-border/70 bg-background text-muted-foreground',
    line: 'bg-border/50',
    icon: null,
    label: '待处理',
    text: 'text-muted-foreground',
  },
  running: {
    ring: 'border-cyan-500/60 bg-cyan-500/10 text-cyan-600 ring-2 ring-cyan-500/15',
    line: 'bg-gradient-to-r from-cyan-500/60 to-border/40',
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
    label: '执行中',
    text: 'text-foreground',
  },
  completed: {
    ring: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600',
    line: 'bg-emerald-500/40',
    icon: <Check className="h-3.5 w-3.5" />,
    label: '已完成',
    text: 'text-foreground/70',
  },
  failed: {
    ring: 'border-rose-500/50 bg-rose-500/10 text-rose-600',
    line: 'bg-rose-500/35',
    icon: <X className="h-3.5 w-3.5" />,
    label: '失败',
    text: 'text-rose-500',
  },
  skipped: {
    ring: 'border-amber-500/40 bg-amber-500/10 text-amber-600',
    line: 'bg-border/40',
    icon: <Minus className="h-3.5 w-3.5" />,
    label: '已跳过',
    text: 'text-muted-foreground',
  },
};

const LABEL_CLS: Record<PlanStep['status'], string> = {
  pending: 'text-muted-foreground',
  running: 'text-cyan-600',
  completed: 'text-emerald-600',
  failed: 'text-rose-600',
  skipped: 'text-amber-600',
};

/** 计划面板：以横向节点进度条紧凑展示 AI 的任务步骤与执行进度 */
const PlanPanel: React.FC<{ sessionId?: string }> = ({ sessionId }) => {
  const { plan, setPlan } = useUiStore();
  // plan IPC 返回的是 { plan, progress }（步骤在 plan.items 里），
  // 而 store 存的是扁平化的 PlanState（顶层 steps）。
  // 早期这里直接把整个返回值塞进 store，使 plan.steps 变成 undefined，
  // 下一帧渲染 plan.steps.length 抛 TypeError —— 全仓无 ErrorBoundary，
  // 整个 React 树被卸载，表现为点击「跳过」后黑屏。
  const applyPlan = (result: any) => {
    if (!result || result.success === false) return;
    setPlan(result.plan ? derivePlan({ plan: result.plan, progress: result.progress }) : null);
  };

  // plan IPC 失败时过去会向上抛未处理的 rejection，直接炸掉 React 树 → 白屏。
  // 三个操作都必须就地兜底：失败只影响这一个面板，不能带崩整个渲染进程。
  const runPlanAction = async (label: string, fn: () => Promise<any>) => {
    if (!sessionId) return;
    try {
      applyPlan(await fn());
    } catch (err) {
      // 保留现有状态，仅提示；不做乐观更新，避免假状态蒙蔽用户
      toast.error(`计划操作「${label}」失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const skipStep = (id: string) => void runPlanAction('跳过', () => window.cnke.plan.skip(sessionId!, id));
  const retryStep = (id: string) => void runPlanAction('重试', () => window.cnke.plan.retry(sessionId!, id));
  const abandonPlan = () => void runPlanAction('中止', () => window.cnke.plan.abandon(sessionId!));
  // 默认展开；步骤多时用户可手动收起，避免长计划占满对话区
  const [collapsed, setCollapsed] = useState(false);
  // 横向轨道只显示节点，详细文本/错误/操作按需在下方展开，避免占用过多竖向空间
  const [activeId, setActiveId] = useState<string | null>(null);

  // 防御性取值：store 里的 plan 只要结构异常过一次就会让整个面板崩溃，
  // 而崩溃点在这个组件里，代价却是整个应用黑屏。宁可降级为"不渲染"。
  const steps: PlanStep[] = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!plan || steps.length === 0) return null;

  const { progress } = plan;
  const total = progress?.total ?? steps.length;
  // progress 缺失时用本地 steps 兜底统计，保证计数器不会一直显示 0/N
  const doneCount = progress?.done ?? steps.filter((s) => s.status === 'completed').length;
  const failedCount = progress?.failed ?? steps.filter((s) => s.status === 'failed').length;
  const runningCount = progress?.running ?? steps.filter((s) => s.status === 'running').length;
  const donePct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const activeStep = activeId ? steps.find((s) => s.id === activeId) || null : null;
  const activeIdx = activeStep ? steps.indexOf(activeStep) : -1;
  const activeMeta = activeStep ? NODE_STYLE[activeStep.status] : null;

  return (
    <div className="mx-3 mt-3 rounded-2xl border border-border/70 bg-card/80 shadow-lg shadow-black/10 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 border-b border-border/70 bg-gradient-to-r from-cyan-500/5 via-transparent to-violet-500/5 hover:bg-secondary/20 transition-colors"
        title={collapsed ? '展开计划' : '收起计划'}
      >
        <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground min-w-0">
          {collapsed
            ? <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
          <ListTodo className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
          <span className="truncate">{plan.title}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] shrink-0">
          {runningCount > 0 && <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-cyan-600">执行中 {runningCount}</span>}
          {failedCount > 0 && <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-rose-600">失败 {failedCount}</span>}
          {sessionId && <span onClick={(e) => { e.stopPropagation(); void abandonPlan(); }} className="rounded-md px-2 py-1 text-rose-600 hover:bg-rose-500/10">中止</span>}
          <span className="rounded-full bg-secondary/60 px-2.5 py-1 font-semibold tabular-nums text-foreground">
            {doneCount}/{total}
          </span>
        </div>
      </button>

      {/* 总进度条 */}
      <div className="h-1 bg-secondary/30">
        <div
          className="h-full rounded-full transition-all duration-500 bg-gradient-to-r from-cyan-500 to-emerald-400"
          style={{ width: `${donePct}%` }}
        />
      </div>

      {!collapsed && (
        <div className="px-3 py-3">
          {/* 横向节点轨道：一行展示全部步骤，超出时横向滚动 */}
          <div className="flex items-start overflow-x-auto pb-1">
            {steps.map((step, idx) => {
              const ns = NODE_STYLE[step.status] || NODE_STYLE.pending;
              const prev = idx > 0 ? steps[idx - 1] : null;
              const isActive = activeId === step.id;
              // 后端字段异常时兜底显示序号，避免出现无文字的空白节点
              const label = step.title?.trim() || `步骤 ${idx + 1}`;
              return (
                <div key={step.id} className="flex shrink-0 items-start">
                  {idx > 0 && (
                    <span
                      className={`mt-[11px] h-0.5 w-5 shrink-0 rounded-full ${prev ? NODE_STYLE[prev.status].line : 'bg-border/50'}`}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveId(isActive ? null : step.id)}
                    title={label}
                    className="group flex w-[68px] shrink-0 flex-col items-center gap-1 rounded-lg py-0.5 focus:outline-none"
                  >
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold leading-none transition-transform duration-150 group-hover:scale-110 ${ns.ring} ${isActive ? 'ring-2 ring-primary/50' : ''}`}
                    >
                      {ns.icon ?? <span className="tabular-nums">{idx + 1}</span>}
                    </span>
                    <span
                      className={`line-clamp-2 min-h-[24px] w-full text-center text-[10px] leading-tight ${isActive ? 'text-foreground' : ns.text}`}
                    >
                      {label}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* 点击节点后的步骤详情：仅在需要时展开，保持面板紧凑 */}
          {activeStep && activeMeta && (
            <div className="mt-2 rounded-xl border border-border/60 bg-background/40 px-3 py-2 text-[12px]">
              <div className="flex items-start justify-between gap-2">
                <span className={`flex-1 min-w-0 leading-snug ${activeMeta.text}`}>
                  {activeStep.title?.trim() || `步骤 ${activeIdx + 1}`}
                </span>
                <span className={`shrink-0 text-[10px] ${LABEL_CLS[activeStep.status]}`}>{activeMeta.label}</span>
                <button
                  type="button"
                  onClick={() => setActiveId(null)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  title="收起详情"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>

              {[activeStep.toolName, activeStep.filePath].filter(Boolean).length > 0 && (
                <span className="mt-1 block truncate text-[11px] text-muted-foreground/80">
                  {[activeStep.toolName ? toolLabel(activeStep.toolName) : '', activeStep.filePath]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
              {activeStep.error && (
                <span className="mt-1 block break-words text-[10.5px] text-rose-600/90">{activeStep.error}</span>
              )}

              {sessionId && (activeStep.status === 'pending' || activeStep.status === 'failed' || activeStep.status === 'skipped') && (
                <span className="mt-1.5 flex gap-3 text-[10.5px]">
                  {activeStep.status === 'pending' && (
                    <button type="button" onClick={() => void skipStep(activeStep.id)} className="text-amber-600 hover:text-amber-500">
                      跳过
                    </button>
                  )}
                  {activeStep.status !== 'pending' && (
                    <button type="button" onClick={() => void retryStep(activeStep.id)} className="text-cyan-600 hover:text-cyan-500">
                      重试
                    </button>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PlanPanel;
