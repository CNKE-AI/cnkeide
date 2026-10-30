import React, { useEffect, useState, useCallback } from 'react';
import { AppProvider } from './store/AppProvider';
import MainLayout from './components/MainLayout';
import ToastHost from './components/chat/ToastHost';
import { applyTheme, useThemeStore } from './store/themeStore';
import { X, Sparkles } from 'lucide-react';

/** 更新公告弹窗：启动时检测是否刚完成更新，若是则弹出 releasenotes 内容 */
const UpdateAnnouncement: React.FC = () => {
  const [show, setShow] = useState(false);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const v = await window.cnke.update.checkAnnouncement();
        if (!mounted || !v) return;
        setVersion(v);
        setLoading(true);
        setShow(true);
        const text = await window.cnke.update.getReleaseNotes();
        if (!mounted) return;
        setNotes(text || '暂无更新说明');
      } catch {
        // 静默失败，不打扰用户
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const close = useCallback(() => setShow(false), []);
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={close}>
      <div
        className="relative w-[560px] max-h-[80vh] bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-cyan-500/15 to-violet-500/15 border-b border-zinc-700">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-5 h-5 text-cyan-400" />
            <span className="text-base font-bold text-zinc-100">更新公告</span>
            {version && <span className="text-xs text-cyan-300 font-medium">v{version}</span>}
          </div>
          <button onClick={close} className="text-zinc-500 hover:text-zinc-200 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-zinc-500">正在加载更新说明…</div>
          ) : (
            <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">{notes}</pre>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-700 flex justify-end">
          <button
            onClick={close}
            className="px-4 py-1.5 text-sm bg-gradient-to-r from-cyan-500 to-violet-500 text-white rounded-md hover:opacity-90 transition-opacity"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <AppProvider>
      <MainLayout />
      <UpdateAnnouncement />
      {/* 挂在根节点：对话面板被折叠/卸载时，设置页等其它入口的提示也不会丢 */}
      <ToastHost />
    </AppProvider>
  );
};

export default App;
