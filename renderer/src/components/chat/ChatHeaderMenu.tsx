import React, { useEffect, useRef, useState } from 'react';
import {
  MoreHorizontal, FolderPlus, RotateCcw, Trash2, BrainCircuit, History, ShieldCheck,
} from 'lucide-react';
import SessionToolbar from './SessionToolbar';

export interface ChatHeaderMenuProps {
  sessionId: string | null;
  workspaceId: string | null;
  /** 有消息且不在加载中时才允许回滚 */
  canRollback: boolean;
  canDelete: boolean;
  onNewWorkspace: () => void;
  onImport: () => void;
  onSummarized: () => void;
  onRollback: () => void;
  onDelete: () => void;
  onMemory: () => void;
  onCheckpoint: () => void;
  onApproval: () => void;
}

/** 菜单行统一样式：与 SessionToolbar 的 menu 变体保持一致 */
export const MENU_ROW_CLS =
  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-foreground/85 transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
    {children}
  </div>
);

/**
 * 会话栏「更多」菜单。
 *
 * 原来导出/导入/压缩/回滚/删除/记忆/快照/审批全部平铺成图标放在标题栏，
 * 窄宽度下互相挤压、图标语义也难以辨认。这里按「会话 / 当前对话 / 智能能力」
 * 三组收纳，只把高频的「新建」留在外面，保证左栏在任何宽度下都整齐。
 */
const ChatHeaderMenu: React.FC<ChatHeaderMenuProps> = (p) => {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // 打开即把焦点送进菜单：键盘用户不用再按 Tab 才能进来
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        // 关闭后焦点回到触发按钮，否则焦点会掉到 body 上，键盘导航断链
        btnRef.current?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      // aria menu 的方向键语义：在可用项之间循环，跳过 disabled
      const list = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
      );
      if (list.length === 0) return;
      e.preventDefault();
      const cur = list.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (e.key === 'ArrowDown') next = cur < 0 ? 0 : (cur + 1) % list.length;
      else if (e.key === 'ArrowUp') next = cur <= 0 ? list.length - 1 : cur - 1;
      else if (e.key === 'Home') next = 0;
      else next = list.length - 1;
      list[next].focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`icon-btn ${open ? 'bg-accent text-foreground' : ''}`}
        title="更多操作"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {open && (
        /* 窄面板/矮窗口下收敛：固定 240px 宽会在左栏拖窄时溢出窗口左侧，
           固定高度会把"工具审批规则"挤到视口外且无法滚动 */
        <div
          role="menu"
          ref={menuRef}
          className="overlay-panel absolute right-0 top-full z-50 mt-1.5 w-[min(15rem,calc(100vw-1rem))] max-h-[min(28rem,calc(100vh-4rem))] overflow-y-auto p-1.5 text-popover-foreground"
        >
          <SectionTitle>会话</SectionTitle>
          <button type="button" role="menuitem" className={MENU_ROW_CLS} onClick={run(p.onNewWorkspace)}>
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-violet-500" />
            新建对话（选择工作区）
          </button>
          <SessionToolbar
            variant="menu"
            sessionId={p.sessionId}
            workspaceId={p.workspaceId}
            onImport={p.onImport}
            onSummarized={p.onSummarized}
            onAction={close}
          />

          <div className="my-1 border-t border-border/60" />
          <SectionTitle>当前对话</SectionTitle>
          <button
            type="button"
            role="menuitem"
            className={MENU_ROW_CLS}
            disabled={!p.canRollback}
            onClick={run(p.onRollback)}
          >
            <RotateCcw className="h-3.5 w-3.5 shrink-0 text-cyan-600" />
            回滚到上一轮
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${MENU_ROW_CLS} text-rose-600 hover:bg-rose-500/10`}
            disabled={!p.canDelete}
            onClick={run(p.onDelete)}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            删除当前对话
          </button>

          <div className="my-1 border-t border-border/60" />
          <SectionTitle>智能能力</SectionTitle>
          <button type="button" role="menuitem" className={MENU_ROW_CLS} onClick={run(p.onMemory)}>
            <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-violet-500" />
            本地记忆
          </button>
          <button type="button" role="menuitem" className={MENU_ROW_CLS} onClick={run(p.onCheckpoint)}>
            <History className="h-3.5 w-3.5 shrink-0 text-amber-600" />
            文件快照
          </button>
          <button type="button" role="menuitem" className={MENU_ROW_CLS} onClick={run(p.onApproval)}>
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
            工具审批规则
          </button>
        </div>
      )}
    </div>
  );
};

export default ChatHeaderMenu;
