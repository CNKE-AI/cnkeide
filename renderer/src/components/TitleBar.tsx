import React, { useEffect, useState } from 'react';
import { useApp } from '../store/AppProvider';
import { useThemeStore } from '../store/themeStore';
import { Minus, Square, X, FolderOpen, Settings, Sun, Moon, Copy } from 'lucide-react';

const TitleBar: React.FC = () => {
  const { workspacePath, setWorkspacePath, setSettingsOpen } = useApp();
  const { theme, toggleTheme } = useThemeStore();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    setMaximized(window.cnke.window.isMaximized());
    const off = window.cnke.window.onMaximizedChange((m) => setMaximized(m));
    return off;
  }, []);
  const handleOpenFolder = async () => {
    const p = await window.cnke.fs.openFolder();
    if (p) setWorkspacePath(p);
  };
  const dragStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
  return (
    <div className="flex flex-col select-none shrink-0">
      {/* 顶部渐变炫彩细条 */}
      <div className="h-[2.5px] w-full brand-bar" />
      <div className="flex items-center justify-between h-9 bg-secondary/40 backdrop-blur-sm border-b border-border" style={dragStyle}>
        <div className="flex items-center gap-2 px-3" style={noDragStyle}>
          <div className="w-5 h-5 rounded-md flex items-center justify-center overflow-hidden">
            <img src="./logo.png" alt="CnkeIDE" className="w-5 h-5 object-contain" />
          </div>
          <span className="text-sm font-bold brand-gradient">CnkeIDE</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gradient-to-r from-cyan-500/15 to-violet-500/15 border border-violet-400/30 text-violet-300 font-medium">AI IDE</span>
          {workspacePath && (
            <span className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground ml-1 max-w-[320px] truncate">
              <span className="w-px h-3 bg-border" />
              {workspacePath}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 pr-1" style={noDragStyle}>
          <button onClick={handleOpenFolder} className="p-1.5 hover:bg-accent hover:text-cyan-300 rounded-md transition-colors" title="打开文件夹"><FolderOpen className="w-4 h-4" /></button>
          <button onClick={toggleTheme} className="p-1.5 hover:bg-accent rounded-md transition-colors" title={theme === 'dark' ? '切换为白色主题' : '切换为深色主题'}>
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button onClick={() => setSettingsOpen(true)} className="p-1.5 hover:bg-accent rounded-md transition-colors" title="设置"><Settings className="w-4 h-4" /></button>
          <div className="w-px h-4 bg-border mx-1" />
          <button onClick={() => window.cnke.window.minimize()} className="p-1.5 hover:bg-accent rounded-md transition-colors"><Minus className="w-3.5 h-3.5" /></button>
          <button onClick={() => window.cnke.window.toggleMaximize()} className="p-1.5 hover:bg-accent rounded-md transition-colors" title={maximized ? '还原' : '最大化'}>
            {maximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
          </button>
          <button onClick={() => window.cnke.window.close()} className="p-1.5 hover:bg-red-500/80 hover:text-white rounded-md transition-colors"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>
    </div>
  );
};

export default TitleBar;
