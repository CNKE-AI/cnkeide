import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import { useChatStore, ChatMessage, AgentMode, UploadedFile, MAX_FILE_TEXT_CHARS, MAX_UPLOAD_FILES } from '../../store/chatStore';
import { useApp } from '../../store/AppProvider';
import Markdown from './Markdown';
import ToolCallView from './ToolCallView';
import { MemoryPanel } from './MemoryPanel';
import {
  Send, Square, Brain, Hammer, Bug, MessageCircleQuestion,
  Plus, Trash2, ChevronDown, ChevronRight, Paperclip, Sparkles, Zap, MessageCircle,
  Copy, Check, Wand2, RotateCcw, RefreshCw, FileText, BrainCircuit, BookmarkPlus, X, FolderPlus, AtSign, CornerUpLeft,
  Presentation,
} from 'lucide-react';
import RefPicker from './RefPicker';
import { resolveAllRefs } from '../../utils/promptRefs';
import ContextBar from './ContextBar';
import PlanPanel from './PlanPanel';
import ModelSwitcher from './ModelSwitcher';
import SessionToolbar from './SessionToolbar';
import CheckpointPanel from './CheckpointPanel';
import ApprovalRulesPanel from './ApprovalRulesPanel';
import { useUiStore } from '../../store/uiStore';
import { History, ShieldCheck } from 'lucide-react';

const MODES: { id: AgentMode; label: string; icon: React.ReactNode; color: string }[] = [
  { id: 'ask', label: 'Ask', icon: <MessageCircleQuestion className="w-3.5 h-3.5" />, color: 'text-amber-400' },
  { id: 'coder', label: 'Craft', icon: <Hammer className="w-3.5 h-3.5" />, color: 'text-violet-400' },
  { id: 'architect', label: 'Plan', icon: <Brain className="w-3.5 h-3.5" />, color: 'text-cyan-400' },
  { id: 'debugger', label: 'Debug', icon: <Bug className="w-3.5 h-3.5" />, color: 'text-emerald-400' },
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
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
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

const MessageBubble: React.FC<{
  msg: ChatMessage;
  onRegenerate?: (id: string) => void;
  onRemember?: (content: string) => Promise<boolean>;
  onRollbackTo?: (id: string) => void;
}> = ({ msg, onRegenerate, onRemember, onRollbackTo }) => {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [remembered, setRemembered] = useState(false);

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
      <div className="flex justify-end mb-3">
        <div className="max-w-[85%] bg-primary/15 border border-primary/20 rounded-xl rounded-tr-sm px-3.5 py-2.5 shadow-sm">
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
          <p className="text-[13px] whitespace-pre-wrap break-words leading-relaxed">{msg.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 mb-1 text-[11px] text-muted-foreground">
        <span className="w-4 h-4 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
          <Sparkles className="w-2.5 h-2.5 text-white" />
        </span>
        <span className="font-medium">CnkeIDE</span>
      </div>

      {msg.modelNotice && (
        <div className="mb-1.5 text-[11px] text-amber-400/90 bg-amber-400/10 border border-amber-400/30 rounded-md px-2 py-1.5">
          {msg.modelNotice}
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
        <div className="mb-1.5 space-y-1">
          {msg.toolCalls.map((tc, i) => (
            <ToolCallView key={`tc-${i}`} call={tc} />
          ))}
        </div>
      )}

      {msg.content ? (
        <div className="pl-0.5">
          <Markdown content={msg.content} />
        </div>
      ) : null}

      {/* AI 回复底部工具条：复制 + token 消耗（不加气泡包裹） */}
      {msg.content ? (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground/70">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent hover:text-foreground transition-colors"
            title="复制回复内容"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? '已复制' : '复制'}
          </button>
          {onRemember && msg.content && (
            <button
              onClick={handleRemember}
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
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent hover:text-foreground transition-colors"
              title="重新回答"
            >
              <RefreshCw className="w-3 h-3" />
              重新回答
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
        </div>
      ) : null}
    </div>
  );
};

const ChatPanel: React.FC = () => {
  const { messages, sessionId, sessions, loading, mode, autoMode, setMode, setAutoMode, initAutoMode, sendMessage, abort, refreshSessions, startNewSession, switchSession, removeSession, rollback, regenerateMessage, activeWorkspaceId } = useChatStore();
  const { workspacePath, setWorkspacePath, settingsOpen } = useApp();
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [enhancing, setEnhancing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [inputHeight, setInputHeight] = useState(80);
  const inputHeightRef = useRef(inputHeight);
  inputHeightRef.current = inputHeight;
  const [approval, setApproval] = useState<any>(null);
  const autoModeRef = useRef(autoMode);
  autoModeRef.current = autoMode;
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [approvalRulesOpen, setApprovalRulesOpen] = useState(false);
  const { refreshContext, refreshPlan, pendingPrompt, setPendingPrompt } = useUiStore();

  // 切换会话时：拉取该会话的上下文占用与计划状态
  useEffect(() => {
    if (!sessionId) return;
    refreshContext(sessionId);
    refreshPlan(sessionId);
  }, [sessionId, refreshContext, refreshPlan]);

  // 编辑器选区发送：把选中代码注入到输入框
  useEffect(() => {
    if (pendingPrompt !== null) {
      setInput((prev) => (prev ? prev + '\n' : '') + pendingPrompt);
      setPendingPrompt(null);
    }
  }, [pendingPrompt, setPendingPrompt]);

  useEffect(() => {
    initAutoMode();
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
    useChatStore.setState({ streamingContent: '' });
    let cancelled = false;
    (async () => {
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const handleSend = async () => {
    if (!input.trim() && images.length === 0 && files.length === 0) return;
    if (loading) return;

    // 快捷指令：/ppt [主题] —— 直接打开 PPT 窗口并预填主题
    const raw = input.trim();
    if (/^\/ppt(\s|$)/i.test(raw)) {
      const topic = raw.replace(/^\/ppt\s*/i, '').trim();
      setInput('');
      // 通过 IPC 通知 PPT 窗口预填主题（如果已打开）
      try { window.cnke.ppt.openWithTopic?.(topic); } catch {}
      window.cnke.ppt.open();
      return;
    }

    const ws = activeWorkspaceId || workspacePath;
    if (!ws) {
      alert('请先打开一个工作区文件夹');
      return;
    }
    // 解析 @文件/@目录 与 #codebase 检索，注入实际内容
    const resolved = await resolveAllRefs(raw, ws);
    const prompt = resolved.prompt;
    setInput('');
    setImages([]);
    setFiles([]);
    await sendMessage(
      prompt,
      ws,
      images.length > 0 ? images : undefined,
      files.length > 0 ? files : undefined,
    );
  };

  /** 选择本地文件上传：图片走多模态 images，文本/代码读取内容随消息发送供 AI 分析 */
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    e.target.value = ''; // 允许再次选择同一文件
    if (list.length === 0) return;
    const total = images.length + files.length + list.length;
    if (total > MAX_UPLOAD_FILES) {
      alert(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件/图片，当前将超出上限`);
      return;
    }
    const newImgs: string[] = [];
    const newFiles: UploadedFile[] = [];
    for (const file of list) {
      if (file.type.startsWith('image/')) {
        if (file.size > 15 * 1024 * 1024) {
          alert(`图片「${file.name}」超过 15MB，已跳过`);
          continue;
        }
        const dataUrl = await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });
        if (dataUrl) newImgs.push(dataUrl);
        else alert(`图片「${file.name}」读取失败，请重试`);
      } else {
        const r = await readTextFile(file);
        if (!r) {
          alert(`「${file.name}」不是可分析的文本/代码文件，AI 暂无法读取（可先解压或转成 txt/json 后再上传）`);
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: string[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              imgs.push(reader.result);
              setImages((prev) => [...prev, ...imgs]);
            }
          };
          reader.readAsDataURL(file);
        }
      }
    }
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

  const handleDeleteCurrent = () => {
    const ws = activeWorkspaceId || workspacePath;
    if (!ws || !sessionId || loading) return;
    if (window.confirm('删除当前对话？此操作不可恢复。')) {
      removeSession(ws, sessionId);
    }
  };

  const [memoryOpen, setMemoryOpen] = useState(false);

  /** 把 AI 回复的要点存入本地记忆（供后续对话自动加载） */
  const rememberToMemory = async (content: string): Promise<boolean> => {
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
        alert(res.error || '保存失败');
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  // 回滚到任意消息：删除该消息之后的所有消息
  const handleRollbackTo = async (messageId: string) => {
    if (!sessionId || loading) return;
    if (!window.confirm('回滚到此消息会删除之后的所有消息，是否继续？')) return;
    const res = await window.cnke.sessionEx.deleteMessage(sessionId, messageId);
    if (!res.success) {
      alert(res.error || '回滚失败');
      return;
    }
    const ws = activeWorkspaceId || workspacePath;
    if (ws) await refreshSessions(ws);
    if (ws) await switchSession(ws, sessionId);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 顶部：会话切换 + 模式切换 + 新建 */}
      <div className="px-2 pt-2 pb-2 border-b border-border bg-secondary/10">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 flex items-center gap-1.5">
            <MessageCircle className="w-3.5 h-3.5 text-primary" />
            对话
          </span>
          <div className="flex items-center gap-0.5">
            <button onClick={() => setMemoryOpen(true)} className="p-1.5 hover:bg-accent hover:text-foreground rounded-md transition-colors text-muted-foreground" title="本地记忆：查看 / 管理跨对话自动加载的上下文与偏好">
              <BrainCircuit className="w-3.5 h-3.5" />
            </button>
            <div className="flex items-center">
              <button onClick={handleNewChat} className="p-1.5 hover:bg-accent hover:text-foreground rounded-md transition-colors" title="新建对话（当前工作区）">
                <Plus className="w-3.5 h-3.5" />
              </button>
              <button onClick={handleNewChatNewWorkspace} className="p-1.5 hover:bg-accent hover:text-foreground rounded-md transition-colors" title="新建对话并选择新工作区目录">
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={() => { const ws = activeWorkspaceId || workspacePath; if (ws) rollback(ws); }}
              disabled={loading || messages.length === 0}
              className="p-1.5 hover:bg-accent hover:text-foreground rounded-md transition-colors disabled:opacity-40"
              title="回滚：撤销上一轮对话"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button onClick={handleDeleteCurrent} disabled={loading} className="p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded-md transition-colors disabled:opacity-40" title="删除当前对话">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setCheckpointOpen(true)} className="p-1.5 hover:bg-accent hover:text-foreground rounded-md transition-colors text-muted-foreground" title="文件快照（Checkpoint）查看/恢复">
              <History className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setApprovalRulesOpen(true)} className="p-1.5 hover:bg-accent hover:text-foreground rounded-md transition-colors text-muted-foreground" title="工具审批信任规则">
              <ShieldCheck className="w-3.5 h-3.5" />
            </button>
            <SessionToolbar sessionId={sessionId} workspaceId={activeWorkspaceId || workspacePath} onImport={() => { refreshSessions(workspacePath || activeWorkspaceId || ''); }} onSummarized={() => { if (sessionId) refreshContext(sessionId); }} />
          </div>
        </div>
        {/* 多会话标签栏：点击切换，删除在右侧按钮 */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
          {sessions.length === 0 ? (
            <span className="text-[10px] text-muted-foreground/50 px-1">暂无历史对话，发送消息后自动保存为可切换的会话</span>
          ) : (
            sessions.map((s) => {
              const active = s.id === sessionId;
              return (
                <div
                  key={s.id}
                  className={`group flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] whitespace-nowrap transition-colors shrink-0 ${
                    active
                      ? 'bg-primary/15 border-primary/40 text-foreground glow-primary'
                      : 'border-border text-muted-foreground hover:bg-accent/60'
                  } ${loading ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
                >
                  <button
                    onClick={() => switchSession(s.workspaceId || workspacePath!, s.id)}
                    disabled={loading}
                    title={s.title || '新对话'}
                    className="flex items-center gap-1 shrink-0"
                  >
                    <MessageCircle className={`w-3 h-3 shrink-0 ${active ? 'text-primary' : 'opacity-60'}`} />
                    <span className="max-w-[140px] truncate">{s.title || '新对话'}</span>
                    {s.workspaceId && s.workspaceId !== (activeWorkspaceId || workspacePath) && (
                      <span className="text-[9px] text-muted-foreground/50 shrink-0">{window.cnke.path.basename(s.workspaceId)}</span>
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (s.workspaceId && !loading) {
                        if (window.confirm(`关闭对话「${s.title || '新对话'}」？`)) {
                          removeSession(s.workspaceId, s.id);
                        }
                      }
                    }}
                    disabled={loading}
                    title="关闭此对话"
                    className="ml-0.5 p-0.5 rounded hover:bg-red-500/20 hover:text-red-400 text-muted-foreground/60 transition-colors shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 上下文占用进度条 */}
      <ContextBar />

      {/* 计划面板 */}
      <PlanPanel />

      {/* 消息列表 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 text-muted-foreground">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border border-primary/20 flex items-center justify-center">
              <Sparkles className="w-7 h-7 text-primary/60" />
            </div>
            <p className="text-sm font-medium text-foreground/80">开始你的 AI 编程之旅</p>
            <p className="text-xs max-w-[220px]">
              {workspacePath ? '描述你的需求，AI 将读取代码、编写文件、执行命令完成任务' : '请先通过左上角打开文件夹'}
            </p>
            {!workspacePath && (
              <button
                onClick={async () => {
                  const p = await window.cnke.fs.openFolder();
                  if (p) {
                    window.location.reload();
                  }
                }}
                className="text-xs border border-border rounded-lg px-3.5 py-1.5 hover:bg-accent transition-colors mt-1"
              >
                打开文件夹
              </button>
            )}
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} onRegenerate={(id) => { const ws = activeWorkspaceId || workspacePath; if (ws) regenerateMessage(ws, id); }} onRemember={rememberToMemory} onRollbackTo={handleRollbackTo} />
        ))}
        {loading && (
          <div className="flex items-center gap-1.5 text-muted-foreground text-xs px-1 py-2">
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="p-2.5 border-t border-border bg-secondary/20">
        {/* 顶部拖动手柄：上下拖动调整下方输入框高度 */}
        <div
          onMouseDown={handleResizeMouseDown}
          className="flex items-center justify-center -mt-2.5 mb-1 h-3 cursor-ns-resize group select-none"
          title="上下拖动调整输入框高度"
        >
          <div className="h-1 w-12 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
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
        <div className="bg-card border border-border rounded-xl focus-within:ring-1 focus-within:ring-primary/50 focus-within:border-primary/40 transition-all overflow-hidden">
          {/* 顶部工具条：附件 / 引用 / PPT 等"给输入注入内容"的入口 */}
          <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border/50">
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
              onChange={handleFileSelect}
              aria-label="上传文件"
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
          <div className="flex items-end gap-2 p-1.5">
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
              style={{ height: inputHeight }}
              className="flex-1 bg-transparent outline-none resize-none text-[13px] leading-relaxed placeholder:text-muted-foreground/50 overflow-y-auto"
            />
            <button
              onClick={handleEnhance}
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
                className="p-2 bg-red-600/80 hover:bg-red-600 rounded-lg transition-colors shrink-0"
                title="停止生成"
              >
                <Square className="w-4 h-4 text-white" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() && images.length === 0 && files.length === 0}
                className={`p-2 rounded-lg transition-colors shrink-0 ${
                  !input.trim() && images.length === 0 && files.length === 0
                    ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                    : 'btn-gradient'
                }`}
                title="发送"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 mt-1.5 px-0.5">
          {/* 模型切换 */}
          <ModelSwitcher />
          {/* Agent 模式切换 */}
          <div className="flex items-center gap-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors ${
                  mode === m.id
                    ? `bg-primary/15 border border-primary/30 ${m.color}`
                    : 'text-muted-foreground hover:bg-accent/60 border border-transparent'
                }`}
                title={m.label}
              >
                {m.icon}
                <span className="hidden md:inline">{m.label}</span>
              </button>
            ))}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground/60 mt-1 px-1">
          模式：{MODES.find((m) => m.id === mode)?.label}
          {autoMode && <span className="text-amber-500/90"> · 全自动运行</span>} · 支持上传文件/图片 · 会话自动保存
        </p>
      </div>

      {/* 工具审批弹窗 */}
      {approval && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl p-4 w-[380px] shadow-2xl">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-primary text-sm font-semibold">工具调用确认</span>
            </div>
            <div className="bg-secondary/40 rounded-lg p-2.5 mb-3 font-mono text-[12px] break-all">
              <div className="text-cyan-300 mb-1">{approval.toolCall?.name}</div>
              <pre className="text-foreground/80 whitespace-pre-wrap text-[11px] max-h-32 overflow-y-auto">
                {JSON.stringify(approval.toolCall?.arguments ?? {}, null, 2)}
              </pre>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { window.cnke.toolApprove.respond(approval.requestId, false); setApproval(null); }}
                className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent transition-colors"
              >
                拒绝
              </button>
              <button
                onClick={() => { window.cnke.toolApprove.respond(approval.requestId, true); setApproval(null); }}
                className="px-3 py-1.5 text-xs btn-gradient rounded-lg transition-colors"
              >
                允许
              </button>
            </div>
          </div>
        </div>
      )}

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
