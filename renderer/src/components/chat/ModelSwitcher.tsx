import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../store/uiStore';
import { Cpu, Check } from 'lucide-react';

/** 模型快速切换下拉：直接切换 active API 配置，无需进设置页 */
const ModelSwitcher: React.FC = () => {
  const { models, activeModelId, refreshModels, switchModel } = useUiStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // 注意：下拉面板通过 createPortal 渲染到 document.body，不在 ref.current 的
      // DOM 子树内。若只判断 ref，点击选项时 mousedown 会先关闭面板 → React 卸载
      // 面板 → click 派发时按钮已被移除 → onClick 永不触发（表现为"点了没反应"）。
      // 因此必须把面板 DOM 一并纳入"内部"判断。
      const panel = document.getElementById('model-switcher-panel');
      const inside = (ref.current && ref.current.contains(t)) || (panel != null && panel.contains(t));
      if (!inside) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  // 打开时根据按钮位置计算向上弹出的坐标（现在位于输入框下方、靠近窗口底部，向下展开会被裁剪）
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const panelW = 224;
      const maxH = Math.max(120, r.top - 12);
      let left = r.left;
      if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
      setPos({ top: r.top - 6, left, maxHeight: maxH });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const active = models.find((m) => m.id === activeModelId);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-border hover:bg-accent/60 transition-colors text-[11px] text-muted-foreground max-w-[180px]"
        title="切换模型"
      >
        <Cpu className="w-3 h-3 text-cyan-400 shrink-0" />
        <span className="truncate">{active?.name || active?.model || '选择模型'}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            id="model-switcher-panel"
            style={{
              position: 'fixed',
              left: pos.left,
              bottom: window.innerHeight - pos.top,
              width: 224,
              maxHeight: pos.maxHeight,
              zIndex: 9999,
            }}
            className="bg-card border border-border rounded-lg shadow-xl overflow-y-auto"
          >
            <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground border-b border-border uppercase tracking-wider">
              模型
            </div>
            {models.length === 0 && (
              <div className="px-2.5 py-3 text-[11px] text-muted-foreground/60 text-center">
                暂无模型配置，请到设置中添加
              </div>
            )}
            {models.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  switchModel(m.id);
                  setOpen(false);
                }}
                disabled={m.disabled}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-left transition-colors ${
                  m.id === activeModelId
                    ? 'bg-primary/15 text-foreground'
                    : 'text-foreground/80 hover:bg-accent/60'
                } ${m.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <span className="flex-1 truncate">{m.name || m.model}</span>
                {m.model && m.name !== m.model && (
                  <span className="text-[10px] text-muted-foreground/60 truncate max-w-[90px]">{m.model}</span>
                )}
                {m.id === activeModelId && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
};

export default ModelSwitcher;
