import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useApp } from '../../store/AppProvider';
import { useLayoutStore } from '../../store/layoutStore';
import { Terminal, Trash2, Loader2, X } from 'lucide-react';

interface TerminalLine {
  id: number;
  text: string;
}

const MAX_LINES = 800;

const TerminalPanel: React.FC = () => {
  const { workspacePath } = useApp();
  const setPanelVisible = useLayoutStore((s) => s.setPanelVisible);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [pid, setPid] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lineIdRef = useRef(0);
  const pidRef = useRef<number | null>(null);
  const cwdRef = useRef<string | null>(null);
  // 累积输出片段，按行切分
  const pendingRef = useRef('');

  const appendText = useCallback((text: string) => {
    pendingRef.current += text;
    // 拆成行，保留最后一个未完整行
    const parts = pendingRef.current.split('\n');
    pendingRef.current = parts.pop() ?? '';
    if (parts.length > 0) {
      setLines((prev) => {
        const next = [
          ...prev,
          ...parts.map((p) => ({ id: ++lineIdRef.current, text: p.replace(/\r$/, '') })),
        ];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }
  }, []);

  // 启动 shell
  const startShell = useCallback(async () => {
    const cwd = workspacePath;
    if (!cwd) return;
    cwdRef.current = cwd;
    const res = await window.cnke.terminal.spawn('', [], cwd);
    if (!res.success || res.pid == null) {
      setLines((prev) => [...prev, { id: ++lineIdRef.current, text: `启动终端失败: ${res.error}` }]);
      return;
    }
    pidRef.current = res.pid;
    setPid(res.pid);
    setRunning(true);
  }, [workspacePath]);

  // 订阅输出与退出
  useEffect(() => {
    const offOutput = window.cnke.terminal.onOutput((data) => {
      if (pidRef.current != null && data.pid === pidRef.current) {
        appendText(data.data);
      }
    });
    const offExit = window.cnke.terminal.onExit((data) => {
      if (pidRef.current != null && data.pid === pidRef.current) {
        appendText(`\n[进程已退出，code=${data.code}]`);
        pidRef.current = null;
        setPid(null);
        setRunning(false);
      }
    });
    return () => { offOutput(); offExit(); };
  }, [appendText]);

  // 工作区变化时（重新）启动
  useEffect(() => {
    // 先清理旧进程
    if (pidRef.current != null) {
      window.cnke.terminal.kill(pidRef.current);
      pidRef.current = null;
    }
    setLines([]);
    pendingRef.current = '';
    setRunning(false);
    setPid(null);
    if (workspacePath) {
      void startShell();
    }
  }, [workspacePath, startShell]);

  // 自动滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // IME 合成中（输入法候选确认）不当作回车执行
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      const cmd = input;
      setInput('');
      if (pidRef.current != null) {
        appendText(`\n> ${cmd}`);
        window.cnke.terminal.write(pidRef.current, cmd + '\n');
      }
    }
  };

  const handleClear = () => {
    setLines([]);
    pendingRef.current = '';
  };

  const handleClick = () => inputRef.current?.focus();

  return (
    <div className="flex flex-col h-full bg-background" onClick={handleClick}>
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/20 shrink-0">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-emerald-400" />
          终端
        </span>
        <div className="flex items-center gap-0.5">
          <span className="text-[10px] text-muted-foreground/50 mr-1">
            {running ? <span className="flex items-center gap-1 text-emerald-400"><Loader2 className="w-3 h-3 animate-spin" />运行中</span> : '已停止'}
          </span>
          <button onClick={handleClear} className="p-1.5 hover:bg-accent hover:text-foreground rounded-md transition-colors text-muted-foreground" title="清空终端">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-border mx-0.5" />
          {/* 隐藏终端：与资源管理器面板的 × 行为一致，隐藏后左侧留窄边栏可恢复 */}
          <button
            onClick={() => setPanelVisible('terminal', false)}
            className="p-1 hover:bg-muted-foreground/20 hover:text-foreground rounded transition-colors text-muted-foreground"
            title="隐藏终端"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* 输出区 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed cursor-text"
      >
        {lines.length === 0 ? (
          <div className="text-muted-foreground h-full flex items-center justify-center">
            {workspacePath ? '输入命令开始执行…' : '请先打开工作区文件夹'}
          </div>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="whitespace-pre-wrap break-words text-foreground">{l.text || ' '}</div>
          ))
        )}
      </div>

      {/* 输入区 */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-secondary/20 shrink-0 font-mono">
        <span className="text-emerald-500 text-[12px] shrink-0 select-none">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!workspacePath}
          placeholder={workspacePath ? '输入命令，Enter 执行' : '未打开工作区'}
          className="flex-1 bg-transparent outline-none text-[12px] text-foreground placeholder:text-muted-foreground"
        />
      </div>
    </div>
  );
};

export default TerminalPanel;
