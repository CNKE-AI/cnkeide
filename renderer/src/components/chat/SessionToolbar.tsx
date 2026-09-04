import React, { useRef, useState } from 'react';
import { Download, Upload, FileDown, Loader2 } from 'lucide-react';

interface Props {
  sessionId: string | null;
  workspaceId: string | null;
  onImport: (session: any) => void;
  onSummarized: () => void;
}

/** 会话工具栏：导出 / 导入 / 压缩上下文 */
const SessionToolbar: React.FC<Props> = ({ sessionId, workspaceId, onImport, onSummarized }) => {
  const [busy, setBusy] = useState<'export' | 'import' | 'summarize' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    if (!sessionId || busy) return;
    setBusy('export');
    try {
      const res = await window.cnke.sessionEx.export(sessionId);
      if (!res.success || !res.data) {
        alert(res.error || '导出失败');
        return;
      }
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cnkeide-session-${sessionId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
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
        alert('不是有效的 JSON 文件');
        return;
      }
      const res = await window.cnke.sessionEx.import(data);
      if (!res.success || !res.session) {
        alert(res.error || '导入失败');
        return;
      }
      onImport(res.session);
    } finally {
      setBusy(null);
    }
  };

  const handleSummarize = async () => {
    if (!sessionId || busy) return;
    if (!window.confirm('压缩上下文会用 AI 摘要替换早期对话历史（保留最近 6 轮），是否继续？')) return;
    setBusy('summarize');
    try {
      const res = await window.cnke.sessionEx.summarize(sessionId);
      if (!res.success) {
        alert(res.error || '压缩失败');
        return;
      }
      alert('上下文已压缩');
      onSummarized();
    } finally {
      setBusy(null);
    }
  };

  const btnCls = 'p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors disabled:opacity-40';

  return (
    <>
      <button onClick={handleExport} disabled={!sessionId || !!busy} className={btnCls} title="导出当前会话为 JSON">
        {busy === 'export' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      </button>
      <button onClick={handleImportClick} disabled={!!busy} className={btnCls} title="从 JSON 文件导入会话">
        {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
      </button>
      <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportFile} />
      <button onClick={handleSummarize} disabled={!sessionId || !!busy} className={btnCls} title="压缩上下文：AI 摘要替换早期历史">
        {busy === 'summarize' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
      </button>
    </>
  );
};

export default SessionToolbar;
