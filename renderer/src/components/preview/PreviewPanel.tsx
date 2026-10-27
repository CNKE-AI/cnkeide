import React, { useEffect, useRef, useState } from 'react';
import { Monitor, MousePointer2, RefreshCw, X, Sparkles, AlertTriangle } from 'lucide-react';
import { useLayoutStore } from '../../store/layoutStore';
import { useChatStore } from '../../store/chatStore';

/**
 * 预览即源码（W20）
 *
 * 面板内嵌用户本地 dev server（webview，跨源也能注入脚本），
 * 点「选取元素」后进入拾取模式：悬停高亮 DOM 元素，点击把它的一切
 * 可定位信息（选择器链 / 类名 / 文本 / 计算样式）回传给 Agent，
 * 用户在浮层里输入一句自然语言需求，Agent 负责在源码里定位并修改。
 *
 * 之所以不让主进程去注入而是走 webview.executeJavaScript：
 * dev server 与渲染层不同源，iframe 拿不到内容文档；
 * webview 是独立进程，可以注入且不影响主窗口隔离。
 */

const URL_KEY = 'cnke.preview.url';
const DEFAULT_URL = 'http://localhost:5173';
/** 注入脚本通过 console.log 前缀回传选中元素，宿主用 console-message 事件接收 */
const PICK_PREFIX = '__CNKE_PICK__';

interface PickedElement {
  selector: string;
  tag: string;
  id: string;
  className: string;
  text: string;
  html: string;
  rect: { w: number; h: number };
  styles: Record<string, string>;
}

const PICK_SCRIPT = `
(() => {
  if (window.__cnkePickActive) return;
  window.__cnkePickActive = true;

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #8b5cf6;background:rgba(139,92,246,0.12);border-radius:2px;';
  document.documentElement.appendChild(box);

  const move = (e) => {
    const el = e.target;
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  };

  const describe = (el) => {
    const chain = [];
    let cur = el;
    for (let i = 0; i < 4 && cur && cur.nodeType === 1; i++) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) {
        s += '#' + cur.id;
      } else if (typeof cur.className === 'string' && cur.className.trim()) {
        s += '.' + cur.className.trim().split(/\\s+/).slice(0, 2).join('.');
      }
      chain.unshift(s);
      cur = cur.parentElement;
    }
    const cs = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      selector: chain.join(' > '),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      text: (el.innerText || el.textContent || '').trim().slice(0, 120),
      html: (el.outerHTML || '').slice(0, 600),
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      styles: {
        color: cs.color,
        background: cs.backgroundColor,
        borderRadius: cs.borderRadius,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        padding: cs.padding,
        margin: cs.margin
      }
    };
  };

  const cleanup = () => {
    window.__cnkePickActive = false;
    box.remove();
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', key, true);
  };

  const click = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const info = describe(e.target);
    console.log('${PICK_PREFIX}' + JSON.stringify(info));
    cleanup();
  };

  const key = (e) => {
    if (e.key === 'Escape') {
      console.log('${PICK_PREFIX}' + JSON.stringify({ cancel: true }));
      cleanup();
    }
  };

  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', key, true);
  window.__cnkePickCleanup = cleanup;
})();
`;

const CANCEL_SCRIPT = `window.__cnkePickCleanup && window.__cnkePickCleanup();`;

/** webview 是 Electron 私有标签，DOM 类型里没有 executeJavaScript */
type WebviewElement = HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> };

const PreviewPanel: React.FC = () => {
  const setPanelVisible = useLayoutStore((s) => s.setPanelVisible);
  const activeWorkspaceId = useChatStore((s) => s.activeWorkspaceId);

  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) || DEFAULT_URL);
  const [draft, setDraft] = useState(() => localStorage.getItem(URL_KEY) || DEFAULT_URL);
  const [pickMode, setPickMode] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const webviewRef = useRef<WebviewElement | null>(null);

  // 监听注入脚本回传的选中元素
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onConsole = (e: Event) => {
      const message = (e as Event & { message?: string }).message ?? '';
      if (!message.startsWith(PICK_PREFIX)) return;
      try {
        const data = JSON.parse(message.slice(PICK_PREFIX.length)) as PickedElement & { cancel?: boolean };
        setPickMode(false);
        if (data.cancel) return;
        setPicked(data);
        setInstruction('');
      } catch {
        /* 非本模块输出，忽略 */
      }
    };
    const onFail = () => setFailed(true);
    const onReady = () => {
      setFailed(false);
      // 页面刷新后拾取模式会丢失，若用户仍处于拾取态则重新注入
      if (pickMode) void wv.executeJavaScript(PICK_SCRIPT).catch(() => undefined);
    };
    wv.addEventListener('console-message', onConsole);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('dom-ready', onReady);
    return () => {
      wv.removeEventListener('console-message', onConsole);
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('dom-ready', onReady);
    };
  }, [pickMode]);

  const go = (next?: string) => {
    const target = (next ?? draft).trim();
    if (!target) return;
    const normalized = /^https?:\/\//.test(target) ? target : `http://${target}`;
    setUrl(normalized);
    setDraft(normalized);
    localStorage.setItem(URL_KEY, normalized);
    setFailed(false);
    setPicked(null);
    setPickMode(false);
  };

  const reload = () => {
    setFailed(false);
    if (webviewRef.current) void webviewRef.current.executeJavaScript('location.reload();').catch(() => undefined);
  };

  const togglePick = async () => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (pickMode) {
      await wv.executeJavaScript(CANCEL_SCRIPT).catch(() => undefined);
      setPickMode(false);
      return;
    }
    try {
      await wv.executeJavaScript(PICK_SCRIPT);
      setPickMode(true);
      setPicked(null);
    } catch {
      setFailed(true);
    }
  };

  const buildPrompt = (el: PickedElement, ask: string) => {
    const styles = Object.entries(el.styles)
      .filter(([, v]) => v)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');
    return [
      '【预览即源码】我在内嵌预览里选中了一个页面元素，请修改它。',
      '',
      `页面：${url}`,
      `选择器：${el.selector}`,
      `标签：<${el.tag}>${el.id ? ` id="${el.id}"` : ''}${el.className ? ` class="${el.className}"` : ''}`,
      el.text ? `可见文本：${el.text}` : '',
      `尺寸：${el.rect.w}×${el.rect.h}px`,
      '当前计算样式：',
      styles,
      '',
      '元素 HTML 片段：',
      '```html',
      el.html,
      '```',
      '',
      `我的要求：${ask}`,
      '',
      '请先用 search_files / grep 在源码中找到渲染这个元素的组件或它的样式定义，再修改。',
      '不要新建文件，不要凭猜测复制一份实现。改完后简要说明改了哪个文件。',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const submit = async () => {
    if (!picked || !instruction.trim() || sending) return;
    if (!activeWorkspaceId) return;
    setSending(true);
    try {
      await useChatStore.getState().sendMessage(buildPrompt(picked, instruction.trim()), activeWorkspaceId);
      setPanelVisible('chat', true);
      setPicked(null);
      setInstruction('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* 头部：与编辑器 / 终端保持一致的标题栏 */}
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border bg-secondary/20 shrink-0">
        <span className="flex items-center gap-1.5 text-[11px] text-foreground/80 font-medium">
          <Monitor className="w-3 h-3 text-primary" />
          预览
        </span>
        <button
          onClick={() => setPanelVisible('preview', false)}
          className="p-1 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-colors"
          title="隐藏预览"
          aria-label="隐藏预览"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* 地址栏 + 操作 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
          spellCheck={false}
          placeholder="http://localhost:5173"
          className="flex-1 min-w-0 px-2 py-1 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary"
        />
        <button
          onClick={reload}
          className="p-1 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-colors"
          title="刷新预览"
          aria-label="刷新预览"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void togglePick()}
          className={`flex items-center gap-1 px-1.5 py-1 rounded text-[10px] transition-colors ${
            pickMode
              ? 'bg-violet-500/25 text-violet-100'
              : 'hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground'
          }`}
          title="在预览里点选元素，然后让 AI 修改它的源码"
        >
          <MousePointer2 className="w-3.5 h-3.5" />
          {pickMode ? '点击页面元素…' : '选取元素'}
        </button>
      </div>

      {/* 拾取后的指令浮层 */}
      {picked && (
        <div className="px-2 py-1.5 border-b border-violet-500/25 bg-violet-500/10 shrink-0">
          <div className="flex items-center gap-1.5 text-[10px] text-violet-200 truncate">
            <Sparkles className="w-3 h-3 shrink-0" />
            <span className="font-mono truncate">{picked.selector}</span>
            {picked.text && <span className="text-violet-300/70 truncate">“{picked.text}”</span>}
          </div>
          <div className="flex items-center gap-1 mt-1">
            <input
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
                if (e.key === 'Escape') setPicked(null);
              }}
              placeholder="想怎么改？例如：圆角改成 12px、背景换成主色"
              className="flex-1 min-w-0 px-2 py-1 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-violet-500"
            />
            <button
              onClick={() => void submit()}
              disabled={!instruction.trim() || sending || !activeWorkspaceId}
              className="px-2 py-1 rounded text-[10px] bg-violet-500/25 hover:bg-violet-500/40 text-violet-100 disabled:opacity-40 transition-colors"
            >
              {sending ? '发送中…' : '让 AI 修改'}
            </button>
            <button
              onClick={() => setPicked(null)}
              className="p-1 rounded hover:bg-muted-foreground/20 text-muted-foreground"
              title="取消"
              aria-label="取消选择"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* 预览主体 */}
      <div className="relative flex-1 overflow-hidden bg-white">
        {failed && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background text-center px-6">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <p className="text-[11px] text-foreground">无法加载 {url}</p>
            <p className="text-[10px] text-muted-foreground">
              请先在终端启动 dev server（如 <span className="font-mono">npm run dev</span>），再刷新预览。
            </p>
          </div>
        )}
        <webview
          ref={(el) => {
            webviewRef.current = (el as unknown as WebviewElement) ?? null;
          }}
          src={url}
          className="w-full h-full"
          style={{ display: 'inline-flex' }}
        />
      </div>
    </div>
  );
};

export default PreviewPanel;
