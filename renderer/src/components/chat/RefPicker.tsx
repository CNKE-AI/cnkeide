import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Folder, ChevronRight, Search, AtSign, Hash, Loader2, CornerDownLeft } from 'lucide-react';
import { useApp } from '../../store/AppProvider';

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
}

interface RefPickerProps {
  open: boolean;
  onClose: () => void;
  /** 选择文件后回调（把 @路径 插入输入框） */
  onPickFile: (path: string) => void;
  /** 选择目录后回调 */
  onPickDir: (path: string) => void;
  /** 选择 #codebase 检索结果后回调（注入检索块，用 query 触发） */
  onPickCodebase: (query: string) => void;
  /** 弹层定位锚点（输入框位置） */
  anchor: DOMRect | null;
}

/**
 * @ 引用 / #codebase 选择器弹层：
 * - 输入 `@` 时浏览文件树选择文件/目录
 * - 输入 `#codebase 关键词` 时展示检索结果
 */
const RefPicker: React.FC<RefPickerProps> = ({ open, onClose, onPickFile, onPickDir, onPickCodebase, anchor }) => {
  const { workspacePath } = useApp();
  const [cwd, setCwd] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开时初始化当前目录
  useEffect(() => {
    if (open) {
      setCwd(workspacePath);
      setSearchMode(false);
      setSearchResults([]);
    }
  }, [open, workspacePath]);

  const loadDir = useCallback(async (dir: string) => {
    setLoading(true);
    const res = await window.cnke.fs.listDir(dir);
    if (res.success) {
      const list = ((res.entries || []) as DirEntry[]).sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(list);
      setCwd(dir);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open && cwd) void loadDir(cwd);
  }, [open, cwd, loadDir]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      onClose();
    };
    const id = setTimeout(() => document.addEventListener('mousedown', onDocDown), 0);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDocDown); };
  }, [open, onClose]);

  if (!open || !anchor) return null;

  const pos = {
    left: anchor.left,
    top: anchor.top,
    width: Math.max(360, anchor.width),
  };

  const handleSearch = async (q: string) => {
    if (!workspacePath || !q.trim()) return;
    setSearching(true);
    setSearchMode(true);
    const res = await window.cnke.fs.searchFiles(workspacePath, q.trim());
    if (res.success) setSearchResults(res.results || []);
    else setSearchResults([]);
    setSearching(false);
  };

  return createPortal(
    <div
      ref={panelRef}
      style={{ position: 'fixed', left: pos.left, bottom: window.innerHeight - pos.top + 4, width: pos.width, zIndex: 9998 }}
      className="bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[320px]"
    >
      {/* 头部 */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-secondary/30 shrink-0">
        <AtSign className="w-3.5 h-3.5 text-violet-400" />
        <span className="text-[11px] text-muted-foreground truncate flex-1" title={cwd || ''}>
          {searchMode ? '代码库检索结果' : (cwd || '未打开工作区')}
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs px-1">×</button>
      </div>

      {/* 搜索输入 */}
      {!searchMode && workspacePath && (
        <div className="px-2 py-1.5 border-b border-border shrink-0">
          <div className="flex items-center gap-1.5 bg-secondary/40 rounded-md px-2 py-1">
            <Search className="w-3 h-3 text-muted-foreground" />
            <input
              autoFocus
              placeholder="搜索文件/符号（Enter 检索，Esc 关闭）"
              className="flex-1 bg-transparent outline-none text-[12px]"
              onKeyDown={(e) => {
                // IME 合成中（候选确认/取消）不触发检索或关闭
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter') handleSearch((e.target as HTMLInputElement).value);
                if (e.key === 'Escape') onClose();
              }}
            />
          </div>
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto py-1">
        {searchMode ? (
          searching ? (
            <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 检索中…
            </div>
          ) : searchResults.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">无匹配结果</div>
          ) : (
            searchResults.slice(0, 50).map((r, i) => (
              <div
                key={i}
                onClick={() => onPickCodebase(r.match || '')}
                className="flex items-start gap-2 px-3 py-1.5 hover:bg-accent cursor-pointer text-[12px]"
              >
                <FileText className="w-3.5 h-3.5 text-violet-400/70 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground truncate">{r.relativePath || r.path}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">:{r.line}</span>
                  </div>
                  <div className="text-muted-foreground/80 text-[11px] truncate">{r.match}</div>
                </div>
              </div>
            ))
          )
        ) : (
          entries.map((e) => (
            <div
              key={e.path}
              onClick={() => {
                if (e.isDirectory) loadDir(e.path);
                else onPickFile(e.path);
              }}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent cursor-pointer text-[12px] group"
            >
              {e.isDirectory ? (
                <>
                  <Folder className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
                  <span className="flex-1 text-foreground truncate">{e.name}</span>
                  <ChevronRight className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
                </>
              ) : (
                <>
                  <FileText className="w-3.5 h-3.5 text-violet-400/70 shrink-0" />
                  <span className="flex-1 text-foreground truncate">{e.name}</span>
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-3 py-1.5 border-t border-border bg-secondary/20 shrink-0 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><CornerDownLeft className="w-3 h-3" /> 选择</span>
        <span className="flex items-center gap-1"><Hash className="w-3 h-3" /> #codebase 检索</span>
        <span className="ml-auto">Esc 关闭</span>
      </div>
    </div>,
    document.body
  );
};

export default RefPicker;
