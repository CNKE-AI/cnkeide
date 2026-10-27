import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info, CheckCircle2, AlertCircle } from 'lucide-react';
import { subscribeToast, ToastItem } from '../../utils/toast';

const STYLE: Record<ToastItem['kind'], { icon: React.ReactNode; cls: string }> = {
  info: {
    icon: <Info className="h-3.5 w-3.5 shrink-0 text-sky-400" />,
    cls: 'border-sky-500/30 bg-sky-500/10 text-sky-100',
  },
  success: {
    icon: <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />,
    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100',
  },
  error: {
    icon: <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />,
    cls: 'border-rose-500/30 bg-rose-500/10 text-rose-100',
  },
};

/** Toast 容器：挂在 ChatPanel 内一次即可（对话面板常驻，其它面板都在其下） */
const ToastHost: React.FC = () => {
  const [list, setList] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToast(setList), []);

  if (list.length === 0) return null;

  return createPortal(
    <div className="fixed bottom-6 right-6 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col-reverse gap-2 pointer-events-none">
      {list.map((t) => (
        /* 只留语义色背景：同时写 bg-popover 与 bg-sky-500/10 时哪个生效取决于
           Tailwind 的生成顺序，结果不可控 */
        <div
          key={t.id}
          role="status"
          className={`toast-in flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px] leading-relaxed shadow-xl backdrop-blur-md ${STYLE[t.kind].cls}`}
        >
          <span className="mt-[1px]">{STYLE[t.kind].icon}</span>
          <span className="min-w-0 break-words">{t.text}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
};

export default ToastHost;
