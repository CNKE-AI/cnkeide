import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Loader2, FileCode2, CaseSensitive, Regex, WholeWord } from 'lucide-react';
import { useApp } from '../../store/AppProvider';
import { useEditorStore } from '../../store/editorStore';
import type { ContentMatch, SearchResultSet } from '../../global';

/** 外部（资源管理器头上的放大镜）用这个事件唤出面板，省得引一个全局 store */
export const OPEN_GLOBAL_SEARCH_EVENT = 'cnke:open-global-search';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * 全局内容搜索（Ctrl+Shift+F）。
 *
 * 定位：这是**IDE 的**搜索，不是给模型用的 `search_files` 工具。
 * 代码里找"这个常量在哪被用了"是高频动作，靠对话让模型去读文件太慢也太贵。
 *
 * 交互取舍：
 * - 输入即搜（250ms 防抖），不设"按回车才搜"——搜代码时改关键词很频繁；
 * - 结果按文件分组，点一下直接跳到行（列位置一起带过去）；
 * - 面板自带开关（大小写 / 正则 / 全词），默认字面量匹配，
 *   因为用户复制一段代码粘进来搜是常态，当正则解析会直接报语法错。
 */
const GlobalSearch: React.FC = () => {
  const { workspacePath } = useApp();
  const gotoLine = useEditorStore((s) => s.gotoLine);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);

  const [result, setResult] = useState<SearchResultSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 只接受最后一次请求的结果：用户连打三个字会发三次请求，回来顺序不保证 */
  const seqRef = useRef(0);

  // 全局快捷键 + 外部唤出事件
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') setOpen(false);
    };
    const onOpenEvent = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_GLOBAL_SEARCH_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_GLOBAL_SEARCH_EVENT, onOpenEvent);
    };
  }, []);

  // 打开时聚焦；关闭时保留关键词（重新打开常常是为了继续找刚才的词）
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!workspacePath) {
      setResult(null);
      setError('还没有打开工作区，先选择或新建一个任务');
      return;
    }

    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await window.cnke.search.content(workspacePath, q, {
        caseSensitive,
        regex,
        wholeWord,
      });
      if (seq !== seqRef.current) return; // 已有更新的请求，丢弃这次结果
      if (!res.success || !res.data) {
        setResult(null);
        setError(res.error || '搜索失败');
        return;
      }
      setResult(res.data);
      setActiveIndex(0);
    } catch (e: unknown) {
      if (seq !== seqRef.current) return;
      setError(errText(e, '搜索失败'));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [query, workspacePath, caseSensitive, regex, wholeWord]);

  // 防抖：250ms 足够吃掉连续击键，又不至于让人等
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void runSearch(), 250);
    return () => clearTimeout(t);
  }, [open, runSearch]);

  // 提到 useMemo 里：否则 `?? []` 每次渲染都是新数组，会让下面的分组 useMemo 白算一遍
  const matches = useMemo(() => result?.matches ?? [], [result]);

  /** 按文件分组展示：同一文件的多处命中挤在一起更好读 */
  const groups = useMemo(() => {
    const map = new Map<string, ContentMatch[]>();
    for (const m of matches) {
      const arr = map.get(m.relativePath);
      if (arr) arr.push(m);
      else map.set(m.relativePath, [m]);
    }
    return Array.from(map.entries());
  }, [matches]);

  const openMatch = async (m: ContentMatch) => {
    await gotoLine(m.file, m.line, m.column);
    setOpen(false);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = matches[activeIndex];
      if (target) void openMatch(target);
    }
  };

  // 键盘移动时把选中项滚进可视区
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;

  const optBtn = (active: boolean) =>
    `flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] transition-colors ${
      active ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    }`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/45 px-4 pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="overlay-panel flex max-h-[70vh] w-[min(780px,94vw)] flex-col overflow-hidden">
        {/* 输入行 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="在工作区文件中搜索内容（字面量匹配）"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/50"
            spellCheck={false}
          />
          {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setCaseSensitive((v) => !v)}
              className={optBtn(caseSensitive)}
              title="区分大小写"
            >
              <CaseSensitive className="h-3 w-3" />
              Aa
            </button>
            <button type="button" onClick={() => setWholeWord((v) => !v)} className={optBtn(wholeWord)} title="全词匹配">
              <WholeWord className="h-3 w-3" />
              词
            </button>
            <button type="button" onClick={() => setRegex((v) => !v)} className={optBtn(regex)} title="按正则表达式匹配">
              <Regex className="h-3 w-3" />
              正则
            </button>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭 (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 结果 */}
        <div ref={listRef} className="min-h-[80px] flex-1 overflow-y-auto p-1.5">
          {error && <div className="px-2.5 py-3 text-[11.5px] text-rose-500">{error}</div>}

          {!error && !query.trim() && (
            <div className="px-2.5 py-3 text-[11px] leading-relaxed text-muted-foreground/70">
              输入关键词开始搜索；↑↓ 选择，Enter 打开，Esc 关闭。
              <br />
              会跳过 node_modules、.git、dist 等目录，以及二进制文件和 1MB 以上的大文件。
            </div>
          )}

          {!error && query.trim() && !loading && matches.length === 0 && result && (
            <div className="px-2.5 py-3 text-[11px] text-muted-foreground/70">
              没有找到「{query.trim()}」。
              {result.filesScanned > 0 && `已扫描 ${result.filesScanned} 个文件。`}
              {result.skippedLarge > 0 && `（跳过 ${result.skippedLarge} 个大文件）`}
            </div>
          )}

          {groups.map(([file, items]) => (
            <div key={file} className="mb-1">
              <div className="flex items-center gap-1.5 px-2 py-1 text-[10.5px] text-muted-foreground/80">
                <FileCode2 className="h-3 w-3 shrink-0 text-sky-400" />
                <span className="truncate" title={file}>
                  {file}
                </span>
                <span className="shrink-0 opacity-60">{items.length}</span>
              </div>
              {items.map((m) => {
                const idx = matches.indexOf(m);
                const active = idx === activeIndex;
                return (
                  <button
                    key={`${m.file}:${m.line}:${m.column}`}
                    data-idx={idx}
                    type="button"
                    onClick={() => void openMatch(m)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={`flex w-full items-baseline gap-2 rounded px-2 py-0.5 text-left font-mono text-[11px] leading-relaxed ${
                      active ? 'bg-primary/15 text-foreground' : 'text-foreground/80 hover:bg-accent/60'
                    }`}
                    title={`${m.relativePath}:${m.line}:${m.column}`}
                  >
                    <span className="w-10 shrink-0 text-right text-muted-foreground/60">{m.line}</span>
                    <span className="truncate">{m.text || '（空行）'}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* 底部统计：告诉用户"搜过多少"和"是否截断"，避免误以为只有这几条 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5 text-[10px] text-muted-foreground/70">
          <span>
            {matches.length > 0 ? `${matches.length} 个匹配 · ${groups.length} 个文件` : '—'}
            {result && result.filesScanned > 0 && ` · 已扫描 ${result.filesScanned} 个文件`}
          </span>
          <span className="flex items-center gap-2">
            {result?.truncated && <span className="text-amber-500">结果过多已截断，请细化关键词</span>}
            {result?.timedOut && <span className="text-amber-500">搜索超时，结果可能不完整</span>}
            <span className="opacity-70">Ctrl+Shift+F</span>
          </span>
        </div>
      </div>
    </div>
  );
};

export default GlobalSearch;
