import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../store/uiStore';
import { useChatStore } from '../../store/chatStore';
import { Cpu, Check, ChevronDown, Search, Sparkles, Loader2, AlertCircle } from 'lucide-react';

const ModelSwitcher: React.FC = () => {
  const { models, activeModelId, modelSelectionMode, routingEnabled, modelDecision, modelSwitching, modelError, refreshModels, switchModel } = useUiStore();
  const sessionId = useChatStore((s) => s.sessionId);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);

  useEffect(() => { void refreshModels(); }, [refreshModels]);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(328, window.innerWidth - 16);
      const above = r.top - 14;
      const below = window.innerHeight - r.bottom - 14;
      const up = above >= below;
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
        width, maxHeight: Math.min(480, Math.max(80, up ? above : below)),
        ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      });
    };
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    };
    update();
    const observer = new ResizeObserver(update);
    if (triggerRef.current) observer.observe(triggerRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const positioned = !!pos;
  useEffect(() => {
    if (open && positioned) searchRef.current?.focus();
  }, [open, positioned]);

  const auto = modelSelectionMode === 'auto';
  const active = models.find((m) => m.id === activeModelId);
  const enabledCount = models.filter((m) => !m.disabled).length;
  const visible = models.filter((m) => `${m.name} ${m.model} ${m.provider || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const decision = modelDecision?.sessionId === sessionId ? modelDecision : null;
  const select = async (id: string) => {
    await switchModel(id);
    if (!useUiStore.getState().modelError) { setOpen(false); triggerRef.current?.focus(); }
  };
  const navigate = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button[data-model-option]:not(:disabled)') || []);
    if (!buttons.length) return;
    e.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? (e.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="选择模型"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={auto ? (routingEnabled ? 'AUTO：优先选择实测首字响应最快的可用模型' : 'AUTO 路由已暂停，使用固定模型') : `固定模型：${active?.name || '未配置'}`}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) { setQuery(''); void refreshModels(); }
        }}
        className={`flex items-center gap-1 min-w-0 min-h-[24px] max-w-[190px] px-2 py-[3px] rounded-[7px] border model-pill transition-colors ios-press ${auto ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border bg-secondary/40 text-foreground hover:bg-accent'}`}
      >
        {modelSwitching ? <Loader2 className="w-3 h-3 shrink-0 animate-spin" /> : auto ? <Sparkles className="w-3 h-3 shrink-0" /> : <Cpu className="w-3 h-3 shrink-0" />}
        <span className="truncate font-medium">{auto ? (routingEnabled ? 'AUTO' : 'AUTO · 已暂停') : active?.name || active?.model || '选择模型'}</span>
        <ChevronDown className={`w-2.5 h-2.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} id={panelId} role="dialog" aria-label="模型选择" aria-busy={modelSwitching} onKeyDown={navigate}
          style={{ position: 'fixed', ...pos, zIndex: 9999 }}
          className="overlay-panel flex flex-col overflow-y-auto text-popover-foreground">
          <div className="flex items-center justify-between px-3.5 pt-3 pb-2 shrink-0">
            <span className="text-sm font-semibold">选择模型</span>
            <span className="text-[11px] text-muted-foreground">{enabledCount} 个可用</span>
          </div>
          <div className="px-2 pb-2 shrink-0">
            <button type="button" data-model-option aria-pressed={auto} disabled={!enabledCount || modelSwitching}
              onClick={() => void select('auto')}
              className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${auto ? 'border-primary/30 bg-primary/10' : 'border-border hover:bg-accent'}`}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"><Sparkles className="w-4 h-4" /></span>
              <span className="flex-1 min-w-0"><span className="block text-xs font-semibold">AUTO <span className="ml-1 font-normal text-muted-foreground">智能选择</span></span><span className="mt-1 block text-[11px] text-muted-foreground">内置模型按实测首字耗时优先；无样本时使用快速档，下次发送生效</span></span>
              {auto && <Check className="w-4 h-4 shrink-0 text-primary" />}
            </button>
          </div>
          <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-input bg-background px-2.5 shrink-0 focus-within:border-primary">
            <Search className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索模型" placeholder="搜索名称、模型或提供方"
              className="min-w-0 w-full bg-transparent py-2 text-xs outline-none focus-visible:outline-none placeholder:text-muted-foreground" />
          </div>
          <div className="px-3.5 py-1 text-[11px] text-muted-foreground shrink-0">固定模型</div>
          <div className="min-h-[48px] overflow-y-auto px-2 pb-2">
            {visible.map((m) => {
              const selected = !auto && m.id === activeModelId;
              return <button key={m.id} type="button" data-model-option aria-pressed={selected} disabled={m.disabled || modelSwitching}
                title={`${m.name || m.model} · ${m.model}${m.disabled ? '（已禁用）' : ''}`} onClick={() => void select(m.id)}
                className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${selected ? 'bg-primary/10 text-foreground' : 'hover:bg-accent text-foreground'}`}>
                <Cpu className={`w-3.5 h-3.5 shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground'}`} />
                <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="block truncate text-xs font-medium">{m.name || m.model}</span>{!m.builtin && <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[9px] text-muted-foreground" title="自定义配置，不参与 AUTO 路由">自定义</span>}</span><span className="block truncate text-[11px] text-muted-foreground">{m.model}{m.provider ? ` · ${m.provider}` : ''}</span></span>
                {m.disabled ? <span className="text-[10px] shrink-0 text-muted-foreground">已禁用</span> : selected && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
              </button>;
            })}
            {!visible.length && <p className="px-3 py-5 text-center text-xs text-muted-foreground">{models.length ? '没有匹配的模型' : '暂无模型，请到设置中添加 API 配置'}</p>}
          </div>
          {modelError && <div role="alert" className="mx-3 mb-2 flex gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-foreground"><AlertCircle className="w-4 h-4 shrink-0 text-red-500" /><span>{modelError}</span></div>}
          <div className="border-t border-border bg-secondary/30 px-3.5 py-2.5 text-[11px] text-muted-foreground shrink-0">
            {auto && !routingEnabled ? <p>AUTO 已暂停，再次选择 AUTO 可恢复。</p> : decision ? <><p className="truncate" title={decision.model}>本轮模型：<span className="font-medium text-foreground">{decision.model}</span></p><p className="mt-1 break-words">{decision.reason}</p></> : <p>固定选择保留为备用；切换不打断当前任务。</p>}
          </div>
        </div>, document.body
      )}
    </div>
  );
};

export default ModelSwitcher;
