import React from 'react';
import { Wrench, Check, X, Ban, Undo2, Loader2 } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';

import { toast } from '../../utils/toast';
import { toolLabel } from '../../store/agentActivityStore';
/** 行 diff 的单行：ctx 未变 / add 新增 / del 删除 */
type DiffRow = { type: 'ctx' | 'add' | 'del'; text: string };
/** 折叠上下文后的间隙标记 */
type Gap = { type: 'gap'; count: number };

/**
 * 行级 LCS diff。
 * 两侧行数超限时返回 null，调用方退化为"文件过大"摘要，避免 O(n·m) 卡 UI。
 */
function diffLines(before: string, after: string): DiffRow[] | null {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  if (a.length > 600 || b.length > 600) return null;
  const n = a.length;
  const m = b.length;
  // LCS 长度表（从后往前填）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] });
  while (j < m) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

/** 只保留变更行前后 ctx 行的上下文，其余折叠为 gap，长 diff 才有可读性 */
function collapseContext(rows: DiffRow[], ctx = 3): (DiffRow | Gap)[] {
  const keep = new Set<number>();
  rows.forEach((r, idx) => {
    if (r.type !== 'ctx') {
      for (let k = Math.max(0, idx - ctx); k <= Math.min(rows.length - 1, idx + ctx); k++) keep.add(k);
    }
  });
  const out: (DiffRow | Gap)[] = [];
  let gapStart = -1;
  rows.forEach((r, idx) => {
    if (keep.has(idx)) {
      if (gapStart >= 0) {
        out.push({ type: 'gap', count: idx - gapStart });
        gapStart = -1;
      }
      out.push(r);
    } else if (gapStart < 0) {
      gapStart = idx;
    }
  });
  if (gapStart >= 0) out.push({ type: 'gap', count: rows.length - gapStart });
  return out;
}

/** 单行超长截断，避免压缩包/锁文件之类把布局撑爆 */
const clipLine = (s: string) => (s.length > 500 ? `${s.slice(0, 500)}…` : s);

/**
 * 工具结果整体截断：扫描类命令的 output 即便经主进程 400KB 上限截断，
 * 整块塞进一个 break-all 文本节点仍会卡住聊天气泡渲染（白屏诱因之一）。
 * 展示层再收一道：超过 100KB 只渲染前 100KB，尾部标注省略信息。
 */
const MAX_OUTPUT_CHARS = 100_000;
const clipOutput = (s: string) =>
  s.length > MAX_OUTPUT_CHARS
    ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n…（输出过长，已省略 ${s.length - MAX_OUTPUT_CHARS} 字符，原始共 ${s.length} 字符）`
    : s;

/** 已耗时展示：短任务用秒，超过 1 分钟用 m:ss，避免长任务一直显示 900s */
const fmtElapsed = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`);

const ToolCallView: React.FC<{ call: any }> = ({ call }) => {
  const [open, setOpen] = React.useState(false);
  const [rolled, setRolled] = React.useState(false);
  const [rolling, setRolling] = React.useState(false);
  const args = call.arguments ?? {};

  const result = call.result;
  const isRejected = result === '已拒绝';
  const isDone = result !== undefined && result !== null;
  const isError = isDone && !isRejected && typeof result === 'object' && result.success === false;
  const diffMeta = isDone && !isRejected && typeof result === 'object' ? result.diff : undefined;
  // 运行中判定要结合全局 loading：历史会话的旧 toolCall 没有结果字段，不能永远转圈
  const loading = useChatStore((s) => s.loading);
  const isRunning = !isDone && loading;
  // 长命令实时进度（来自 tool_progress 事件）
  const progress = call.progress as { current?: number; total?: number; percent?: number } | undefined;

  // 运行中：记录起始时间并每秒刷新已耗时——长任务期间给用户确定性反馈，
  // 避免「看起来卡死 / 白屏」的错觉（UI 线程本身并未阻塞，只是任务在跑）。
  const [elapsed, setElapsed] = React.useState(0);
  const startedAtRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!isRunning) {
      startedAtRef.current = null;
      setElapsed(0);
      return;
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - (startedAtRef.current || Date.now())) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  // 头部摘要：写操作显示目标文件名，其余显示参数截断
  const argsSummary =
    typeof args === 'string'
      ? args
      : diffMeta
        ? diffMeta.path.replace(/^.*[\\/]/, '')
        : JSON.stringify(args).slice(0, 80);

  // diff 是 O(n·m) 的 LCS：本组件订阅了全局 loading，流式期间每帧都会重渲染，
  // 不缓存就等于每一帧对所有工具卡片重算一遍。依赖取具体字段而非 diffMeta 引用。
  const diffPath: string | undefined = diffMeta?.path;
  const diffBefore: string | undefined = diffMeta?.before;
  const diffAfter: string | undefined = diffMeta?.after;
  const { rows, additions, deletions } = React.useMemo(() => {
    const r = diffPath ? diffLines(diffBefore ?? '', diffAfter ?? '') : null;
    return {
      rows: r,
      additions: r ? r.filter((x) => x.type === 'add').length : 0,
      deletions: r ? r.filter((x) => x.type === 'del').length : 0,
    };
  }, [diffPath, diffBefore, diffAfter]);

  /** 回滚：新建文件 → 删除；其余 → 写回修改前内容。文件监听会自动刷新编辑器。 */
  const doRollback = async () => {
    if (!diffMeta || rolling || rolled) return;
    const willDelete = diffMeta.before === undefined;
    const ok = window.confirm(
      willDelete
        ? `回滚将删除本次新建的文件：\n${diffMeta.path}`
        : `回滚将把文件恢复到本次修改前的内容（当前改动会丢失）：\n${diffMeta.path}`,
    );
    if (!ok) return;
    setRolling(true);
    try {
      const r = willDelete
        ? await window.cnke.fs.deletePath(diffMeta.path)
        : await window.cnke.fs.writeFile(diffMeta.path, diffBefore ?? '');
      if (r.success) setRolled(true);
      // 原来失败时完全静默，用户会以为已经回滚成功
      else toast.error(`回滚失败：${r.error || '未知错误'}`);
    } catch (e: any) {
      toast.error(`回滚失败：${e?.message || '未知错误'}`);
    } finally {
      setRolling(false);
    }
  };

  return (
    <div className="glass-panel-flat rounded-xl text-[11.5px] font-mono overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 px-3.5 py-2.5 w-full hover:bg-accent/35 transition-colors text-left"
      >
        <Wrench className="w-3 h-3 text-primary shrink-0" />
        <span className="text-cyan-300 font-semibold">{toolLabel(call.name)}</span>
        {toolLabel(call.name) !== call.name && (
          <span className="text-[10px] text-muted-foreground/45 shrink-0">{call.name}</span>
        )}
        <span className="text-muted-foreground truncate flex-1">{argsSummary}</span>
        {diffMeta && !rolled && (
          <span className="shrink-0 text-[10px]">
            <span className="text-green-400">+{additions}</span>{' '}
            <span className="text-red-400">−{deletions}</span>
          </span>
        )}
        {rolled && <span className="shrink-0 text-[10px] text-amber-400">已回滚</span>}
        {/* 运行中显示已耗时：让长任务有「还在动」的确定感 */}
        {isRunning && elapsed > 0 && (
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{fmtElapsed(elapsed)}</span>
        )}
        {/* 状态徽标：运行中旋转 / 成功 / 失败 / 被拒绝 / 历史数据无结果则不显示 */}
        <span className="shrink-0">
          {isRunning ? (
            <Loader2 className="w-3 h-3 text-primary animate-spin" />
          ) : isRejected ? (
            <Ban className="w-3 h-3 text-amber-400" />
          ) : isError ? (
            <X className="w-3 h-3 text-red-400" />
          ) : isDone ? (
            <Check className="w-3 h-3 text-green-400" />
          ) : null}
        </span>
        <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
      </button>

      {/* 长命令实时进度条（来自 tool_progress）：仅运行中且有进度时显示 */}
      {isRunning && typeof progress?.percent === 'number' && (
        <div className="px-3.5 pb-2">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
            <span>执行中{progress.total && progress.total > 1 ? ` · ${progress.current ?? 0}/${progress.total}` : ''}</span>
            <span className="tabular-nums">{progress.percent}%</span>
          </div>
          <div className="h-1 w-full rounded bg-border/50 overflow-hidden">
            <div
              className="h-full bg-primary transition-[width] duration-300 ease-out"
              style={{ width: `${Math.min(100, Math.max(0, progress.percent as number))}%` }}
            />
          </div>
        </div>
      )}

      {open && (
        <div className="border-t border-border/60">
          {/* 参数 */}
          <pre className="px-2.5 py-2 text-[11px] text-foreground/75 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
            {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
          </pre>

          {/* 变更审查：diff + 回滚 */}
          {diffMeta && (
            <div className="px-2.5 pb-2">
              <div className="flex items-center justify-between gap-2 py-1">
                <span className="text-[10px] text-muted-foreground truncate">{diffMeta.path}</span>
                {!rolled && (
                  <button
                    onClick={doRollback}
                    disabled={rolling}
                    title={diffMeta.before === undefined ? '删除此新建文件' : '恢复到本次修改前'}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-50 transition-colors shrink-0"
                  >
                    {rolling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
                    回滚此更改
                  </button>
                )}
              </div>
              {rows === null ? (
                <div className="text-[10.5px] text-muted-foreground py-1">
                  文件行数超过 600，diff 视图已省略（可回滚，内容未截断）
                </div>
              ) : rows.length === 0 ? (
                <div className="text-[10.5px] text-muted-foreground py-1">无差异</div>
              ) : (
                <div className="rounded border border-border/60 overflow-y-auto max-h-64">
                  {collapseContext(rows).map((r, idx) =>
                    r.type === 'gap' ? (
                      <div key={idx} className="px-2 py-0.5 text-[10px] text-muted-foreground/60 bg-border/20">
                        … 省略 {r.count} 行未变更 …
                      </div>
                    ) : (
                      <div
                        key={idx}
                        className={
                          r.type === 'add'
                            ? 'px-2 bg-emerald-500/10 text-emerald-200/90 whitespace-pre-wrap break-all'
                            : r.type === 'del'
                              ? 'px-2 bg-rose-500/8 text-rose-200/80 whitespace-pre-wrap break-all'
                              : 'px-2 text-muted-foreground/70 whitespace-pre-wrap break-all'
                        }
                      >
                        <span className="select-none mr-1.5 inline-block w-2 text-center">
                          {r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}
                        </span>
                        {clipLine(r.text) || ' '}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          )}

          {/* 结果输出 / 错误 */}
          {isRejected ? (
            <div className="px-2.5 py-2 text-[11px] text-amber-300/90 border-t border-border/60">
              用户拒绝了此工具调用
            </div>
          ) : isError ? (
            <div className="px-2.5 py-2 text-[11px] text-red-300/90 border-t border-border/60 whitespace-pre-wrap break-all">
              {typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}
            </div>
          ) : (
            isDone &&
            typeof result === 'object' &&
            result.output && (
              <div className="px-2.5 py-2 text-[11px] text-foreground/60 border-t border-border/60 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                {clipOutput(String(result.output))}
              </div>
            )
          )}
          {/* 子 Agent 等字符串型结果 */}
          {isDone && typeof result === 'string' && result !== '已拒绝' && (
            <div className="px-2.5 py-2 text-[11px] text-foreground/60 border-t border-border/60 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
              {clipOutput(result)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCallView;
