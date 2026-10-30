import { useEffect, useRef, useState } from 'react';
import type { MemoryItem, MemoryType, MemoryScope, MemorySettings } from '../../global';
import {
  X, Plus, Trash2, BrainCircuit, BookmarkCheck, RefreshCw, AlertTriangle, Save,
} from 'lucide-react';

const TYPE_LABEL: Record<MemoryType, string> = {
  preference: '偏好',
  project: '项目',
  summary: '摘要',
  manual: '手动',
};
const TYPE_COLOR: Record<MemoryType, string> = {
  preference: 'text-cyan-400 border-cyan-500/40 bg-cyan-500/10',
  project: 'text-violet-400 border-violet-500/40 bg-violet-500/10',
  summary: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
  manual: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10',
};
const SCOPE_LABEL: Record<MemoryScope, string> = {
  global: '全局',
  workspace: '工作区',
};

const DEFAULT_SETTINGS: MemorySettings = {
  enabled: true,
  autoLoad: true,
  autoExtract: false,
  injectBudgetChars: 5000,
};

const MAX_CHARS = 4000;
const MAX_ITEMS = 120;

function fmtDate(ts?: number): string {
  if (!ts) return '长期有效';
  const days = Math.ceil((ts - Date.now()) / 86400000);
  if (days <= 0) return '已过期';
  if (days >= 3650) return '长期有效';
  if (days >= 90) return `${Math.floor(days / 30)} 个月后过期`;
  return `${days} 天后过期`;
}

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`w-8 h-[18px] rounded-full transition-colors shrink-0 relative ${checked ? 'bg-primary' : 'bg-secondary border border-border'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <span className={`absolute top-0.5 w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${checked ? 'left-[14px]' : 'left-0.5'}`} />
    </button>
  );
}

interface Draft {
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  importance: number;
  expiresInDays: number; // 0 = 长期
}

const EMPTY_DRAFT: Draft = { content: '', type: 'manual', scope: 'workspace', importance: 2, expiresInDays: 0 };

export function MemoryPanel({ workspaceId, onClose }: { workspaceId?: string; onClose: () => void }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [settings, setSettings] = useState<MemorySettings>(DEFAULT_SETTINGS);
  const [editing, setEditing] = useState<{ id?: string; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const load = async () => {
    try {
      const list = await window.cnke.memory.list();
      setItems(list);
    } catch (e) {
      setError(`读取记忆失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => {
    load();
    window.cnke.config.get('memory.settings').then((v) => {
      if (v && typeof v === 'object') setSettings({ ...DEFAULT_SETTINGS, ...v });
    });
  }, []);

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  const saveSettings = async (next: MemorySettings) => {
    setSettings(next);
    try {
      await window.cnke.config.set('memory.settings', next);
    } catch {
      /* 静默：UI 已即时生效 */
    }
  };

  const openEdit = (item?: MemoryItem) => {
    setError(null);
    if (!item) {
      setEditing({ draft: { ...EMPTY_DRAFT, scope: workspaceId ? 'workspace' : 'global' } });
      return;
    }
    const remaining = item.expiresAt ? Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 86400000)) : 0;
    setEditing({
      id: item.id,
      draft: {
        content: item.content,
        type: item.type,
        scope: item.scope,
        importance: item.importance,
        expiresInDays: item.expiresAt ? remaining : 0,
      },
    });
  };

  const submitDraft = async () => {
    if (!editing) return;
    const content = editing.draft.content.trim();
    if (!content) {
      setError('记忆内容不能为空');
      return;
    }
    if (content.length > MAX_CHARS) {
      setError(`内容超出上限（最多 ${MAX_CHARS} 字符）`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing.id) {
        const res = await window.cnke.memory.update(editing.id, {
          ...editing.draft,
          content,
          expiresInDays: editing.draft.expiresInDays > 0 ? editing.draft.expiresInDays : 0,
        });
        if (!res.success) setError(res.error || '更新失败');
      } else {
        const res = await window.cnke.memory.add({
          ...editing.draft,
          content,
          workspaceId: editing.draft.scope === 'workspace' ? workspaceId : undefined,
        });
        if (!res.success) setError(res.error || '保存失败');
      }
      if (!error) setEditing(null);
      await load();
    } catch (e) {
      setError(`保存异常：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (item: MemoryItem) => {
    setBusyId(item.id);
    try {
      await window.cnke.memory.update(item.id, { enabled: !item.enabled });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const removeItem = async (id: string) => {
    if (!window.confirm('确定删除这条记忆？')) return;
    await window.cnke.memory.delete(id);
    await load();
  };

  const clearAll = async () => {
    if (!window.confirm(`确定清空全部 ${items?.length ?? 0} 条记忆？此操作不可恢复。`)) return;
    await window.cnke.memory.clear();
    await load();
  };

  const visible = items || [];

  return (
    <div className="overlay-mask z-50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-strong w-[720px] max-w-[94vw] h-[82vh] flex flex-col rounded-[22px] overflow-hidden animate-pop-in">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.07] bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-500/25 to-violet-500/25 border border-primary/30 flex items-center justify-center">
              <BrainCircuit className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">本地记忆</h2>
              <p className="text-[10px] text-muted-foreground">
                跨对话持久保存偏好 / 项目上下文 / 对话要点，调用时自动加载，减少重复交代
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-accent hover:text-foreground rounded-md text-muted-foreground transition-colors" title="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 设置区 */}
        <div className="px-4 py-2.5 border-b border-border space-y-1.5 text-[12px] bg-secondary/5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground/90">启用记忆</span>
              <span className="text-muted-foreground">关闭后既不注入也不再自动提取</span>
            </div>
            <Switch checked={settings.enabled} onChange={(v) => saveSettings({ ...settings, enabled: v })} />
          </div>
          <div className={`flex items-center justify-between gap-3 transition-opacity ${settings.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground/90">自动加载</span>
              <span className="text-muted-foreground">每次对话自动注入匹配记忆（单次预算 {settings.injectBudgetChars} 字符）</span>
            </div>
            <Switch checked={settings.autoLoad} onChange={(v) => saveSettings({ ...settings, autoLoad: v })} />
          </div>
          <div className={`flex items-center justify-between gap-3 transition-opacity ${settings.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground/90">自动提取</span>
              <span className="text-muted-foreground">每轮对话结束后 AI 自动提炼值得记住的信息（额外一次调用，90 天后过期）</span>
            </div>
            <Switch checked={settings.autoExtract} onChange={(v) => saveSettings({ ...settings, autoExtract: v })} />
          </div>
        </div>

        {/* 工具行 */}
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => openEdit()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium btn-gradient transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              新增记忆
            </button>
            {items && (
              <span className="text-[11px] text-muted-foreground">
                {visible.length}/{MAX_ITEMS} 条
                {workspaceId ? ' · 工作区记忆按当前项目生效' : ' · 记忆将保存为全局（未打开工作区）'}
              </span>
            )}
          </div>
          <button
            onClick={clearAll}
            disabled={!items || visible.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-500/15 transition-colors disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
            清空全部
          </button>
        </div>

        {/* 编辑表单 */}
        {editing && (
          <div className="mx-4 mb-2 rounded-xl border border-primary/40 bg-secondary/20 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-primary flex items-center gap-1.5">
                <Save className="w-3 h-3" />
                {editing.id ? '编辑记忆' : '新增记忆'}
              </span>
              <button onClick={() => setEditing(null)} className="text-muted-foreground hover:text-foreground p-0.5">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <textarea
              ref={editorRef}
              value={editing.draft.content}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, content: e.target.value } })}
              placeholder="例如：用户偏好简洁的中文回复；本项目使用 React + Electron，关键代码在 electron/core-fork/agent/…"
              rows={3}
              className="w-full text-[12.5px] bg-card border border-border rounded-lg p-2 outline-none focus:border-primary/50 resize-none"
            />
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className={editing.draft.content.length > MAX_CHARS ? 'text-red-400' : ''}>
                {editing.draft.content.length}/{MAX_CHARS}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                类型
                <select
                  value={editing.draft.type}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, type: e.target.value as MemoryType } })}
                  className="bg-card border border-border rounded-md px-1.5 py-1 text-[11px] text-foreground outline-none"
                >
                  <option value="manual">手动</option>
                  <option value="preference">偏好</option>
                  <option value="project">项目</option>
                  <option value="summary">摘要</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                范围
                <select
                  value={editing.draft.scope}
                  disabled={!workspaceId}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, scope: e.target.value as MemoryScope } })}
                  className="bg-card border border-border rounded-md px-1.5 py-1 text-[11px] text-foreground outline-none disabled:opacity-40"
                >
                  <option value="global">全局</option>
                  <option value="workspace">当前工作区</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                重要性
                <select
                  value={editing.draft.importance}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, importance: Number(e.target.value) } })}
                  className="bg-card border border-border rounded-md px-1.5 py-1 text-[11px] text-foreground outline-none"
                >
                  <option value={1}>★ 一般</option>
                  <option value={2}>★★ 重要</option>
                  <option value={3}>★★★ 关键</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                有效期
                <select
                  value={editing.draft.expiresInDays}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, expiresInDays: Number(e.target.value) } })}
                  className="bg-card border border-border rounded-md px-1.5 py-1 text-[11px] text-foreground outline-none"
                >
                  <option value={0}>长期有效</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                  <option value={180}>180 天</option>
                  <option value={365}>1 年</option>
                </select>
              </label>
              <button
                onClick={submitDraft}
                disabled={saving}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium btn-gradient disabled:opacity-50"
              >
                <Save className="w-3 h-3" />
                {saving ? '保存中…' : editing.id ? '保存修改' : '保存'}
              </button>
            </div>
            {error && (
              <div className="flex items-center gap-1.5 text-[11px] text-red-400">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                {error}
              </div>
            )}
          </div>
        )}

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
          {items === null ? (
            <div className="text-center text-xs text-muted-foreground py-10">加载中…</div>
          ) : visible.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-12 h-12 mx-auto rounded-xl bg-secondary/60 border border-border flex items-center justify-center mb-3">
                <BrainCircuit className="w-6 h-6 text-muted-foreground/50" />
              </div>
              <p className="text-sm text-muted-foreground">还没有记忆</p>
              <p className="text-[11px] text-muted-foreground/60 mt-1 max-w-[340px] mx-auto">
                点击「新增记忆」手动保存；或在设置中开启「自动提取」，每次对话结束后 AI 会为你提炼要点
              </p>
            </div>
          ) : (
            visible.map((item) => (
              <div key={item.id} className={`rounded-xl border p-3 transition-opacity ${item.enabled ? 'border-border bg-secondary/30' : 'border-border bg-secondary/10 opacity-55'}`}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap break-words flex-1 line-clamp-6">{item.content}</p>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <button
                      onClick={() => openEdit(item)}
                      className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors"
                      title="编辑"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => removeItem(item.id)}
                      className="p-1 hover:bg-red-500/20 hover:text-red-400 rounded text-muted-foreground transition-colors"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${TYPE_COLOR[item.type]}`}>
                    {TYPE_LABEL[item.type]}
                  </span>
                  <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground/70`}>
                    {SCOPE_LABEL[item.scope]}
                    {item.scope === 'workspace' && (
                      <span className="ml-1 max-w-[140px] truncate opacity-60">{item.workspaceId || ''}</span>
                    )}
                  </span>
                  <span className="text-[10px] text-amber-500/90">{'★'.repeat(item.importance)}</span>
                  <span className={`text-[10px] ${item.source === 'auto' ? 'text-violet-400/80' : 'text-muted-foreground/60'}`}>
                    {item.source === 'auto' ? '自动提取' : '手动'}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60">{fmtDate(item.expiresAt)}</span>
                  <span className="flex items-center gap-1 ml-auto">
                    <Switch checked={item.enabled} disabled={busyId === item.id} onChange={() => toggleEnabled(item)} />
                    <span className="text-[10px] text-muted-foreground/70">{item.enabled ? '启用' : '停用'}</span>
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 页脚 */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-secondary/10 text-[10.5px] text-muted-foreground/70">
          <span className="flex items-center gap-1">
            <BookmarkCheck className="w-3 h-3" />
            记忆存储于本机，自动注入时按 重要性&gt;最近使用 排序并在预算内截取
          </span>
          <span>单条 ≤{MAX_CHARS} 字符 · 单次注入预算 {settings.injectBudgetChars} 字符 · 过期自动清理</span>
        </div>
      </div>
    </div>
  );
}
