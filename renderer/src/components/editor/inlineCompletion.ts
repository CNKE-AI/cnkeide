/**
 * AI 行内补全 —— CodeMirror 6 ghost-text 插件
 *
 * 自实现 inline suggestion（CM6 官方无内置该能力，避免引入第三方依赖）：
 * - StateField 持有当前建议 { pos, text }；
 * - provide 出 Decoration.widget，在光标处渲染半透明 ghost-text；
 * - ViewPlugin 监听光标停顿（防抖）后请求补全，写入 StateField；
 * - keymap 拦截 Tab 接受 / Esc 拒绝；继续输入或移动光标自动清空。
 *
 * 触发条件（避免干扰输入）：
 * - 无选区、光标后同行仅剩空白、前后文非空。
 */

import { StateField, StateEffect, Prec } from '@codemirror/state';
import { EditorView, keymap, Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { InlineCompletionRequest } from '../../global.d';

/** 触发防抖（光标停顿多少 ms 后请求） */
const TRIGGER_DELAY_MS = 300;
/** prefix 最多携带的行数 */
const PREFIX_MAX_LINES = 60;
/** suffix 最多携带的行数 */
const SUFFIX_MAX_LINES = 20;

interface Suggestion {
  pos: number;
  text: string;
}

/** 设置建议（null 表示清空） */
const setSuggestion = StateEffect.define<Suggestion | null>();

/** ghost-text 装饰部件 */
class InlineSuggestionWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: InlineSuggestionWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-inline-suggestion';
    span.textContent = this.text;
    return span;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** 持有当前建议，并映射文档变化以保持 pos 有效 */
const suggestionState = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value;
    }
    if (tr.docChanged && value) {
      // 用户编辑导致文档变化：建议不再可信，清空
      return null;
    }
    if (tr.selection && value) {
      // 光标移动：若离开建议位置则清空
      if (tr.state.selection.main.head !== value.pos) return null;
    }
    return value;
  },
});

/** 由 StateField 派生 ghost-text 装饰 */
const suggestionDecorations = EditorView.decorations.compute([suggestionState], (state) => {
  const s = state.field(suggestionState);
  if (!s || !s.text) return Decoration.none;
  const widget = Decoration.widget({ widget: new InlineSuggestionWidget(s.text), side: 1 });
  return Decoration.set([widget.range(s.pos)]);
});

/** 从 EditorState 提取补全上下文（截断 prefix/suffix）；不满足触发条件返回 null */
function buildRequest(view: EditorView, filePath: string, language: string): InlineCompletionRequest | null {
  const state = view.state;
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const pos = sel.head;

  const fullText = state.doc.toString();
  const prefixFull = fullText.slice(0, pos);
  const suffixFull = fullText.slice(pos);

  // 触发条件：光标后同行仅剩空白
  const lineTail = suffixFull.split('\n', 1)[0];
  if (lineTail.trim() !== '') return null;

  const prefix = prefixFull.split('\n').slice(-PREFIX_MAX_LINES).join('\n');
  const suffix = suffixFull.split('\n').slice(0, SUFFIX_MAX_LINES).join('\n');
  if (!prefix.trim() && !suffix.trim()) return null;

  return { filePath, language, prefix, suffix };
}

export interface InlineCompletionOptions {
  getFilePath: () => string;
  getLanguage: () => string;
  enabled: () => boolean;
}

/** 创建行内补全扩展集合 */
export function inlineCompletion(opts: InlineCompletionOptions): Extension {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestSeq = 0;
  let activeRequestId: string | null = null;

  const requestCompletion = (view: EditorView) => {
    if (!opts.enabled()) return;
    const filePath = opts.getFilePath();
    if (!filePath) return;
    const language = opts.getLanguage();
    const req = buildRequest(view, filePath, language);
    if (!req) return;

    const seq = ++requestSeq;
    const requestId = `ic_${Date.now()}_${seq}`;
    activeRequestId = requestId;
    const cursorPos = view.state.selection.main.head;

    void window.cnke.completion
      .inline(req, requestId)
      .then((result) => {
        if (seq !== requestSeq) return; // 过期请求
        if (!view.dom.isConnected) return;
        if ('text' in result && result.text) {
          if (view.state.selection.main.head === cursorPos && view.state.selection.main.empty) {
            view.dispatch({ effects: setSuggestion.of({ pos: cursorPos, text: result.text }) });
          }
        }
      })
      .catch(() => {
        /* 静默失败，不打断输入 */
      });
  };

  const plugin = ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {}
      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            if (this.view.hasFocus) requestCompletion(this.view);
          }, TRIGGER_DELAY_MS);
        }
      }
      destroy() {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (activeRequestId) void window.cnke.completion.cancel(activeRequestId);
      }
    }
  );

  /** Tab 接受 / Esc 拒绝（优先级高于默认 keymap） */
  const acceptKeymap = Prec.highest(
    keymap.of([
      {
        key: 'Tab',
        run: (view) => {
          const s = view.state.field(suggestionState, false);
          if (!s || !s.text) return false;
          const insertPos = view.state.selection.main.head;
          const text = s.text;
          view.dispatch({
            changes: { from: insertPos, insert: text },
            selection: { anchor: insertPos + text.length },
            effects: setSuggestion.of(null),
            userEvent: 'input.complete',
          });
          return true;
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          const s = view.state.field(suggestionState, false);
          if (!s) return false;
          view.dispatch({ effects: setSuggestion.of(null) });
          return true;
        },
      },
    ])
  );

  return [suggestionState, suggestionDecorations, plugin, acceptKeymap];
}

/** ghost-text 样式（半透明、不干扰布局） */
export const inlineSuggestionTheme: Extension = EditorView.baseTheme({
  '.cm-inline-suggestion': {
    opacity: '0.45',
    fontStyle: 'italic',
    pointerEvents: 'none',
    whiteSpace: 'pre',
  },
});
