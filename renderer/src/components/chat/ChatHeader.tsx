import React, { useEffect, useRef } from 'react';
import { MessageCircle, Plus, X } from 'lucide-react';
import type { SessionMeta } from '../../store/chatStore';
import ChatHeaderMenu from './ChatHeaderMenu';

export interface ChatHeaderProps {
  sessions: SessionMeta[];
  sessionId: string | null;
  activeWorkspaceId: string | null;
  workspacePath: string | null;
  loading: boolean;
  /** 有消息且不在加载中时才允许回滚 */
  canRollback: boolean;
  onSwitch: (s: SessionMeta) => void;
  onCloseSession: (s: SessionMeta) => void;
  onCreate: () => void;
  onCreateNewWorkspace: () => void;
  onImport: () => void;
  onSummarized: () => void;
  onRollback: () => void;
  onDelete: () => void;
  onMemory: () => void;
  onCheckpoint: () => void;
  onApproval: () => void;
}

/**
 * 左栏顶部会话栏：会话标签占满可用宽度并可横向滚动，
 * 右侧固定「新建 + 更多」两个入口，其余操作统一收进菜单。
 *
 * 这样在左栏被拖窄时不会出现图标互相挤压、换行错位，
 * 同时标题由外层面板头统一提供，避免重复的「对话」字样。
 */
const ChatHeader: React.FC<ChatHeaderProps> = (p) => {
  const currentWs = p.activeWorkspaceId || p.workspacePath;
  const activeTabRef = useRef<HTMLDivElement>(null);

  // 会话多时保证当前会话始终可见，避免切换后标签仍停在看不见的位置
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [p.sessionId, p.sessions.length]);

  return (
    <div className="shrink-0 border-b border-border/70 bg-secondary/10">
      <div className="flex items-center gap-2 px-3 py-2">
        {/* 会话标签：自适应宽度，超出横向滚动 */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar [mask-image:linear-gradient(to_right,black_88%,transparent)] [-webkit-mask-image:linear-gradient(to_right,black_88%,transparent)]">
          {p.sessions.length === 0 ? (
            <span className="truncate text-[10px] text-muted-foreground/60">
              暂无历史对话，发送消息后自动保存
            </span>
          ) : (
            p.sessions.map((s) => {
              const active = s.id === p.sessionId;
              const otherWs = s.workspaceId && s.workspaceId !== currentWs;
              return (
                <div
                  key={s.id}
                  ref={active ? activeTabRef : undefined}
                  className={`group flex shrink-0 items-center gap-0.5 rounded-lg border py-1 pl-2 pr-1 text-[11px] transition-colors ${
                    active
                      ? 'border-primary/40 bg-primary/15 text-foreground'
                      : 'border-border/50 text-muted-foreground hover:border-border hover:bg-accent/60'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => p.onSwitch(s)}
                    disabled={p.loading}
                    title={s.title || '新对话'}
                    className="flex min-w-0 items-center gap-1.5"
                  >
                    <MessageCircle className={`h-3 w-3 shrink-0 ${active ? 'text-primary' : 'opacity-60'}`} />
                    <span className="max-w-[128px] truncate">{s.title || '新对话'}</span>
                  </button>
                  {otherWs && (
                    <span className="shrink-0 text-[9px] text-muted-foreground/50">
                      {window.cnke.path.basename(s.workspaceId!)}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={p.loading}
                    onClick={() => p.onCloseSession(s)}
                    title="关闭此对话"
                    className="rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-rose-500/15 hover:text-rose-500 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* 固定操作区：只保留高频「新建」，其余进入菜单 */}
        <div className="flex shrink-0 items-center gap-0.5 border-l border-border/60 pl-1.5">
          <button
            type="button"
            onClick={p.onCreate}
            className="icon-btn"
            title="新建对话（当前工作区）"
            aria-label="新建对话"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <ChatHeaderMenu
            sessionId={p.sessionId}
            workspaceId={p.activeWorkspaceId || p.workspacePath}
            canRollback={p.canRollback}
            canDelete={!p.loading}
            onNewWorkspace={p.onCreateNewWorkspace}
            onImport={p.onImport}
            onSummarized={p.onSummarized}
            onRollback={p.onRollback}
            onDelete={p.onDelete}
            onMemory={p.onMemory}
            onCheckpoint={p.onCheckpoint}
            onApproval={p.onApproval}
          />
        </div>
      </div>
    </div>
  );
};

export default ChatHeader;
