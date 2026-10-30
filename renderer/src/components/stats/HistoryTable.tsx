import React from 'react';
import { ArrowUpDown, ChevronLeft, ChevronRight, MessageSquare, Wrench } from 'lucide-react';
import type { StatsSessionPage, StatsSortBy } from '../../global';

/**
 * 历史记录明细表。
 *
 * 交互约定：
 *   - 表头可点排序（更新时间 / 消息数 / 工具调用 / Token），排序在主进程做，避免只排当前页
 *   - 整行可点：跳回对话面板并打开该会话（统计 → 明细 → 原文 的闭环）
 *   - 翻页数据来自主进程分页结果，页码越界会被自动收敛
 */

interface Props {
  pageData: StatsSessionPage | null;
  sortBy: StatsSortBy;
  loading: boolean;
  onSort: (sortBy: StatsSortBy) => void;
  onPageChange: (page: number) => void;
  onOpen: (sessionId: string, workspaceId: string) => void;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

const SORTABLE: { key: StatsSortBy; label: string; className: string }[] = [
  { key: 'updatedAt', label: '时间', className: 'w-[92px]' },
  { key: 'messages', label: '消息', className: 'w-[64px] text-right' },
  { key: 'toolCalls', label: '工具', className: 'w-[64px] text-right' },
  { key: 'totalTokens', label: 'Token', className: 'w-[84px] text-right' },
];

const HistoryTable: React.FC<Props> = ({ pageData, sortBy, loading, onSort, onPageChange, onOpen }) => {
  const rows = pageData?.rows ?? [];
  const wsLabel = new Map((pageData?.workspaces ?? []).map((w) => [w.id, w.label]));

  return (
    <div className="flex flex-col">
      <div className="overflow-x-auto">
        <table className="w-full text-[11.5px] border-collapse">
          <thead>
            <tr className="text-muted-foreground/90 border-b border-border/70">
              {SORTABLE.map((col) => (
                <th key={col.key} className={`py-1.5 px-2 font-medium ${col.className}`}>
                  <button
                    type="button"
                    onClick={() => onSort(col.key)}
                    className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${
                      sortBy === col.key ? 'text-violet-300' : ''
                    } ${col.className.includes('text-right') ? 'flex-row-reverse' : ''}`}
                    title={`按${col.label}排序`}
                  >
                    {col.label}
                    <ArrowUpDown className="w-2.5 h-2.5 opacity-70" />
                  </button>
                </th>
              ))}
              <th className="py-1.5 px-2 font-medium text-left">会话</th>
              <th className="py-1.5 px-2 font-medium text-left w-[110px]">工作区</th>
              <th className="py-1.5 px-2 font-medium text-right w-[70px]">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => onOpen(r.id, r.workspaceId)}
                className="group border-b border-border/40 hover:bg-muted/40 cursor-pointer transition-colors"
                title="点击回到该会话继续"
              >
                <td className="py-2 px-2 text-muted-foreground tabular-nums whitespace-nowrap">{fmtTime(r.updatedAt)}</td>
                <td className="py-2 px-2 text-right tabular-nums">
                  <span className="inline-flex items-center gap-1 text-foreground/80">
                    <MessageSquare className="w-2.5 h-2.5 opacity-50" />
                    {r.messages}
                  </span>
                </td>
                <td className="py-2 px-2 text-right tabular-nums">
                  <span
                    className={`inline-flex items-center gap-1 whitespace-nowrap ${
                      r.toolFailures > 0 ? 'text-amber-300' : 'text-foreground/80'
                    }`}
                  >
                    <Wrench className="w-2.5 h-2.5 opacity-50" />
                    {r.toolCalls}
                    {r.toolFailures > 0 && <span className="text-[10px] opacity-80">({r.toolFailures} 失败)</span>}
                  </span>
                </td>
                <td className="py-2 px-2 text-right tabular-nums text-foreground/80">{compact(r.totalTokens)}</td>
                <td className="py-2 px-2 min-w-0">
                  <div className="truncate text-foreground/90 group-hover:text-violet-200 transition-colors">{r.title}</div>
                  <div className="truncate text-[10.5px] text-muted-foreground/80">
                    {r.preview || '（无用户消息）'}
                    {r.models.length > 0 && <span className="ml-1.5 text-violet-400/70">· {r.models.join(' / ')}</span>}
                  </div>
                </td>
                <td className="py-2 px-2 text-muted-foreground truncate max-w-[110px]" title={r.workspaceId}>
                  {wsLabel.get(r.workspaceId) || (r.workspaceId ? r.workspaceId : '—')}
                </td>
                <td className="py-2 px-2 text-right">
                  <span className="text-[10.5px] text-violet-300/0 group-hover:text-violet-300 transition-colors">打开 →</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 && (
          <div className="py-10 text-center text-xs text-muted-foreground">
            {loading ? '正在读取历史记录…' : '没有符合条件的历史记录，试试放宽时间范围或清空搜索词'}
          </div>
        )}
      </div>

      {/* 分页 */}
      <div className="flex items-center justify-between gap-2 pt-2.5 mt-1 border-t border-border/60">
        <span className="text-[10.5px] text-muted-foreground">
          共 <span className="tabular-nums text-foreground/80">{pageData?.total ?? 0}</span> 条
          {pageData && pageData.pages > 1 && (
            <>
              {' · '}第 <span className="tabular-nums text-foreground/80">{pageData.page}</span> / {pageData.pages} 页
            </>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!pageData || pageData.page <= 1}
            onClick={() => onPageChange((pageData?.page ?? 1) - 1)}
            className="inline-flex items-center gap-0.5 rounded-md border border-border px-2 py-1 text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronLeft className="w-3 h-3" />
            上一页
          </button>
          <button
            type="button"
            disabled={!pageData || pageData.page >= pageData.pages}
            onClick={() => onPageChange((pageData?.page ?? 1) + 1)}
            className="inline-flex items-center gap-0.5 rounded-md border border-border px-2 py-1 text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            下一页
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default HistoryTable;
