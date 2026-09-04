import React, { useCallback, useRef, useState, useEffect } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor, dropCursor } from '@codemirror/view';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { tags as t } from '@lezer/highlight';
import { useThemeStore } from '../../store/themeStore';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { php } from '@codemirror/lang-php';
import { yaml } from '@codemirror/lang-yaml';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { FileCode2, X, Save, SaveAll, MessageSquarePlus } from 'lucide-react';

/** CodeMirror 编辑器主题 - 深色背景，匹配 IDE 整体风格 */
const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: '#0a0a0c',
    color: '#d4d4d8',
    height: '100%',
    fontSize: '13px',
  },
  '.cm-content': {
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace",
    caretColor: '#a855f7',
  },
  '.cm-gutters': {
    backgroundColor: '#0a0a0c',
    color: '#3f3f46',
    border: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(168, 85, 247, 0.04)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(168, 85, 247, 0.08)',
    color: '#a855f7',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(168, 85, 247, 0.15)',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#a855f7',
  },
  '.cm-cursor': {
    borderLeftColor: '#a855f7',
  },
  '.cm-matchingBracket': {
    color: '#22d3ee',
    backgroundColor: 'rgba(34, 211, 238, 0.1)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#27272a',
    color: '#71717a',
    border: '1px solid #3f3f46',
  },
  '.cm-tooltip': {
    backgroundColor: '#131317',
    border: '1px solid #3f3f46',
    color: '#d4d4d8',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'rgba(168, 85, 247, 0.2)',
    color: '#fff',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(234, 179, 8, 0.25)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(234, 179, 8, 0.5)',
  },
}, { dark: true });

/** CodeMirror 浅色主题 - 匹配白色主题 */
const lightTheme = EditorView.theme({
  '&': {
    backgroundColor: '#f6f4fb',
    color: '#000000',
    height: '100%',
    fontSize: '13px',
  },
  '.cm-content': {
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace",
    caretColor: '#000000',
  },
  '.cm-gutters': {
    backgroundColor: '#f1edf8',
    color: '#8b949e',
    border: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(168, 85, 247, 0.06)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(168, 85, 247, 0.1)',
    color: '#a855f7',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(168, 85, 247, 0.18)',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#000000',
    borderLeftWidth: '2px',
  },
  '.cm-cursor': {
    borderLeftColor: '#000000',
    borderLeftWidth: '2px',
  },
  '.cm-matchingBracket': {
    color: '#0b7285',
    backgroundColor: 'rgba(34, 211, 238, 0.15)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#f0f0f0',
    color: '#8b949e',
    border: '1px solid #e1e4e8',
  },
  '.cm-tooltip': {
    backgroundColor: '#ffffff',
    border: '1px solid #e1e4e8',
    color: '#000000',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'rgba(168, 85, 247, 0.15)',
    color: '#000000',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(234, 179, 8, 0.3)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(234, 179, 8, 0.55)',
  },
}, { dark: false });

/** 浅色主题语法高亮 */
const lightHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: '#d73a49' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#000000' },
  { tag: [t.function(t.variableName), t.labelName], color: '#6f42c1' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#005cc5' },
  { tag: [t.definition(t.name), t.separator], color: '#000000' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#005cc5' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#22863a' },
  { tag: [t.meta, t.comment], color: '#5b6268' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#005cc5', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: '#000000' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#005cc5' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: '#032f62' },
  { tag: t.invalid, color: '#b31d28' },
]);

/** 根据主题返回编辑器主题扩展集合 */
function themeExtensions(dark: boolean) {
  if (dark) {
    return [editorTheme, oneDark, syntaxHighlighting(defaultHighlightStyle, { fallback: true })];
  }
  return [lightTheme, syntaxHighlighting(lightHighlightStyle, { fallback: true })];
}

/** 根据扩展名返回 CodeMirror 语言扩展 */
function langExtensionOf(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, () => any> = {
    ts: () => javascript({ typescript: true }),
    tsx: () => javascript({ typescript: true, jsx: true }),
    mts: () => javascript({ typescript: true }),
    cts: () => javascript({ typescript: true }),
    js: () => javascript(),
    jsx: () => javascript({ jsx: true }),
    mjs: () => javascript(),
    cjs: () => javascript(),
    json: () => json(),
    jsonc: () => json(),
    html: () => html(),
    htm: () => html(),
    vue: () => html(),
    css: () => css(),
    scss: () => css(),
    less: () => css(),
    py: () => python(),
    pyw: () => python(),
    go: () => go(),
    rs: () => rust(),
    php: () => php(),
    xml: () => xml(),
    sql: () => sql(),
    java: () => java(),
    cpp: () => cpp(),
    cc: () => cpp(),
    cxx: () => cpp(),
    hpp: () => cpp(),
    h: () => cpp(),
    c: () => cpp(),
    cs: () => java(),
    md: () => markdown(),
    markdown: () => markdown(),
    yaml: () => yaml(),
    yml: () => yaml(),
  };
  return map[ext]?.() ?? [];
}

/** 从文件名提取语言标签（用于发送选区到对话） */
function langLabelOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ext || 'plaintext';
}

const EditorPanel: React.FC = () => {
  const { tabs, activePath, closeTab, updateContent, saveFile, saveAll } = useEditorStore();
  const theme = useThemeStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());
  const activePathRef = useRef<string | null>(null);
  const isUpdatingRef = useRef(false);
  const [hasSelection, setHasSelection] = useState(false);

  const active = tabs.find((t) => t.path === activePath) ?? null;

  // 创建/更新编辑器
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      // 选区变化
      if (update.selectionSet) {
        const sel = update.state.selection.main;
        setHasSelection(!sel.empty);
      }
      // 文档变化
      if (update.docChanged && !isUpdatingRef.current) {
        const newPath = activePathRef.current;
        if (newPath) {
          const newValue = update.state.doc.toString();
          updateContent(newPath, newValue);
          useEditorStore.getState().markDirty(newPath, true);
        }
      }
    });

    const state = EditorState.create({
      doc: active?.content ?? '',
      extensions: [
        themeCompartmentRef.current.of(themeExtensions(theme === 'dark')),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        Prec.highest(keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          ...closeBracketsKeymap,
          ...foldKeymap,
          indentWithTab,
        ])),
        history(),
        foldGutter({
          markerDOM: (open) => {
            const el = document.createElement('span');
            el.textContent = open ? '▾' : '▸';
            el.style.color = '#52525b';
            el.style.cursor = 'pointer';
            el.style.fontSize = '10px';
            return el;
          },
        }),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        langCompartmentRef.current.of(langExtensionOf(active?.name ?? '')),
        updateListener,
        EditorView.editable.of(!!active),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
    activePathRef.current = activePath;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activePath]); // 只在切换文件时重建编辑器

  // 当文件内容从外部变更时（如另存为、自动格式化），同步到编辑器
  useEffect(() => {
    if (!viewRef.current || !active) return;
    const view = viewRef.current;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== active.content) {
      isUpdatingRef.current = true;
      view.dispatch({
        changes: {
          from: 0,
          to: currentDoc.length,
          insert: active.content,
        },
      });
      isUpdatingRef.current = false;
    }
  }, [active?.content]);

  // 当文件名变化时，更新语言扩展
  useEffect(() => {
    if (!viewRef.current || !active) return;
    viewRef.current.dispatch({
      effects: langCompartmentRef.current.reconfigure(langExtensionOf(active.name)),
    });
  }, [active?.name]);

  // 当主题切换时，动态更新编辑器主题
  useEffect(() => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({
      effects: themeCompartmentRef.current.reconfigure(themeExtensions(theme === 'dark')),
    });
  }, [theme]);

  // 发送选区到对话
  const sendSelectionToChat = useCallback(() => {
    const view = viewRef.current;
    if (!view || !active) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const code = view.state.sliceDoc(sel.from, sel.to);
    if (!code.trim()) return;
    const filePath = active.path;
    const lang = langLabelOf(active.name);
    const prompt = `请帮我分析/解释以下代码（来自 ${filePath}）：\n\n\`\`\`${lang}\n${code}\n\`\`\``;
    useUiStore.getState().setPendingPrompt(prompt);
  }, [active]);

  // 保存快捷键 Ctrl/Cmd + S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        const p = useEditorStore.getState().activePath;
        if (p) void useEditorStore.getState().saveFile(p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleClose = (path: string) => {
    const tab = tabs.find((t) => t.path === path);
    if (tab?.dirty && !window.confirm(`「${tab.name}」有未保存的修改，确定关闭？`)) return;
    closeTab(path);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 标签栏 */}
      <div className="flex items-center justify-between border-b border-border bg-secondary/20 shrink-0">
        <div className="flex items-center overflow-x-auto flex-1" style={{ scrollbarWidth: 'none' }}>
          {tabs.length === 0 ? (
            <span className="px-3 py-2 text-[11px] text-muted-foreground/50">暂无打开的文件，点击左侧文件树打开</span>
          ) : (
            tabs.map((t) => {
              const isActive = t.path === activePath;
              return (
                <div
                  key={t.path}
                  onClick={() => useEditorStore.setState({ activePath: t.path })}
                  className={`group flex items-center gap-1.5 px-3 py-2 text-[12px] border-r border-border cursor-pointer whitespace-nowrap transition-colors shrink-0 ${
                    isActive ? 'bg-background text-foreground border-t-2 border-t-violet-500' : 'text-muted-foreground hover:bg-accent/50'
                  }`}
                  title={t.path}
                >
                  <FileCode2 className="w-3.5 h-3.5 text-violet-400/80 shrink-0" />
                  <span className="max-w-[140px] truncate">{t.name}</span>
                  {t.dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="未保存" />}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleClose(t.path); }}
                    className="p-0.5 rounded hover:bg-red-500/20 hover:text-red-400 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    title="关闭"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
        {/* 保存按钮 */}
        <div className="flex items-center gap-0.5 px-2 shrink-0">
          <button
            onClick={() => activePath && saveFile(activePath)}
            disabled={!active}
            className="p-1.5 hover:bg-accent hover:text-foreground rounded-md transition-colors text-muted-foreground disabled:opacity-40"
            title="保存当前文件 (Ctrl+S)"
          >
            <Save className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={saveAll}
            disabled={tabs.length === 0}
            className="p-1.5 hover:bg-accent hover:text-foreground rounded-md transition-colors text-muted-foreground disabled:opacity-40"
            title="保存全部"
          >
            <SaveAll className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={sendSelectionToChat}
            disabled={!hasSelection}
            className="p-1.5 hover:bg-primary/15 hover:text-primary rounded-md transition-colors text-muted-foreground disabled:opacity-30"
            title="发送选中代码到对话"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 编辑器主体 - CodeMirror 6 */}
      <div className="flex-1 overflow-hidden">
        {active ? (
          <div
            ref={containerRef}
            className="h-full overflow-hidden cm-editor-container"
            onMouseEnter={() => viewRef.current?.focus()}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-600">
            <FileCode2 className="w-12 h-12 opacity-30" />
            <p className="text-sm">打开文件开始编辑</p>
            <p className="text-xs text-gray-700">支持代码高亮 · Ctrl+S 保存 · 多标签切换</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default EditorPanel;
