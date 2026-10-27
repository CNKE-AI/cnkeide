import React, { useRef, useState } from 'react';
import { Download, Upload, FileDown, Loader2 } from 'lucide-react';

import { toast } from '../../utils/toast';
interface Props {
  sessionId: string | null;
  workspaceId: string | null;
  onImport: (session: any) => void;
  onSummarized: () => void;
  /** icons：工具条内联图标（默认）；menu：更多菜单里的带文字条目 */
  variant?: 'icons' | 'menu';
  /** 菜单项执行后回调（用于关闭菜单） */
  onAction?: () => void;
}

/** 与 ChatHeaderMenu 的行样式保持一致（此处内联，避免循环依赖） */
const MENU_ROW =
  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-foreground/85 transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

/** 会话工具栏：导出 / 导入 / 压缩上下文 */
const SessionToolbar: React.FC<Props> = ({
  sessionId, workspaceId, onImport, onSummarized, variant = 'icons', onAction,
}) => {
  const [busy, setBusy] = useState<'export' | 'import' | 'summarize' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    if (!sessionId || busy) return;
    setBusy('export');
    try {
      const res = await window.cnke.sessionEx.export(sessionId);
      if (!res.success || !res.data) {
        toast.error(res.error || '导出失败');
        return;
      }
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cnkeide-session-${sessionId.slice(0, 8)}.json`;
      // 必须挂到 DOM 上再点：游离节点在部分 Chromium 版本里不会触发下载；
      // 也不能同步 revoke —— 下载是异步发起的，立刻释放会让文件变成 0 字节/失败
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      toast.error(`导出失败：${e?.message || '未知错误'}`);
    } finally {
      setBusy(null);
      onAction?.();
    }
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    setBusy('import');
    try {
      const text = await file.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        toast.error('不是有效的 JSON 文件');
        return;
      }
      const res = await window.cnke.sessionEx.import(data);
      if (!res.success || !res.session) {
        toast.error(res.error || '导入失败');
        return;
      }
      onImport(res.session);
    } catch (e: any) {
      // 文件读取/IPC 抛错时原来会变成未处理的 rejection，界面毫无反应
      toast.error(`导入失败：${e?.message || '文件读取失败'}`);
    } finally {
      setBusy(null);
      onAction?.();
    }
  };

  const handleSummarize = async () => {
    if (!sessionId || busy) return;
    if (!window.confirm('压缩上下文会用 AI 摘要替换早期对话历史（保留最近 6 轮），是否继续？')) return;
    setBusy('summarize');
    try {
      const res = await window.cnke.sessionEx.summarize(sessionId);
      if (!res.success) {
        toast.error(res.error || '压缩失败');
        return;
      }
      toast.success('上下文已压缩');
      onSummarized();
    } finally {
      setBusy(null);
      onAction?.();
    }
  };

  const btnCls = 'p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors disabled:opacity-40';

  if (variant === 'menu') {
    return (
      <>
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleExport()}
          disabled={!sessionId || !!busy}
          className={MENU_ROW}
          title="导出当前会话为 JSON"
        >
          {busy === 'export' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Download className="h-3.5 w-3.5 shrink-0 text-cyan-600" />}
          导出会话
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={handleImportClick}
          disabled={!!busy}
          className={MENU_ROW}
          title="从 JSON 文件导入会话"
        >
          {busy === 'import' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Upload className="h-3.5 w-3.5 shrink-0 text-cyan-600" />}
          导入会话
        </button>
        <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportFile} />
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleSummarize()}
          disabled={!sessionId || !!busy}
          className={MENU_ROW}
          title="压缩上下文：AI 摘要替换早期历史"
        >
          {busy === 'summarize' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <FileDown className="h-3.5 w-3.5 shrink-0 text-cyan-600" />}
          压缩上下文
        </button>
      </>
    );
  }

  return (
    <>
      <button onClick={() => void handleExport()} disabled={!sessionId || !!busy} className={btnCls} title="导出当前会话为 JSON">
        {busy === 'export' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      </button>
      <button onClick={handleImportClick} disabled={!!busy} className={btnCls} title="从 JSON 文件导入会话">
        {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
      </button>
      <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportFile} />
      <button onClick={() => void handleSummarize()} disabled={!sessionId || !!busy} className={btnCls} title="压缩上下文：AI 摘要替换早期历史">
        {busy === 'summarize' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
      </button>
    </>
  );
};

export default SessionToolbar;
