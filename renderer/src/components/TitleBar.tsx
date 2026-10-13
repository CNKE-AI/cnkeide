import React, { useEffect, useState } from 'react';
import { useApp } from '../store/AppProvider';
import { useThemeStore } from '../store/themeStore';
import { Minus, Square, X, FolderOpen, Settings, Sun, Moon, Copy, ShieldAlert } from 'lucide-react';

/** 窗口保护提示条的停留时长（ms） */
const GUARD_NOTICE_DURATION = 2600;

const TitleBar: React.FC = () => {
  const { workspacePath, setWorkspacePath, setSettingsOpen } = useApp();
  const { theme, toggleTheme } = useThemeStore();
  const [maximized, setMaximized] = useState(false);
  /** 窗口保护提示（AI 任务执行中尝试最小化/关闭被拦截时显示） */
  const [guardNotice, setGuardNotice] = useState('');

  useEffect(() => {
    setMaximized(window.cnke.window.isMaximized());
    const off = window.cnke.window.onMaximizedChange((m) => setMaximized(m));
    return off;
  }, []);

  // 订阅主进程「窗口保护」提示，短暂显示后自动消失
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.cnke.window.onGuardNotice(({ reason }) => {
      setGuardNotice(reason);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setGuardNotice(''), GUARD_NOTICE_DURATION);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, []);

  const handleOpenFolder = async () => {
    const p = await window.cnke.fs.openFolder();
    if (p) setWorkspacePath(p);
  };
  const dragStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  /** macOS 使用 hiddenInset，红绿灯按钮在左侧，需留出安全内边距 */
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  return (
    <div className="flex flex-col select-none shrink-0">
      {/* 顶部渐变炫彩细条 */}
      <div className="h-[2.5px] w-full brand-bar" />
      <div
        className="relative flex items-center justify-between h-9 bg-secondary/40 backdrop-blur-sm border-b border-border"
        style={dragStyle}
      >
        <div className={`flex items-center gap-2 px-3 ${isMac ? 'pl-20' : ''}`} style={noDragStyle}>
          <div className="w-5 h-5 rounded-md flex items-center justify-center overflow-hidden ring-1 ring-border/60">
            <img src="./logo.png" alt="CnkeIDE" className="w-5 h-5 object-contain" />
          </div>
          <span className="text-sm font-bold brand-gradient">CnkeIDE</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gradient-to-r from-cyan-500/15 to-violet-500/15 border border-violet-400/30 text-violet-300 font-medium">
            AI IDE
          </span>
          {workspacePath && (
            <span
              className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground ml-1 max-w-[320px] truncate"
              title={workspacePath}
            >
              <span className="w-px h-3 bg-border" />
              {workspacePath}
            </span>
          )}
        </div>

        {/* 窗口保护提示：绝对定位居中，避免撑动标题栏布局 */}
        {guardNotice && (
          <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[11px] whitespace-nowrap">
            <ShieldAlert className="w-3 h-3 shrink-0" />
            {guardNotice}
          </div>
        )}

        <div className="flex items-center gap-0.5 pr-1" style={noDragStyle}>
          <button onClick={handleOpenFolder} className="icon-btn" title="打开文件夹 (Ctrl+O)">
            <FolderOpen className="w-4 h-4" />
          </button>
          <button
            onClick={toggleTheme}
            className="icon-btn"
            title={theme === 'dark' ? '切换为白色主题' : '切换为深色主题'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button onClick={() => setSettingsOpen(true)} className="icon-btn" title="设置">
            <Settings className="w-4 h-4" />
          </button>

          {/* macOS 使用系统红绿灯，隐藏自绘窗口按钮 */}
          {!isMac && (
            <>
              <div className="w-px h-4 bg-border mx-1" />
              <button
                onClick={() => window.cnke.window.minimize()}
                className="icon-btn"
                title="最小化"
                aria-label="最小化"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => window.cnke.window.toggleMaximize()}
                className="icon-btn"
                title={maximized ? '还原' : '最大化'}
                aria-label={maximized ? '还原' : '最大化'}
              >
                {maximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
              </button>
              <button
                onClick={() => window.cnke.window.close()}
                className="icon-btn hover:!bg-red-500/80 hover:!text-white"
                title="关闭"
                aria-label="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default TitleBar;
