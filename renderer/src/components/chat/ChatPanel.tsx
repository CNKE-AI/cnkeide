import React, { useCallback, useEffect, useRef, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import { useChatStore, ChatMessage, AgentMode, UploadedFile, MAX_FILE_TEXT_CHARS, MAX_UPLOAD_FILES } from '../../store/chatStore';
import { useApp } from '../../store/AppProvider';
import Markdown from './Markdown';
import ToolCallView from './ToolCallView';
import { toolLabel } from '../../store/agentActivityStore';
import { MemoryPanel } from './MemoryPanel';
import VoiceInputButton from './VoiceInputButton';
import {
  Send, Square, Brain, Hammer, Bug, MessageCircleQuestion,
  Plus, ChevronDown, ChevronRight, Paperclip, Sparkles, Zap, MessageCircle,
  Copy, Check, Wand2, RefreshCw, FileText, BookmarkPlus, X, AtSign, CornerUpLeft,
  Presentation, ArrowDown,
} from 'lucide-react';
import { toast } from '../../utils/toast';
import RefPicker from './RefPicker';
import { resolveAllRefs } from '../../utils/promptRefs';
import ContextBar from './ContextBar';
import PlanPanel from './PlanPanel';
import ModelSwitcher from './ModelSwitcher';
import ChatHeader from './ChatHeader';
import CheckpointPanel from './CheckpointPanel';
import ApprovalRulesPanel from './ApprovalRulesPanel';
import { useUiStore } from '../../store/uiStore';
import type { TaskItem } from '../../global';

const MODES: { id: AgentMode; label: string; icon: React.ReactNode; color: string }[] = [
  { id: 'ask', label: 'Ask', icon: <MessageCircleQuestion className="w-3 h-3" />, color: 'text-amber-400' },
  { id: 'coder', label: 'Craft', icon: <Hammer className="w-3 h-3" />, color: 'text-violet-400' },
  { id: 'architect', label: 'Plan', icon: <Brain className="w-3 h-3" />, color: 'text-cyan-400' },
  { id: 'debugger', label: 'Debug', icon: <Bug className="w-3 h-3" />, color: 'text-emerald-400' },
];

/**
 * 各厂商模型的官网最新公开价格（单位：元 / 每百万 tokens）。
 * input = 输入价格，output = 输出价格，cache = 缓存命中输入价格（可选，缺省按 input 计算）。
 * 仅用于「预估」计费金额展示，实际扣费以厂商账单为准。
 */
interface ModelPrice { input: number; output: number; cache?: number }
const MODEL_PRICES: Record<string, ModelPrice> = {
  // DeepSeek
  'deepseek-chat': { input: 0.5, output: 2, cache: 0.1 },
  'deepseek-reasoner': { input: 1, output: 4, cache: 0.2 },
  'deepseek-v4-flash': { input: 3, output: 9, cache: 0.1 },
  'deepseek-v4-pro': { input: 9, output: 27, cache: 0.3 },
  // 通义千问 Qwen
  'qwen-max': { input: 4, output: 12 },
  'qwen-plus': { input: 0.8, output: 2 },
  'qwen-turbo': { input: 0.3, output: 0.6 },
  'qwen-long': { input: 0.5, output: 2 },
  // 智谱 GLM
  'glm-4': { input: 0.5, output: 1 },
  'glm-4-plus': { input: 4, output: 12 },
  'glm-4-air': { input: 0.5, output: 1 },
  'glm-4-flash': { input: 0.1, output: 0.1 },
  'glm-5.2': { input: 8, output: 28, cache: 2 },
  'glm-5.3': { input: 8, output: 28, cache: 2 },
  'glm-5.3-flash': { input: 0.4, output: 1.4, cache: 0.12 },
  // Kimi / 月之暗面
  'kimi-k2.6': { input: 6.5, output: 27, cache: 1.1 },
  'kimi-k2.7-code': { input: 13, output: 54, cache: 2.6 },
  'kimi-k3': { input: 20, output: 100, cache: 2 },
  // 腾讯混元
  'hy4-preview': { input: 6, output: 18, cache: 0.3 },
  // MiniMax
  'minimax-m3': { input: 4.2, output: 16.8, cache: 0.84 },
  // Claude
  'claude-3-5-sonnet': { input: 3, output: 15, cache: 0.3 },
  'claude-3-7-sonnet': { input: 3, output: 15, cache: 0.3 },
  'claude-opus': { input: 15, output: 75, cache: 1.5 },
  'claude-haiku': { input: 0.25, output: 1.25, cache: 0.025 },
  // AI Platform 兼容（兜底常见）
  'gpt-4o': { input: 2.5, output: 10, cache: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cache: 0.075 },
  'gpt-4.1': { input: 2, output: 8 },
};

/** 未知模型的兜底默认价（输入 $1/M、输出 $3/M，无缓存价），保证费用始终有数值而非「—」 */
const DEFAULT_PRICE: ModelPrice = { input: 1, output: 3 };

/** 厂商前缀 → 兜底价，让同系列新模型（如 deepseek-v4-pro）也能匹配到合理价格 */
const VENDOR_FALLBACK: Array<[string, ModelPrice]> = [
  ['deepseek-', MODEL_PRICES['deepseek-chat']],
  ['qwen-', MODEL_PRICES['qwen-plus']],
  ['glm-', MODEL_PRICES['glm-4']],
  ['claude-', MODEL_PRICES['claude-opus']],
  ['gpt-', MODEL_PRICES['gpt-4o']],
  ['o1', MODEL_PRICES['gpt-4o']],
];

/** 根据模型名匹配价格；精确/前缀匹配不到时按厂商兜底，再兜底默认价（永不返回 null，费用不显示「—」） */
function resolveModelPrice(model?: string): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  const key = model.toLowerCase().trim();
  if (MODEL_PRICES[key]) return MODEL_PRICES[key];
  // 去掉日期后缀等，做宽松前缀匹配
  for (const k of Object.keys(MODEL_PRICES)) {
    if (key.startsWith(k) || k.startsWith(key)) return MODEL_PRICES[k];
  }
  // 厂商前缀兜底
  for (const [prefix, price] of VENDOR_FALLBACK) {
    if (key.startsWith(prefix)) return price;
  }
  return DEFAULT_PRICE;
}

/** 预估费用：输入(区分缓存命中) + 输出，返回人民币金额 */
function estimateCost(usage: NonNullable<ChatMessage['usage']>, price: ModelPrice): number {
  const details = usage.prompt_tokens_details;
  const cached = details?.cached_tokens ?? 0;
  const inputTokens = usage.prompt_tokens || 0;
  const uncachedInput = Math.max(0, inputTokens - cached);
  const outputTokens = usage.completion_tokens || 0;
  const inputPrice = price.input / 1_000_000;
  const cachePrice = (price.cache ?? price.input) / 1_000_000;
  const outputPrice = price.output / 1_000_000;
  return uncachedInput * inputPrice + cached * cachePrice + outputTokens * outputPrice;
}

/** 文件大小人性化显示 */
function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** 常见文本/代码扩展名（小写，不含点），用于判断能否被 AI 读取分析 */
const TEXT_EXTS = new Set([
  'txt', 'text', 'md', 'markdown', 'log', 'json', 'jsonc', 'json5', 'js', 'jsx', 'mjs', 'cjs',
  'ts', 'tsx', 'mts', 'cts', 'py', 'pyw', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'go', 'rs',
  'rb', 'php', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'conf', 'config', 'properties', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'sql',
  'csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'ods', 'numbers', 'vue', 'svelte', 'astro', 'graphql', 'proto', 'lua', 'pl', 'r', 'swift', 'kt',
  'kts', 'cs', 'dart', 'ex', 'exs', 'hs', 'scala', 'sol', 'prisma', 'gitignore',
  'gitattributes', 'editorconfig', 'dockerfile', 'makefile', 'snap', 'diff', 'patch', 'rst',
  'tex', 'svg', 'webmanifest', 'license',
]);

/** 文本类 MIME（application 下的 JSON/XML/脚本类也算文本） */
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-sh|x-python|x-yaml|x-toml|sql|graphql|ld\+json|x-ndjson|x-httpd-php|x-ruby|x-perl|x-lua|x-shellscript|toml|yaml|wasm-json))/;

/** 表格类扩展名（需用 SheetJS 解析成可读文本，而非按原始二进制读取） */
const SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'xlsm', 'ods']);

/**
 * 解析表格文件（xlsx/xls/ods）为可读文本：
 * - 每个 sheet 转为「sheet 名 + 表格内容」，单元格用制表符分隔、换行分隔行
 * - 数值/日期/布尔等非字符串单元格也转成文本，保证 AI 能读取
 * - 最多解析前若干 sheet、每 sheet 前若干行，避免超大表撑爆上下文
 */
function parseSpreadsheet(buf: ArrayBuffer): string {
  try {
    const wb = XLSX.read(buf, { type: 'array' });
    const parts: string[] = [];
    const maxSheets = 4;
    const maxRows = 500;
    const sheetNames = wb.SheetNames.slice(0, maxSheets);
    for (const name of sheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      // sheet_to_json 保留空行，header:1 得到二维数组（每行是单元格数组）
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
      const lines: string[] = [];
      for (let r = 0; r < rows.length && r < maxRows; r++) {
        const row = rows[r] || [];
        // 去掉行尾连续空单元格，避免无意义的尾部制表符
        let end = row.length;
        while (end > 0 && (row[end - 1] === '' || row[end - 1] == null)) end--;
        if (end === 0) {
          lines.push('');
          continue;
        }
        lines.push(row.slice(0, end).map((c) => cellToText(c)).join('\t'));
      }
      const more = rows.length > maxRows ? `\n…（该工作表共 ${rows.length} 行，仅展示前 ${maxRows} 行）` : '';
      parts.push(`【工作表：${name}】\n${lines.join('\n')}${more}`);
    }
    const extra = wb.SheetNames.length > maxSheets
      ? `\n\n（该文件共 ${wb.SheetNames.length} 个工作表，仅解析前 ${maxSheets} 个）`
      : '';
    return parts.join('\n\n') + extra;
  } catch {
    return '';
  }
}

/** 单元格值转文本：日期/数值/布尔统一转可读字符串 */
function cellToText(c: any): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  if (typeof c === 'number') return Number.isInteger(c) ? String(c) : String(c);
  if (typeof c === 'boolean') return c ? 'TRUE' : 'FALSE';
  return String(c);
}

/**
 * 读取上传文件的文本内容（最多 MAX_FILE_TEXT_CHARS 字符）：
 * - 表格文件（xlsx/xls/ods）用 SheetJS 解析为可读文本
 * - 文件过大时只读取开头足够字节，不整文件读入内存
 * - 非文本类文件（按扩展名/MIME 判断 + NUL 字节兜底检测）返回 null
 */
async function readTextFile(file: File): Promise<{ content: string; truncated: boolean } | null> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isPlainText = TEXT_MIME_RE.test(file.type) || file.type.startsWith('text/') || TEXT_EXTS.has(ext);
  try {
    // 表格文件：用 SheetJS 解析
    if (SPREADSHEET_EXTS.has(ext)) {
      const ab = await file.arrayBuffer();
      const text = parseSpreadsheet(ab);
      if (!text) return null;
      const truncated = text.length > MAX_FILE_TEXT_CHARS;
      return { content: truncated ? text.slice(0, MAX_FILE_TEXT_CHARS) : text, truncated };
    }
    const need = MAX_FILE_TEXT_CHARS * 4 + 4096;
    const buf = file.size > need ? file.slice(0, need) : file;
    const text = await buf.text();
    const sampleLen = Math.min(text.length, 4096);
    let bad = 0;
    for (let i = 0; i < sampleLen; i++) {
      const code = text.charCodeAt(i);
      if (code === 0 || code === 0xfffd) bad++;
    }
    const badRatio = sampleLen > 0 ? bad / sampleLen : 0;
    // 明确的文本类文件信任读取（内容再乱码也是文本）；其他类型按坏字符比例判定
    if (!isPlainText && (badRatio > 0.02 || sampleLen === 0)) return null;
    const truncated = text.length > MAX_FILE_TEXT_CHARS;
    return { content: truncated ? text.slice(0, MAX_FILE_TEXT_CHARS) : text, truncated };
  } catch {
    return null;
  }
}

const TokenPopover: React.FC<{
  usage: NonNullable<ChatMessage['usage']>;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}> = ({ usage, open, onOpenChange }) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'down' | 'up' } | null>(null);

  // 打开时计算位置 + 监听 resize/scroll，关闭时清理
  useEffect(() => {
    if (!open) { setPos(null); return; }
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const POP_W = 260;
      const POP_H = 280;
      const GAP = 6;
      const margin = 8;
      // 横向：默认左对齐触发器，溢出则右对齐
      let left = r.left;
      if (left + POP_W > window.innerWidth - margin) left = window.innerWidth - POP_W - margin;
      if (left < margin) left = margin;
      // 纵向：优先向下放，下方空间不够则向上
      const below = r.bottom + GAP + POP_H <= window.innerHeight - margin;
      const top = below ? r.bottom + GAP : r.top - GAP - POP_H;
      setPos({ left, top: Math.max(margin, top), placement: below ? 'down' : 'up' });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // 点击外部关闭（用 mousedown 不影响 click 触发；仅 document 监听不阻塞其他 UI）
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    // 延迟挂载，避免本次打开 click 立即触发关闭
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDocDown), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onDocDown);
    };
  }, [open, onOpenChange]);

  const popover = open && pos ? createPortal(
    <div
      ref={popRef}
      style={{ position: 'fixed', left: pos.left, top: pos.top, width: 260, zIndex: 9999 }}
      className="bg-card border border-border rounded-lg shadow-xl p-3 text-[12px] text-foreground"
    >
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-border">
        <span className="font-medium">Token 消耗明细</span>
        <span className="text-muted-foreground text-[11px]">总计 {usage.total_tokens.toLocaleString()}</span>
      </div>
      <TokenDetailRow color="bg-blue-500" label="输入" value={usage.prompt_tokens} subItems={usage.prompt_tokens_details} />
      <TokenDetailRow color="bg-purple-500" label="输出" value={usage.completion_tokens} subItems={usage.completion_tokens_details} />
      {(() => {
        const cost = estimateCost(usage, resolveModelPrice(usage.model));
        return (
          <div className="mt-2 pt-2 border-t border-border">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
                预估费用
                <span className="text-muted-foreground">（官网价）</span>
              </span>
              <span className="font-medium text-emerald-400 tabular-nums">
                {`¥${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`}
              </span>
            </div>
            {usage.model && (
              <div className="text-[10px] text-muted-foreground/70 mt-0.5 truncate">
                {usage.model}
              </div>
            )}
          </div>
        );
      })()}
    </div>,
    document.body
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => onOpenChange(!open)}
        className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-accent hover:text-foreground transition-colors"
        title="查看 Token 消耗明细"
      >
        <span>Tokens: {usage.total_tokens.toLocaleString()}</span>
      </button>
      {popover}
    </>
  );
};

const TokenDetailRow: React.FC<{
  color: string;
  label: string;
  value: number;
  subItems?: { cached_tokens?: number; cache_miss_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number };
}> = ({ color, label, value, subItems }) => {
  const cached = subItems?.cached_tokens ?? 0;
  // 未命中 = 总量 - 命中（API 未返回 cache_miss_tokens 时兜底，保证始终有确定值而非 undefined）
  const miss = subItems?.cache_miss_tokens ?? Math.max(0, value - cached);
  const write = subItems?.cache_write_tokens ?? 0;
  const reasoning = subItems?.reasoning_tokens ?? 0;
  const hasCache = cached > 0 || write > 0;
  const hasReasoning = reasoning > 0;
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="flex items-center justify-between mb-0.5">
        <span className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-sm ${color}`} />
          <span>{label}</span>
        </span>
        <span className="font-medium tabular-nums">{value.toLocaleString()}</span>
      </div>
      {(hasCache || hasReasoning) && (
        <div className="ml-3.5 mt-0.5 space-y-0.5 text-[11px] text-muted-foreground/80">
          {hasCache && (
            <>
              <SubRow color="bg-emerald-500" label="缓存命中" value={cached} />
              <SubRow color="bg-rose-400" label="缓存未命中" value={miss} />
              {write > 0 && <SubRow color="bg-amber-400" label="缓存写入" value={write} />}
            </>
          )}
          {hasReasoning && <SubRow color="bg-cyan-400" label="思考过程" value={reasoning} />}
        </div>
      )}
    </div>
  );
};

const SubRow: React.FC<{ color: string; label: string; value: number }> = ({ color, label, value }) => (
  <div className="flex items-center justify-between">
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />
      <span>{label}</span>
    </span>
    <span className="tabular-nums">{value.toLocaleString()}</span>
  </div>
);

/**
 * 消息气泡。
 * memo 是流式场景的关键：流式时每帧只更新最后一条 assistant 消息的 content，
 * 有了 memo，其他 N-1 条历史消息可以直接跳过重渲染（Markdown 内部还有一层 memo）。
 * 三个回调都由父组件用 useCallback 固定，引用稳定才会真正生效。
 */
interface MessageBubbleProps {
  msg: ChatMessage;
  /** 该消息是否正在流式输出：内容还没写完时跳过高亮等昂贵处理 */
  streaming?: boolean;
  onRegenerate?: (id: string) => void;
  onRemember?: (content: string) => Promise<boolean>;
  onRollbackTo?: (id: string) => void;
}

/** 气泡时间戳：同一天只显示 时:分，跨天带日期 */
const fmtTime = (ts?: number): string => {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
};

const MessageBubble = React.memo(({ msg, streaming, onRegenerate, onRemember, onRollbackTo }: MessageBubbleProps) => {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [remembered, setRemembered] = useState(false);
  /** 失败消息：chatStore 用 `Error: ...` 作为内容标记 */
  const isError = msg.role === 'assistant' && msg.content.startsWith('Error:');

  const handleRemember = async () => {
    if (!onRemember) return;
    const ok = await onRemember(msg.content);
    if (ok) {
      setRemembered(true);
      setTimeout(() => setRemembered(false), 2000);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  if (msg.role === 'user') {
    return (
      <div className="chat-msg flex justify-end mb-5">
        <div className="bubble-user max-w-[85%] px-4 py-3">
          {msg.files && msg.files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {msg.files.map((f) => (
                <span
                  key={f.id}
                  className="flex items-center gap-1.5 px-2 py-1 bg-secondary/70 border border-border rounded-md text-[11px] text-foreground/80"
                  title={f.truncated ? `文件过大，AI 仅能读取前 ${MAX_FILE_TEXT_CHARS} 字符` : '已作为文件附件提供给 AI 分析'}
                >
                  <FileText className="w-3 h-3 text-primary/70 shrink-0" />
                  <span className="max-w-[160px] truncate">{f.name}</span>
                  <span className="text-muted-foreground/70 shrink-0">{fmtSize(f.size)}</span>
                </span>
              ))}
            </div>
          )}
          {msg.images && msg.images.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {msg.images.map((img, i) => (
                <img key={`img-${i}`} src={img} alt={`附件${i + 1}`} className="max-h-28 rounded-md border border-border" />
              ))}
            </div>
          )}
          {/* 展示用 displayContent：@文件 注入的全文只发给模型，不能糊在气泡里 */}
          <p className="text-[13px] whitespace-pre-wrap break-words leading-relaxed">{msg.displayContent ?? msg.content}</p>
          {msg.timestamp ? (
            <div className="mt-1 text-right text-[10px] text-muted-foreground/60 tabular-nums">{fmtTime(msg.timestamp)}</div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-msg mb-5">
      <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
        <span className="w-4 h-4 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
          <Sparkles className="w-2.5 h-2.5 text-white" />
        </span>
        <span className="font-medium">CnkeIDE</span>
      </div>

      {msg.modelNotice && (
        <div className="mb-2 text-xs text-amber-300 bg-amber-400/8 border border-amber-400/20 rounded-lg px-3 py-2">
          {msg.modelNotice}
        </div>
      )}

      {msg.contextNotice && (
        <div className="mb-2 text-xs text-sky-300 bg-sky-400/8 border border-sky-400/20 rounded-lg px-3 py-2">
          {msg.contextNotice}
        </div>
      )}

      {msg.thinking && (
        <div className="mb-1.5">
          <button
            onClick={() => setThinkingOpen(!thinkingOpen)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {thinkingOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span className="italic">思考过程</span>
          </button>
          {thinkingOpen && (
            <div className="mt-1 text-[12px] text-muted-foreground italic bg-secondary/40 rounded-lg p-2.5 border-l-2 border-primary/50 whitespace-pre-wrap">
              {msg.thinking}
            </div>
          )}
        </div>
      )}

      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="mb-4 space-y-2.5">
          {msg.toolCalls.map((tc, i) => (
            <ToolCallView key={`tc-${i}`} call={tc} />
          ))}
        </div>
      )}

      {msg.content ? (
        <div className="pl-0.5">
          {isError ? (
            // 失败信息不走 Markdown：`Error: xxx` 里的 URL/下划线会被解析成链接，
            // 而且用醒目的错误色才能和正常回答区分开
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] leading-relaxed text-rose-200 whitespace-pre-wrap break-words">
              {msg.content}
            </div>
          ) : (
            <Markdown content={msg.content} streaming={streaming} />
          )}
        </div>
      ) : null}

      {/* AI 回复底部工具条：复制 + token 消耗（不加气泡包裹） */}
      {msg.content ? (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground/80">
          <button
            onClick={() => void handleCopy()}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent hover:text-foreground transition-colors"
            title="复制回复内容"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? '已复制' : '复制'}
          </button>
          {onRemember && msg.content && (
            <button
              onClick={() => void handleRemember()}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent hover:text-foreground transition-colors"
              title="把这条回复的要点存入本地记忆，后续对话自动加载"
            >
              {remembered ? <Check className="w-3 h-3 text-emerald-400" /> : <BookmarkPlus className="w-3 h-3" />}
              {remembered ? '已记住' : '存入记忆'}
            </button>
          )}
          {onRegenerate && (
            <button
              onClick={() => onRegenerate(msg.id)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
                isError
                  ? 'text-rose-300 hover:bg-rose-500/20 hover:text-rose-200'
                  : 'hover:bg-accent hover:text-foreground'
              }`}
              title={isError ? '重新执行这条提问' : '重新回答'}
            >
              <RefreshCw className="w-3 h-3" />
              {isError ? '重试' : '重新回答'}
            </button>
          )}
          {onRollbackTo && (
            <button
              onClick={() => onRollbackTo(msg.id)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-amber-500/20 hover:text-amber-400 transition-colors"
              title="回滚到此消息（删除之后的所有消息）"
            >
              <CornerUpLeft className="w-3 h-3" />
              回滚到此
            </button>
          )}
          {msg.usage && (
            <TokenPopover
              usage={msg.usage}
              open={tokenOpen}
              onOpenChange={setTokenOpen}
            />
          )}
          {msg.timestamp ? (
            <span className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums select-none">
              {fmtTime(msg.timestamp)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const ChatPanel: React.FC = () => {
  // 用 shallow 比较挑选字段，而不是 useChatStore() 订阅整个 store。
  // 原来的写法让 store 里任何字段变化（含流式期间每帧的 messages）都触发本组件重渲染；
  // 配合下方 MessageBubble 的 memo，历史气泡虽然会跳过，但表头、输入区等仍被无谓重算。
  const {
    messages, sessionId, sessions, loading, mode, autoMode, autoInteraction, conversation, setAutoInteraction,
    setMode, setAutoMode, initAutoMode, sendMessage, abort,
    refreshSessions, startNewSession, switchSession, removeSession,
    rollback, regenerateMessage, activeWorkspaceId, setActiveWorkspaceId,
  } = useChatStore(
    (s) => ({
      messages: s.messages,
      sessionId: s.sessionId,
      sessions: s.sessions,
      loading: s.loading,
      mode: s.mode,
      autoMode: s.autoMode,
      autoInteraction: s.autoInteraction,
      conversation: s.conversation,
      setAutoInteraction: s.setAutoInteraction,
      setMode: s.setMode,
      setAutoMode: s.setAutoMode,
      initAutoMode: s.initAutoMode,
      sendMessage: s.sendMessage,
      abort: s.abort,
      refreshSessions: s.refreshSessions,
      startNewSession: s.startNewSession,
      switchSession: s.switchSession,
      removeSession: s.removeSession,
      rollback: s.rollback,
      regenerateMessage: s.regenerateMessage,
      activeWorkspaceId: s.activeWorkspaceId,
      setActiveWorkspaceId: s.setActiveWorkspaceId,
    }),
    shallow
  );
  const { workspacePath, setWorkspacePath, settingsOpen } = useApp();
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [enhancing, setEnhancing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 用户是否停留在底部：否时不自动滚动，避免流式输出把正在翻看历史的人拽回底部 */
  const stickToBottomRef = useRef(true);
  /** 与 ref 同步的可见状态：用于决定是否显示"回到底部"按钮 */
  const [atBottom, setAtBottom] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 输入区高度：用户可拖拽调整，并记住上次的高度（每次打开 IDE 都要重调很烦）
  const [inputHeight, setInputHeight] = useState(() => {
    const saved = Number(window.localStorage.getItem('cnke.chat.inputHeight'));
    return Number.isFinite(saved) && saved >= 44 && saved <= 256 ? saved : 80;
  });
  const inputHeightRef = useRef(inputHeight);
  inputHeightRef.current = inputHeight;
  const [approval, setApproval] = useState<any>(null);
  const autoModeRef = useRef(autoMode);
  autoModeRef.current = autoMode;
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [approvalRulesOpen, setApprovalRulesOpen] = useState(false);
  const { refreshContext, refreshPlan, pendingPrompt, setPendingPrompt } = useUiStore();

  // 切换会话时：清掉上一个会话残留的审批条（否则点"允许"会 respond 一个已过期的 requestId），
  // 并拉取该会话的上下文占用与计划状态
  useEffect(() => {
    setApproval(null);
    if (!sessionId) return;
    void refreshContext(sessionId);
    void refreshPlan(sessionId);
  }, [sessionId, refreshContext, refreshPlan]);

  // 编辑器选区发送：把选中代码注入到输入框
  useEffect(() => {
    if (pendingPrompt !== null) {
      setInput((prev) => (prev ? prev + '\n' : '') + pendingPrompt);
      setPendingPrompt(null);
    }
  }, [pendingPrompt, setPendingPrompt]);

  useEffect(() => {
    void initAutoMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initAutoMode 是稳定的初始化函数引用
  }, []);

  // 切换对话时自动切换工作区：每个对话绑定各自的工作区目录
  useEffect(() => {
    if (activeWorkspaceId && activeWorkspaceId !== workspacePath) {
      setWorkspacePath(activeWorkspaceId);
    }
  }, [activeWorkspaceId, workspacePath, setWorkspacePath]);

  // 首次启动/切换工作区时：拉取会话列表，恢复最近会话或新建空会话（带防重，兼容 StrictMode 双挂载）
  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    void (async () => {
      await refreshSessions(workspacePath);
      if (cancelled) return;
      const { sessions, sessionId } = useChatStore.getState();
      if (sessionId) return; // 已有会话，不重复创建
      if (sessions.length > 0) {
        await switchSession(sessions[0].workspaceId || workspacePath, sessions[0].id);
      } else {
        await startNewSession(workspacePath);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  useEffect(() => {
    const remove = window.cnke.toolApprove.onRequest((data: any) => {
      if (autoModeRef.current) {
        window.cnke.toolApprove.respond(data.requestId, true);
        return;
      }
      setApproval(data);
    });
    return () => remove?.();
  }, []);

  // 设置弹窗关闭后（如切换模型后自动关闭），把焦点归还给输入框，避免输入框"卡死"
  const prevSettingsOpen = useRef(false);
  useEffect(() => {
    const wasOpen = prevSettingsOpen.current;
    prevSettingsOpen.current = settingsOpen;
    if (wasOpen && !settingsOpen) {
      // 弹窗刚关闭，延迟聚焦让 DOM 先完成卸载
      const timer = setTimeout(() => textareaRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [settingsOpen]);

  // 流式输出期间 messages 每帧都在变：只在"用户原本就在底部"时才跟随滚动，
  // 且用瞬时滚动（smooth 在高频调用下会互相打断、表现为卡顿）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  // 输入框随内容自动增高（上限 256px，超出后内部滚动）；手动拖拽的高度作为下限
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(256, Math.max(inputHeight, el.scrollHeight))}px`;
  }, [input, inputHeight]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = near;
    // 只在跨越阈值时 set，避免滚动过程中每帧触发重渲染
    setAtBottom((prev) => (prev === near ? prev : near));
  };

  const scrollToBottom = () => {
    stickToBottomRef.current = true;
    setAtBottom(true);
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // 发送锁：resolveAllRefs 是异步的（要读文件），期间输入框尚未清空，
  // 用户连按 Enter / 双击发送会重复起一轮 agent。这里用 ref 做同步互斥。
  const sendingRef = useRef(false);

  const handleSend = async () => {
    if (sendingRef.current || loading) return;
    if (!input.trim() && images.length === 0 && files.length === 0) return;

    // 快捷指令：/ppt [主题] —— 直接打开 PPT 窗口并预填主题
    const raw = input.trim();
    if (/^\/ppt(\s|$)/i.test(raw)) {
      const topic = raw.replace(/^\/ppt\s*/i, '').trim();
      setInput('');
      window.cnke.ppt.open(topic);
      return;
    }

    const ws = activeWorkspaceId || workspacePath;
    if (!ws) {
      toast.info('请先打开一个工作区文件夹');
      return;
    }

    sendingRef.current = true;
    try {
      // 解析 @文件/@目录 与 #codebase 检索，注入实际内容
      const resolved = await resolveAllRefs(raw, ws);
      setInput('');
      setImages([]);
      setFiles([]);
      stickToBottomRef.current = true;
      await sendMessage(
        resolved.prompt,
        ws,
        images.length > 0 ? images : undefined,
        files.length > 0 ? files : undefined,
        // 用户原话只用于展示与后续 history：注入的 @文件 全文仅随本轮发给模型
        raw,
      );
    } catch (e: any) {
      // 引用解析/发送失败：保留输入内容，明确告知，避免"点了没反应"
      toast.error(`发送失败：${e?.message || '引用解析出错，请重试'}`);
    } finally {
      sendingRef.current = false;
    }
  };

  /** 选择本地文件上传：图片走多模态 images，文本/代码读取内容随消息发送供 AI 分析 */
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const pickedAll = Array.from(e.target.files || []);
    e.target.value = ''; // 允许再次选择同一文件
    if (pickedAll.length === 0) return;
    const room = MAX_UPLOAD_FILES - images.length - files.length;
    if (room <= 0) {
      toast.error(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件/图片，请先移除已选附件`);
      return;
    }
    // 超限时截断而不是整批拒绝：选 7 个文件时原来一个都不会被加入
    const list = pickedAll.slice(0, room);
    if (list.length < pickedAll.length) {
      toast.info(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件/图片，本次仅加入前 ${list.length} 个`);
    }
    const newImgs: string[] = [];
    const newFiles: UploadedFile[] = [];
    for (const file of list) {
      if (file.type.startsWith('image/')) {
        if (file.size > 15 * 1024 * 1024) {
          toast.info(`图片「${file.name}」超过 15MB，已跳过`);
          continue;
        }
        const dataUrl = await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });
        if (dataUrl) newImgs.push(dataUrl);
        else toast.error(`图片「${file.name}」读取失败，请重试`);
      } else {
        const r = await readTextFile(file);
        if (!r) {
          toast.error(`「${file.name}」不是可分析的文本/代码文件，AI 暂无法读取（可先解压或转成 txt/json 后再上传）`);
          continue;
        }
        newFiles.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: file.name,
          size: file.size,
          content: r.content,
          truncated: r.truncated,
        });
      }
    }
    if (newImgs.length > 0) setImages((prev) => [...prev, ...newImgs]);
    if (newFiles.length > 0) setFiles((prev) => [...prev, ...newFiles]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // IME 合成中（拼音候选确认/翻页）不触发发送，避免打断输入法导致文字卡住不上屏
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Esc：生成中直接停止（和终端/其它 IDE 的习惯一致）
    if (e.key === 'Escape') {
      if (loading) {
        e.preventDefault();
        abort();
      }
      return;
    }
    // Cmd/Ctrl + Enter：与 Enter 等价，给习惯"多行输入 + 组合键发送"的人一个出口
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    // 事件对象在 await 后会失效，先把 File 同步取出来
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;

    const room = MAX_UPLOAD_FILES - images.length;
    if (room <= 0) {
      toast.error(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件/图片`);
      return;
    }
    const picked = files.slice(0, room);
    if (picked.length < files.length) {
      toast.info(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件/图片，多余的已跳过`);
    }

    // 统一读完再一次性写入：原实现把结果 push 进共享数组后每次都整体展开，
    // 粘贴多张图时第 N 张会把前面所有图重复追加一次
    const results = await Promise.all(
      picked.map((file) => new Promise<string | null>((resolve) => {
        if (file.size > 15 * 1024 * 1024) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      })),
    );
    const ok = results.filter((v): v is string => !!v);
    if (ok.length > 0) setImages((prev) => [...prev, ...ok].slice(0, MAX_UPLOAD_FILES));
    if (ok.length < picked.length) toast.info('部分图片读取失败或超过 15MB，已跳过');
  };

  const handleEnhance = async () => {
    if (!input.trim() || enhancing) return;
    setEnhancing(true);
    try {
      const res = await window.cnke.agent.enhancePrompt(input.trim());
      if (res.success && res.enhanced) {
        setInput(res.enhanced);
      } else {
        console.warn('增强失败:', res.error);
      }
    } catch (e) {
      console.warn('增强异常:', e);
    } finally {
      setEnhancing(false);
    }
  };

  const handleStop = () => abort();

  // ===== @ 引用 / #codebase 选择器 =====
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [refAnchor, setRefAnchor] = useState<DOMRect | null>(null);

  const openRefPicker = () => {
    const r = textareaRef.current?.getBoundingClientRect();
    if (r) {
      setRefAnchor(r);
      setRefPickerOpen(true);
    }
  };

  const handlePickFile = (path: string) => {
    // 插入相对路径（若在工作区内），否则绝对路径
    const ws = workspacePath;
    let ref = path;
    if (ws && path.startsWith(ws)) {
      ref = path.slice(ws.length).replace(/^[\\/]+/, '');
    }
    setInput((prev) => prev + `@${ref} `);
    setRefPickerOpen(false);
    textareaRef.current?.focus();
  };

  const handlePickDir = (path: string) => {
    handlePickFile(path);
  };

  const handlePickCodebase = (query: string) => {
    setInput((prev) => prev + `#codebase ${query} `);
    setRefPickerOpen(false);
    textareaRef.current?.focus();
  };

  // 输入 `@` 触发引用选择器
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setInput(v);
    // 检测末尾是否刚输入了 @ 或 #codebase
    if (/@$/.test(v)) {
      openRefPicker();
    } else if (/#codebase\s+$/.test(v)) {
      // 用户输入了 #codebase + 空格，等待关键词，稍后弹检索（这里先不弹，靠 @ 或按钮）
    }
  };

  // 输入区顶部拖动手柄：鼠标向下 → 输入框变大；向上 → 变小
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = inputHeightRef.current;
    const onMove = (ev: MouseEvent) => {
      // 鼠标向下（clientY 增大）→ 高度减小；反之增大
      const next = Math.min(256, Math.max(44, startH - (ev.clientY - startY)));
      setInputHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // 记住用户拖出来的高度，下次启动沿用
      try {
        window.localStorage.setItem('cnke.chat.inputHeight', String(inputHeightRef.current));
      } catch { /* 隐私模式等场景写入失败，忽略 */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  /** 新建对话：可选择新工作区或继承当前工作区 */
  const handleNewChat = async () => {
    if (!workspacePath) return;
    await startNewSession(workspacePath);
  };

  /** 新建对话并选择新工作区目录 */
  const handleNewChatNewWorkspace = async () => {
    const p = await window.cnke.fs.openFolder();
    if (!p) return;
    await startNewSession(p);
  };

  /**
   * 打开任务（TRAE 式）：先切工作区，再进这个任务下的对话。
   *
   * 这里必须调用 setWorkspacePath 而不是只 switchSession：
   * 文件树/编辑器/终端都挂在 AppProvider.workspacePath 上，
   * 只切会话的话会出现"对话换了、左边还是旧文件夹"的错位。
   * 有历史对话就回到最近那个，没有才新建，避免每次点任务都多出一个空对话。
   */
  const handleOpenTask = async (task: TaskItem) => {
    if (loading) return;
    setWorkspacePath(task.workspacePath);
    await refreshSessions(task.workspacePath);
    // refreshSessions 只写 store，返回值不受控，直接从 store 取本次结果
    const recent = useChatStore
      .getState()
      .sessions.find((s) => (s.workspaceId || task.workspacePath) === task.workspacePath);
    if (recent) await switchSession(task.workspacePath, recent.id);
    else await startNewSession(task.workspacePath);
  };

  /** 刚建好的任务：文件夹是空的，直接开一个绑定它的新对话 */
  const handleTaskCreated = async (task: TaskItem) => {
    setWorkspacePath(task.workspacePath);
    await startNewSession(task.workspacePath);
  };

  /**
   * 当前任务被改名：主进程已经把目录和会话绑定都迁到新路径，
   * 这里只要把工作区指过去，文件树/编辑器/终端就会跟着重连。
   * 不是当前任务就不动 —— 否则会莫名其妙把用户踢出正在编辑的目录。
   */
  const handleTaskRenamed = async (task: TaskItem, previousPath: string) => {
    if (!workspacePath || workspacePath !== previousPath) return;
    // 顺序很关键：activeWorkspaceId 还指着旧目录时，下面那个
    // 「activeWorkspaceId !== workspacePath 就切回去」的 effect
    // 会立刻把工作区拽回已不存在的旧路径，所以先改绑再切。
    setActiveWorkspaceId(task.workspacePath);
    setWorkspacePath(task.workspacePath);
    await refreshSessions(task.workspacePath);
  };

  const handleDeleteCurrent = () => {
    const ws = activeWorkspaceId || workspacePath;
    if (!ws || !sessionId || loading) return;
    if (window.confirm('删除当前对话？此操作不可恢复。')) {
      void removeSession(ws, sessionId);
    }
  };

  const [memoryOpen, setMemoryOpen] = useState(false);

  /** 把 AI 回复的要点存入本地记忆（供后续对话自动加载） */
  const rememberToMemory = useCallback(async (content: string): Promise<boolean> => {
    try {
      const text = content.trim();
      if (!text) return false;
      // 控制单条大小：过长时保留首尾要点
      const capped = text.length > 3800 ? `${text.slice(0, 3400)}\n…（中间省略）…\n${text.slice(-300)}` : text;
      const res = await window.cnke.memory.add({
        content: capped,
        type: 'manual',
        scope: (activeWorkspaceId || workspacePath) ? 'workspace' : 'global',
        workspaceId: (activeWorkspaceId || workspacePath) || undefined,
        importance: 2,
        source: 'manual',
      });
      if (!res.success) {
        toast.error(res.error || '保存失败');
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }, [activeWorkspaceId, workspacePath]);

  // 回滚到任意消息：删除该消息之后的所有消息
  const handleRollbackTo = useCallback(async (messageId: string) => {
    if (!sessionId || loading) return;
    if (!window.confirm('回滚到此消息会删除之后的所有消息，是否继续？')) return;
    const res = await window.cnke.sessionEx.deleteMessage(sessionId, messageId);
    if (!res.success) {
      toast.error(res.error || '回滚失败');
      return;
    }
    const ws = activeWorkspaceId || workspacePath;
    if (ws) await refreshSessions(ws);
    if (ws) await switchSession(ws, sessionId);
  }, [sessionId, loading, activeWorkspaceId, workspacePath, refreshSessions, switchSession]);

  /** 重新回答（稳定引用，否则 MessageBubble 的 memo 失效） */
  const handleRegenerate = useCallback((id: string) => {
    const ws = activeWorkspaceId || workspacePath;
    if (!ws) return;
    // 重新回答会丢弃该回复之后的所有消息：对历史消息必须先确认，避免误点丢数据
    const msgs = useChatStore.getState().messages;
    const idx = msgs.findIndex((m) => m.id === id);
    const laterUserMsgs = idx >= 0 ? msgs.slice(idx + 1).filter((m) => m.role === 'user').length : 0;
    if (laterUserMsgs > 0 && !window.confirm(`重新回答会删除此后 ${laterUserMsgs} 轮对话，是否继续？`)) return;
    void regenerateMessage(ws, id);
  }, [activeWorkspaceId, workspacePath, regenerateMessage]);

  return (
    <div className="flex flex-col h-full bg-transparent">
      {/* 顶部会话栏：会话标签自适应宽度 + 固定操作区，低频操作收进「更多」菜单 */}
      <ChatHeader
        sessions={sessions}
        sessionId={sessionId}
        activeWorkspaceId={activeWorkspaceId}
        workspacePath={workspacePath}
        loading={loading}
        canRollback={!loading && messages.length > 0}
        onSwitch={(s) => {
          // workspacePath 可能为 null，非空断言会把 undefined 传给 switchSession
          const ws = s.workspaceId || workspacePath;
          if (ws) void switchSession(ws, s.id);
        }}
        onCloseSession={(s) => {
          if (s.workspaceId && !loading && window.confirm(`关闭对话「${s.title || '新对话'}」？`)) {
            void removeSession(s.workspaceId, s.id);
          }
        }}
        onCreate={() => void handleNewChat()}
        onCreateNewWorkspace={() => void handleNewChatNewWorkspace()}
        onOpenTask={(t) => void handleOpenTask(t)}
        onTaskCreated={(t) => void handleTaskCreated(t)}
        onTaskRenamed={(t, prev) => void handleTaskRenamed(t, prev)}
        onImport={() => { void refreshSessions(workspacePath || activeWorkspaceId || ''); }}
        onSummarized={() => { if (sessionId) void refreshContext(sessionId); }}
        onRollback={() => { const ws = activeWorkspaceId || workspacePath; if (ws) void rollback(ws); }}
        onDelete={handleDeleteCurrent}
        onMemory={() => setMemoryOpen(true)}
        onCheckpoint={() => setCheckpointOpen(true)}
        onApproval={() => setApprovalRulesOpen(true)}
      />

      {/* 上下文占用进度条 */}
      <ContextBar />

      {/* 计划面板 */}
      <PlanPanel sessionId={sessionId || undefined} />

      {/* 消息列表 */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-state__icon">
              <Sparkles className="w-7 h-7 text-primary/60" />
            </div>
            <p className="text-sm font-medium text-foreground/80">开始你的 AI 编程之旅</p>
            <p className="text-xs max-w-[220px]">
              {workspacePath ? '描述你的需求，AI 将读取代码、编写文件、执行命令完成任务' : '请先通过左上角打开文件夹'}
            </p>
            {!workspacePath && (
              <button
                onClick={() => { void (async () => {
                  const p = await window.cnke.fs.openFolder();
                  // 原来用 location.reload() 刷新整页：会丢失未保存的输入和面板状态，
                  // setWorkspacePath 已负责同步文件树 + 启动监听，是等价且无损的做法
                  if (p) setWorkspacePath(p);
                })(); }}
                className="ios-btn mt-1.5"
              >
                打开文件夹
              </button>
            )}
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            // 只有"正在流式输出的最后一条"跳过语法高亮：代码还没写完，
            // 每帧重新 highlight 整段是长回答卡顿的主要来源
            streaming={loading && i === messages.length - 1 && msg.role === 'assistant'}
            onRegenerate={handleRegenerate}
            onRemember={rememberToMemory}
            onRollbackTo={handleRollbackTo}
          />
        ))}
        {loading && (
          <div className="flex items-center gap-1.5 text-muted-foreground text-xs px-1 py-2">
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      {/* 回到底部：用户上翻历史时出现（高度 0 的锚点，按钮浮在消息区底部之上） */}
      <div className="relative z-10 h-0">
        {!atBottom && (
          <button
            onClick={scrollToBottom}
            className="ios-press absolute -top-11 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-pill border border-white/12 bg-popover/85 px-3.5 py-1.5 text-[11.5px] text-foreground shadow-float backdrop-blur-glass animate-pop-in"
          >
            <ArrowDown className="h-3 w-3" />
            回到底部
          </button>
        )}
      </div>

      {/* 工具审批条：紧贴输入区上方（原实现放在输入区之后，实际渲染在窗口最底部，
          与"固定在输入区上方"的预期不符，且容易被误认为状态栏） */}
      {approval && (
        <div className="animate-pop-in mx-3 mb-1.5 rounded-xl border border-amber-300/25 bg-amber-500/[0.09] p-3 shadow-float backdrop-blur-glass">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-amber-300">需要确认工具调用</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-cyan-300">
                {toolLabel(approval.toolCall?.name || '')}
                {approval.toolCall?.name && toolLabel(approval.toolCall.name) !== approval.toolCall.name && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground/50">{approval.toolCall.name}</span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <button onClick={() => { window.cnke.toolApprove.respond(approval.requestId, false); setApproval(null); }} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-accent">拒绝</button>
              <button onClick={() => { window.cnke.toolApprove.respond(approval.requestId, true); setApproval(null); }} className="rounded-lg btn-gradient px-3 py-1.5 text-xs">允许</button>
            </div>
          </div>
        </div>
      )}

      {/* 输入区：底部渐隐玻璃托底，让输入卡片"浮"在对话之上 */}
      <div className="composer-dock px-3 pb-3 pt-2">
        {/* 顶部拖动手柄：上下拖动调整输入框高度 */}
        <div
          onMouseDown={handleResizeMouseDown}
          className="flex items-center justify-center mb-1.5 -mt-0.5 h-3 cursor-ns-resize group select-none"
          title="上下拖动调整输入框高度"
        >
          <div className="h-1 w-14 rounded-pill bg-white/15 group-hover:bg-primary/70 transition-colors" />
        </div>
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {images.map((img, i) => (
              <div key={`paste-${i}`} className="relative group">
                <img src={img} alt={`粘贴${i + 1}`} className="h-16 rounded-md border border-border" />
                <button
                  onClick={() => setImages(images.filter((_, idx) => idx !== i))}
                  className="absolute -top-1.5 -right-1.5 bg-red-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {files.map((f) => (
              <div key={f.id} className="relative group flex items-center gap-1.5 bg-secondary/70 border border-border rounded-md px-2 py-1 text-[11px] text-foreground/80">
                <FileText className="w-3 h-3 text-primary/70 shrink-0" />
                <span className="max-w-[150px] truncate">{f.name}</span>
                <span className="text-muted-foreground/70 shrink-0">{fmtSize(f.size)}</span>
                {f.truncated && (
                  <span className="text-amber-500/90 shrink-0 text-[10px]" title={`文件过大，AI 将只读取前 ${MAX_FILE_TEXT_CHARS} 字符`}>截断</span>
                )}
                <button
                  onClick={() => setFiles(files.filter((x) => x.id !== f.id))}
                  className="absolute -top-1.5 -right-1.5 bg-red-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {/* 整体输入卡片：顶部附件工具条 + 主输入区（统一边框） */}
        <div className="brand-ring composer-card overflow-hidden">
          {/* 顶部工具条：附件 / 引用 / PPT 等"给输入注入内容"的入口 */}
          <div className="flex items-center gap-0.5 px-2 py-[5px] border-b border-white/[0.06] bg-white/[0.03]">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
              title="上传文件/图片（AI 分析用，支持文本、代码、图片，Ctrl+V 可粘贴截图）"
            >
              <Paperclip className="w-3.5 h-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void handleFileSelect(e)}
              aria-label="上传文件"
            />
            {/* 语音输入：内置离线中文识别，落定文字实时追加到输入框 */}
            <VoiceInputButton
              onText={(text: string) =>
                setInput((prev: string) => {
                  // 落定文本与已有内容之间智能衔接：空输入直接填入，否则补空格
                  if (!prev) return text;
                  const needSpace = !/\s$/.test(prev) && !/^\s/.test(text);
                  return prev + (needSpace ? ' ' : '') + text;
                })
              }
              className="w-8 h-8"
            />
            <button
              onClick={openRefPicker}
              disabled={!workspacePath}
              className="p-1.5 text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              title="引用文件/文件夹（@ 路径）或代码库检索（#codebase 关键词）"
            >
              <AtSign className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => window.cnke.ppt.open()}
              className="p-1.5 text-fuchsia-400 hover:text-fuchsia-300 hover:bg-fuchsia-500/10 rounded-md transition-colors"
              title="生成 PPT（独立窗口）"
            >
              <Presentation className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 主输入框行：模式 + 输入 + 增强 + 发送 */}
          <div className="flex items-end gap-1.5 p-2">
            <button
              onClick={() => setAutoMode(!autoMode)}
              className={
                autoMode
                  ? 'p-1.5 rounded-md transition-colors shrink-0 text-amber-400 hover:text-amber-300 hover:bg-amber-500/10'
                  : 'p-1.5 rounded-md transition-colors shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent'
              }
              title={autoMode ? '全自动模式已开启：工具调用自动批准' : '开启全自动模式：工具调用自动批准'}
            >
              <Zap className={autoMode ? 'w-4 h-4 fill-amber-400 text-amber-400' : 'w-4 h-4'} />
            </button>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={workspacePath ? '输入需求 · Enter 发送 · @文件 / #codebase / 上传 · 输入 /ppt 主题 打开 PPT 生成' : '请先打开工作区'}
              rows={2}
              style={{ minHeight: inputHeight, maxHeight: 256 }}
              className="flex-1 bg-transparent outline-none resize-none text-[13px] leading-relaxed placeholder:text-muted-foreground/50 overflow-y-auto"
            />
            <button
              onClick={() => void handleEnhance()}
              disabled={!input.trim() || enhancing}
              className={`p-1.5 rounded-md transition-colors shrink-0 ${
                !input.trim() || enhancing
                  ? 'text-muted-foreground/40 cursor-not-allowed'
                  : 'text-violet-400 hover:text-violet-300 hover:bg-violet-500/10'
              }`}
              title="AI 一键增强输入"
            >
              <Wand2 className={`w-4 h-4 ${enhancing ? 'animate-spin' : ''}`} />
            </button>
            {loading ? (
              <button
                onClick={handleStop}
                className="ios-press w-8 h-8 flex items-center justify-center rounded-[11px] bg-rose-500/85 hover:bg-rose-500 shadow-soft shrink-0"
                title="停止生成"
                aria-label="停止生成"
              >
                <Square className="w-3.5 h-3.5 text-white" />
              </button>
            ) : (
              <button
                onClick={() => void handleSend()}
                disabled={!input.trim() && images.length === 0 && files.length === 0}
                className={`w-8 h-8 flex items-center justify-center rounded-[11px] shrink-0 ${
                  !input.trim() && images.length === 0 && files.length === 0
                    ? 'bg-white/[0.07] text-muted-foreground/60 cursor-not-allowed'
                    : 'btn-gradient'
                }`}
                title="发送"
                aria-label="发送"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-1.5 mt-1.5 px-0.5">
          {/* 模型切换 */}
          <ModelSwitcher />
          {/* Agent 模式切换 */}
          <div className="segmented shrink-0">
            <button
              type="button"
              disabled={loading}
              aria-pressed={autoInteraction}
              aria-label="智能切换交互模式"
              title="自动识别 Ask / Craft / Plan；不会开启自动审批"
              onClick={() => setAutoInteraction(!autoInteraction)}
              className={`segmented__item text-[10px] ${autoInteraction ? 'text-cyan-400 bg-white/[0.12]' : 'text-muted-foreground'}`}
            >
              智能
            </button>
            {MODES.map((m) => (
              <button
                key={m.id}
                disabled={loading}
                onClick={() => setMode(m.id)}
                className={`segmented__item ${
                  mode === m.id
                    ? `bg-white/[0.12] border border-white/[0.16] shadow-soft ${m.color}`
                    : 'text-muted-foreground border-0'
                }`}
                title={m.label}
                aria-label={m.label}
                aria-pressed={mode === m.id}
              >
                {m.icon}
                <span className="hidden xl:inline">{m.label}</span>
              </button>
            ))}
          </div>
        </div>
        {/* 状态提示行：模式 / 全自动 / 会话保存 */}
        <p className="text-[10px] text-muted-foreground/50 mt-1.5 px-1 flex items-center gap-1.5 truncate">
          <span>{autoInteraction ? '智能 · ' : ''}{MODES.find((m) => m.id === mode)?.label} 模式</span>
          {conversation && (
            <span data-testid="conversation-context" className="truncate" title={conversation.reason}>
              {conversation.language.toUpperCase()} · {conversation.topic}
              {conversation.resetHistory ? ' · 新话题' : ''}
            </span>
          )}
          {autoMode && (
            <span className="text-amber-500/80 flex items-center gap-0.5 shrink-0">
              <Zap className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />
              全自动运行
            </span>
          )}
          <span className="text-muted-foreground/30 shrink-0">·</span>
          <span className="truncate">支持上传文件/图片 · 会话自动保存</span>
        </p>
      </div>

      <div
        data-testid="chat-ai-disclaimer"
        className="shrink-0 select-none pointer-events-none px-3 pb-2 text-center text-[10px] leading-4 tracking-wide text-muted-foreground/60"
      >
        内容由 AI 生成，请核实重要信息。
      </div>

      {/* @ 引用 / #codebase 选择器 */}
      <RefPicker
        open={refPickerOpen}
        onClose={() => setRefPickerOpen(false)}
        onPickFile={handlePickFile}
        onPickDir={handlePickDir}
        onPickCodebase={handlePickCodebase}
        anchor={refAnchor}
      />

      {/* 本地记忆管理面板 */}
      {memoryOpen && (
        <MemoryPanel workspaceId={(activeWorkspaceId || workspacePath) || undefined} onClose={() => setMemoryOpen(false)} />
      )}

      {/* 文件快照（Checkpoint）面板 */}
      {checkpointOpen && <CheckpointPanel sessionId={sessionId} onClose={() => setCheckpointOpen(false)} />}

      {/* 工具审批信任规则面板 */}
      {approvalRulesOpen && <ApprovalRulesPanel onClose={() => setApprovalRulesOpen(false)} />}
    </div>
  );
};

export default ChatPanel;
