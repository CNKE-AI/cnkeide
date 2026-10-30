import React, { useEffect, useState } from 'react';
import { useApp } from '../store/AppProvider';
import { nextTheme, THEMES, useThemeStore } from '../store/themeStore';
import { Minus, Square, X, FolderOpen, Settings, Sun, Moon, Palette, Copy, ShieldAlert, BarChart3 } from 'lucide-react';

/** 窗口保护提示条的停留时长（ms） */
const GUARD_NOTICE_DURATION = 2600;

const TitleBar: React.FC = () => {
  const { workspacePath, setWorkspacePath, setSettingsOpen, activePage, setActivePage } = useApp();
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
      {/* 顶部渐变炫彩细条：压到 2px 并降饱和，避免抢标题栏的视觉重心 */}
      <div className="h-[2px] w-full brand-bar opacity-80" />
      {/*
        标题栏：整条毛玻璃。它压在环境光之上，因此拖窗时能看到背后的柔光流动，
        与下方内容面板形成"同一张玻璃桌面上摞纸片"的层次关系。
      */}
      <div
        className="titlebar relative flex items-center justify-between h-10 backdrop-blur-glass"
        style={dragStyle}
      >
        <div className={`flex items-center gap-2 px-3 ${isMac ? 'pl-20' : ''}`} style={noDragStyle}>
          <div className="w-[22px] h-[22px] rounded-[7px] flex items-center justify-center overflow-hidden ring-1 ring-white/15 shadow-soft">
            <img src="./logo.png" alt="CnkeIDE" className="w-[22px] h-[22px] object-contain" />
          </div>
          <span className="text-[13.5px] font-semibold tracking-[0.01em] brand-gradient">CnkeIDE</span>
          <span className="app-brand-sub text-[10.5px] px-2 py-[2px] rounded-pill bg-white/[0.07] border border-white/10 text-violet-200/90 font-medium shadow-inner-hair">
            AI IDE
          </span>
          {workspacePath && (
            <span
              className="hidden md:flex items-center gap-1.5 text-[11.5px] text-muted-foreground/85 ml-1 max-w-[320px] truncate px-2 py-[3px] rounded-lg bg-white/[0.04] border border-white/[0.07]"
              title={workspacePath}
            >
              {workspacePath}
            </span>
          )}
        </div>

        {/* 窗口保护提示：绝对定位居中，避免撑动标题栏布局 */}
        {guardNotice && (
          <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1 rounded-pill bg-amber-400/15 border border-amber-300/30 text-amber-200 text-[11.5px] whitespace-nowrap shadow-float backdrop-blur-glass animate-pop-in">
            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            {guardNotice}
          </div>
        )}

        <div className="flex items-center gap-0.5 pr-1" style={noDragStyle}>
          <button onClick={handleOpenFolder} className="icon-btn" title="打开文件夹 (Ctrl+O)">
            <FolderOpen className="w-4 h-4" />
          </button>
          <button
            onClick={() => setActivePage(activePage === 'stats' ? 'ide' : 'stats')}
            className={`icon-btn ${activePage === 'stats' ? '!text-violet-300 !bg-violet-500/15' : ''}`}
            title="历史统计看板（用量趋势 / 指标 / 明细）"
            aria-label="历史统计看板"
          >
            <BarChart3 className="w-4 h-4" />
          </button>
          <button
            onClick={toggleTheme}
            className="icon-btn"
            title={`当前：${THEMES.find((item) => item.id === theme)?.label}；切换为${THEMES.find((item) => item.id === nextTheme(theme))?.label}`}
            aria-label={`切换主题：${THEMES.find((item) => item.id === nextTheme(theme))?.label}`}
          >
            {THEMES.find((item) => item.id === nextTheme(theme))?.scheme === 'light' ? <Sun className="w-4 h-4" /> : nextTheme(theme) === 'dark' ? <Moon className="w-4 h-4" /> : <Palette className="w-4 h-4" />}
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
