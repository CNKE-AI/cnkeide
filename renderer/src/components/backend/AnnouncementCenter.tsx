import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, AlertTriangle, Info, AlertOctagon } from 'lucide-react';

interface Announcement {
  id: string;
  title: string;
  content: string;
  type: 'info' | 'warning' | 'urgent';
  once: boolean;
}

/**
 * 远程公告中心：启动时从官方服务器拉取公告并弹出。
 * - once=true 的公告本地记录已读，不重复弹出
 * - 类型样式：info 青 / warning 琥珀 / urgent 红
 */
const STYLE: Record<string, { icon: React.ReactNode; border: string; badge: string; bar: string; label: string }> = {
  info: {
    icon: <Info className="w-5 h-5 text-cyan-400" />,
    border: 'border-cyan-400/30',
    badge: 'bg-cyan-500/15 text-cyan-300 border-cyan-400/30',
    bar: 'from-cyan-500/60 via-violet-500/60 to-fuchsia-500/60',
    label: '公告',
  },
  warning: {
    icon: <AlertTriangle className="w-5 h-5 text-amber-400" />,
    border: 'border-amber-400/30',
    badge: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
    bar: 'from-amber-500/70 via-orange-500/70 to-red-500/70',
    label: '警告',
  },
  urgent: {
    icon: <AlertOctagon className="w-5 h-5 text-red-400" />,
    border: 'border-red-500/30',
    badge: 'bg-red-500/15 text-red-300 border-red-500/30',
    bar: 'from-red-600/80 to-rose-600/80',
    label: '紧急',
  },
};

const AnnouncementCenter: React.FC = () => {
  const [queue, setQueue] = useState<Announcement[]>([]);
  const shownRef = useRef(false);

  const dismiss = useCallback((id: string, once: boolean) => {
    setQueue((q) => q.filter((a) => a.id !== id));
    if (once) {
      window.cnke.config.get('readAnnouncementIds').then((list: string[]) => {
        const ids = list || [];
        if (!ids.includes(id)) window.cnke.config.set('readAnnouncementIds', [...ids, id]);
      });
    }
  }, []);

  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;

    // 拉取公告并（过滤已读 once 后）入队
    const mergeAnnouncements = async (anns: Announcement[]) => {
      if (!anns || anns.length === 0) return;
      try {
        const readRaw = await window.cnke.config.get('readAnnouncementIds');
        const read = readRaw || [];
        const fresh = anns.filter((a) => !(a.once && read.includes(a.id)));
        if (fresh.length > 0) {
          setQueue((q) => {
            // 去重：已存在的 id 不重复入队
            const existing = new Set(q.map((a) => a.id));
            const add = fresh.filter((a) => !existing.has(a.id));
            return [...q, ...add].slice(0, 8);
          });
        }
      } catch { /* 静默 */ }
    };

    // 1. 启动时主动拉取一次（兜底，SSE 未建立或错过事件时仍能弹出）
    (async () => {
      try {
        const res = await window.cnke.backend.getAnnouncements();
        if (res.success) await mergeAnnouncements(res.announcements || []);
      } catch { /* 网络不可用则静默 */ }
    })();

    // 2. 订阅 SSE 实时推送：服务端公告变化即时弹出
    let unsubscribe: (() => void) | null = null;
    (async () => {
      try {
        const sub = await window.cnke.backend.subscribeAnnouncements();
        if (!sub?.success) return;
        unsubscribe = window.cnke.backend.onAnnouncement((payload) => {
          if (payload?.type === 'announcements' && payload.announcements) {
            void mergeAnnouncements(payload.announcements);
          }
        });
      } catch { /* 订阅失败则仅依赖启动拉取 */ }
    })();

    return () => {
      try { unsubscribe?.(); } catch {}
    };
  }, []);

  const current = queue[0];
  if (!current) return null;
  const s = STYLE[current.type] || STYLE.info;

  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className={`w-[460px] max-w-[92vw] bg-card border ${s.border} rounded-xl shadow-2xl overflow-hidden`}>
        {/* 顶部渐变条 */}
        <div className={`h-1 w-full bg-gradient-to-r ${s.bar}`} />
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5">{s.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${s.badge}`}>{s.label}</span>
                <h3 className="text-sm font-semibold">{current.title || 'CnkeIDE 公告'}</h3>
              </div>
              <div
                className="mt-2.5 text-xs text-foreground/85 leading-relaxed max-h-[260px] overflow-y-auto pr-1 [&_a]:text-cyan-400 [&_a]:underline"
                dangerouslySetInnerHTML={{ __html: current.content }}
              />
              <div className="flex items-center justify-end gap-2 mt-4">
                {queue.length > 1 && (
                  <span className="text-[10px] text-muted-foreground mr-auto">{queue.length} 条公告</span>
                )}
                <button
                  onClick={() => dismiss(current.id, current.once)}
                  className="px-4 py-1.5 text-xs border border-border rounded-md hover:bg-accent/60 transition-colors"
                >
                  我知道了
                </button>
              </div>
            </div>
            <button onClick={() => dismiss(current.id, current.once)} className="p-1 hover:bg-accent rounded transition-colors shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnnouncementCenter;
