import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, RotateCcw, X, Loader2, GitCompare } from 'lucide-react';

interface Snapshot {
  snapshotId?: string;
  id?: string;
  label?: string;
  sessionId?: string;
  createdAt?: number;
  fileCount?: number;
  toolName?: string;
}

interface Props {
  sessionId: string | null;
  onClose: () => void;
}

/** Checkpoint 快照查看/恢复面板 */
const CheckpointPanel: React.FC<Props> = ({ sessionId, onClose }) => {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffSnap, setDiffSnap] = useState<Snapshot | null>(null);

  const load = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const list = (await window.cnke.checkpoint.listSnapshots(sessionId)) || [];
      setSnapshots(list);
    } catch {
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hооk/exhaustive-deps
  }, [sessionId]);

  const handleRestore = async (s: Snapshot) => {
    const id = s.snapshotId || s.id;
    if (!id) return;
    if (!window.confirm('恢复到此快照会覆盖当前文件状态，是否继续？')) return;
    const res = await window.cnke.checkpoint.restore(id);
    if (res?.success) {
      alert('已恢复');
      onClose();
    } else {
      alert('恢复失败');
    }
  };

  const handleDiff = async (s: Snapshot) => {
    const id = s.snapshotId || s.id;
    if (!id) return;
    const d = await window.cnke.checkpoint.diffSnapshot(id);
    setDiffSnap(s);
    setDiff(typeof d === 'string' ? d : JSON.stringify(d, null, 2));
  };

  return createPortal(
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl w-[480px] max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <History className="w-4 h-4 text-cyan-400" />
            文件快照（Checkpoint）
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-md transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          ) : snapshots.length === 0 ? (
            <div className="text-center text-muted-foreground/60 text-[12px] py-8">暂无快照</div>
          ) : (
            snapshots.map((s) => {
              const id = s.snapshotId || s.id || '';
              return (
                <div key={id} className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 bg-secondary/20">
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-foreground truncate">{s.label || '快照'}</div>
                    <div className="text-[10px] text-muted-foreground/60">
                      {s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}
                      {s.fileCount !== undefined ? ` · ${s.fileCount} 文件` : ''}
                      {s.toolName ? ` · ${s.toolName}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDiff(s)}
                    className="p-1.5 text-muted-foreground hover:text-cyan-400 hover:bg-accent rounded-md transition-colors"
                    title="查看差异"
                  >
                    <GitCompare className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleRestore(s)}
                    className="p-1.5 text-muted-foreground hover:text-emerald-400 hover:bg-accent rounded-md transition-colors"
                    title="恢复到此快照"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
        {diff !== null && (
          <div className="border-t border-border p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-muted-foreground">
                与「{diffSnap?.label || '快照'}」的差异
              </span>
              <button onClick={() => setDiff(null)} className="text-[11px] text-muted-foreground hover:text-foreground">
                关闭
              </button>
            </div>
            <pre className="bg-secondary/40 rounded-lg p-2 text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">{diff}</pre>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default CheckpointPanel;
