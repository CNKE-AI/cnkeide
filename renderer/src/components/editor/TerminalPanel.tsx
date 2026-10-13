import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useApp } from '../../store/AppProvider';
import { useLayoutStore } from '../../store/layoutStore';
import { useAgentActivityStore, AgentActivityLine } from '../../store/agentActivityStore';
import { Terminal, Trash2, Loader2, X, Bot, Check, AlertTriangle } from 'lucide-react';

interface TerminalLine {
  id: number;
  text: string;
}

const MAX_LINES = 800;
/** Agent 活动最多渲染的行数（避免超长会话拖慢渲染） */
const MAX_AGENT_LINES = 600;

type TerminalTab = 'shell' | 'agent';

/** Agent 活动行的颜色映射 */
const KIND_CLASS: Record<AgentActivityLine['kind'], string> = {
  info: 'text-foreground/85',
  command: 'text-sky-300',
  output: 'text-muted-foreground',
  success: 'text-emerald-400/80',
  error: 'text-red-400',
  thinking: 'text-violet-300/70 italic',
  file: 'text-amber-300',
  divider: 'text-muted-foreground/50',
};

/** Agent 阶段对应的中文标签与颜色 */
function phaseLabel(phase: string): { text: string; cls: string; spin: boolean } {
  switch (phase) {
    case 'thinking':
      return { text: '思考中', cls: 'text-violet-400', spin: true };
    case 'streaming':
      return { text: '输出中', cls: 'text-sky-400', spin: true };
    case 'tool':
      return { text: '调用工具', cls: 'text-amber-400', spin: true };
    case 'waiting-approval':
      return { text: '等待审批', cls: 'text-amber-300', spin: false };
    case 'done':
      return { text: '已完成', cls: 'text-emerald-400', spin: false };
    case 'error':
      return { text: '出错', cls: 'text-red-400', spin: false };
    case 'aborted':
      return { text: '已中止', cls: 'text-muted-foreground', spin: false };
    default:
      return { text: '空闲', cls: 'text-muted-foreground', spin: false };
  }
}

/** 耗时格式化 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * 终端面板：双标签（Shell / Agent）
 *
 * - Shell 标签：原生交互式 shell（原有能力）
 * - Agent 标签：实时跟随 Agent 运行状态，展示思考/工具调用/命令输出/文件变更，
 *   无需手动切换视图即可看到 Agent 执行过程与结果。
 *
 * 两个标签共享同一个面板，Agent 运行时标签标题会显示运行指示，
 * 即使当前停在 Shell 标签也能感知 Agent 活动（标题脉冲），做到"实时联动"。
 */
const TerminalPanel: React.FC = () => {
  const { workspacePath } = useApp();
  const setPanelVisible = useLayoutStore((s) => s.setPanelVisible);

  // ---------- Shell 状态 ----------
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [pid, setPid] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lineIdRef = useRef(0);
  const pidRef = useRef<number | null>(null);
  const pendingRef = useRef('');

  // ---------- 标签 ----------
  const [tab, setTab] = useState<TerminalTab>('shell');
  /** 用户是否停留在 Shell 标签（Agent 有输出时自动切到 Agent 标签） */
  const userPinnedTabRef = useRef(false);

  // ---------- Agent 活动（来自共享 store，与编辑器/资源管理器同一数据源） ----------
  const agentLines = useAgentActivityStore((s) => s.lines);
  const phase = useAgentActivityStore((s) => s.phase);
  const currentTool = useAgentActivityStore((s) => s.currentTool);
  const toolCount = useAgentActivityStore((s) => s.toolCount);
  const errorCount = useAgentActivityStore((s) => s.errorCount);
  const startedAt = useAgentActivityStore((s) => s.startedAt);
  const clearAgent = useAgentActivityStore((s) => s.clear);

  const [elapsed, setElapsed] = useState(0);
  const isAgentActive = phase === 'thinking' || phase === 'streaming' || phase === 'tool';

  const appendText = useCallback((text: string) => {
    pendingRef.current += text;
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
    const res = await window.cnke.terminal.spawn('', [], cwd);
    if (!res.success || res.pid == null) {
      setLines((prev) => [
        ...prev,
        { id: ++lineIdRef.current, text: `启动终端失败: ${res.error}` },
      ]);
      return;
    }
    pidRef.current = res.pid;
    setPid(res.pid);
    setRunning(true);
  }, [workspacePath]);

  // 订阅 shell 输出与退出
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
    return () => {
      offOutput();
      offExit();
    };
  }, [appendText]);

  // 工作区变化时（重新）启动 shell
  useEffect(() => {
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

  // Shell 自动滚动
  useEffect(() => {
    if (tab === 'shell') scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines, tab]);

  // Agent 自动滚动（跟随最新输出）
  useEffect(() => {
    if (tab === 'agent') {
      agentScrollRef.current?.scrollTo({ top: agentScrollRef.current.scrollHeight });
    }
  }, [agentLines, tab]);

  // Agent 开始运行时自动切到 Agent 标签（除非用户明确停在 Shell 且没有新输出）
  useEffect(() => {
    if (isAgentActive && !userPinnedTabRef.current) setTab('agent');
  }, [isAgentActive]);

  // 运行耗时计时
  useEffect(() => {
    if (!isAgentActive || !startedAt) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(timer);
  }, [isAgentActive, startedAt]);

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
    if (tab === 'agent') clearAgent();
    else {
      setLines([]);
      pendingRef.current = '';
    }
  };

  const handleClick = () => {
    if (tab === 'shell') inputRef.current?.focus();
  };

  const ph = phaseLabel(phase);
  const visibleAgentLines = useMemo(
    () => (agentLines.length > MAX_AGENT_LINES ? agentLines.slice(agentLines.length - MAX_AGENT_LINES) : agentLines),
    [agentLines]
  );

  return (
    <div className="flex flex-col h-full bg-background" onClick={handleClick}>
      {/* 头部：标签切换 + 状态 */}
      <div className="flex items-center justify-between px-2.5 py-1 border-b border-border bg-secondary/20 shrink-0">
        <div className="flex items-center gap-1">
          {/* Shell 标签 */}
          <button
            onClick={() => {
              setTab('shell');
              userPinnedTabRef.current = true;
            }}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
              tab === 'shell'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            }`}
          >
            <Terminal className="w-3 h-3 text-emerald-400" />
            Shell
            {running && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
          </button>

          {/* Agent 标签：运行中时脉冲提示，即使在 Shell 标签也能感知 */}
          <button
            onClick={() => {
              setTab('agent');
              userPinnedTabRef.current = false;
            }}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
              tab === 'agent'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            }`}
          >
            <Bot className={`w-3 h-3 ${isAgentActive ? 'text-violet-400' : 'text-muted-foreground'}`} />
            Agent
            {isAgentActive && (
              <Loader2 className="w-2.5 h-2.5 animate-spin text-violet-400" />
            )}
            {errorCount > 0 && <span className="w-1.5 h-1.5 rounded-full bg-red-400" />}
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Agent 运行状态摘要（跨标签常显） */}
          <span className={`text-[9px] ${ph.cls} flex items-center gap-1`}>
            {ph.spin && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
            {phase !== 'idle' && (
              <>
                {ph.text}
                {isAgentActive && currentTool && <span className="opacity-70">· {currentTool}</span>}
                {isAgentActive && elapsed > 0 && <span className="opacity-60">{formatDuration(elapsed)}</span>}
                {!isAgentActive && toolCount > 0 && (
                  <span className="opacity-60 flex items-center gap-0.5">
                    <Check className="w-2.5 h-2.5" />{toolCount}
                  </span>
                )}
                {!isAgentActive && errorCount > 0 && (
                  <span className="text-red-400 flex items-center gap-0.5">
                    <AlertTriangle className="w-2.5 h-2.5" />{errorCount}
                  </span>
                )}
              </>
            )}
            {phase === 'idle' && (running ? 'Shell 运行中' : '已停止')}
          </span>
          <button
            onClick={handleClear}
            className="p-1 hover:bg-accent hover:text-foreground rounded-md transition-colors text-muted-foreground"
            title={tab === 'agent' ? '清空 Agent 活动' : '清空终端'}
          >
            <Trash2 className="w-3 h-3" />
          </button>
          <div className="w-px h-4 bg-border mx-0.5" />
          <button
            onClick={() => setPanelVisible('terminal', false)}
            className="p-1 hover:bg-muted-foreground/20 hover:text-foreground rounded transition-colors text-muted-foreground"
            title="隐藏终端"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* ---------- Agent 活动视图 ---------- */}
      {tab === 'agent' ? (
        <div
          ref={agentScrollRef}
          className="flex-1 overflow-y-auto px-2.5 py-1.5 font-mono text-[11px] leading-relaxed"
        >
          {visibleAgentLines.length === 0 ? (
            <div className="text-muted-foreground h-full flex flex-col items-center justify-center gap-1.5">
              <Bot className="w-6 h-6 opacity-30" />
              <span className="text-[11px]">Agent 尚未运行</span>
              <span className="text-[10px] opacity-60">在左侧对话框发送消息，执行过程会实时显示在这里</span>
            </div>
          ) : (
            visibleAgentLines.map((l) => (
              <div
                key={l.id}
                className={`whitespace-pre-wrap break-words ${KIND_CLASS[l.kind]}`}
              >
                {l.text || ' '}
              </div>
            ))
          )}
          {/* 运行中的光标指示 */}
          {isAgentActive && (
            <div className="flex items-center gap-1.5 text-violet-400/80 mt-1">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              <span className="text-[10px]">
                {phase === 'tool' && currentTool ? `正在执行 ${currentTool}…` : 'Agent 处理中…'}
              </span>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* ---------- Shell 输出区 ---------- */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-2.5 py-1.5 font-mono text-[11px] leading-relaxed cursor-text"
          >
            {lines.length === 0 ? (
              <div className="text-muted-foreground h-full flex items-center justify-center">
                {workspacePath ? '输入命令开始执行…' : '请先打开工作区文件夹'}
              </div>
            ) : (
              lines.map((l) => (
                <div key={l.id} className="whitespace-pre-wrap break-words text-foreground">
                  {l.text || ' '}
                </div>
              ))
            )}
          </div>

          {/* ------------------ Shell 输入区 ------------------ */}
          <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-border bg-secondary/20 shrink-0 font-mono">
            <span className="text-emerald-500 text-[11px] shrink-0 select-none">$</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!workspacePath}
              placeholder={workspacePath ? '输入命令，Enter 执行' : '未打开工作区'}
              className="flex-1 bg-transparent outline-none text-[11px] text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </>
      )}
    </div>
  );
};

export default TerminalPanel;
