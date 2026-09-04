import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, X, Plus, Trash2, Loader2 } from 'lucide-react';

interface Rule {
  toolName: string;
  pathPattern?: string;
  commandPattern?: string;
  action: 'allow' | 'deny' | 'ask';
  source?: string;
}

interface Props {
  onClose: () => void;
}

const ACTION_LABEL: Record<string, { label: string; cls: string }> = {
  allow: { label: '允许', cls: 'text-emerald-400' },
  deny: { label: '拒绝', cls: 'text-rose-400' },
  ask: { label: '询问', cls: 'text-amber-400' },
};

/** 工具审批信任规则管理面板 */
const ApprovalRulesPanel: React.FC<Props> = ({ onClose }) => {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(false);
  const [toolName, setToolName] = useState('');
  const [pathPattern, setPathPattern] = useState('');
  const [commandPattern, setCommandPattern] = useState('');
  const [action, setAction] = useState<'allow' | 'deny' | 'ask'>('ask');

  const load = async () => {
    setLoading(true);
    try {
      setRules((await window.cnke.approval.listRules()) || []);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleAdd = async () => {
    if (!toolName.trim()) {
      alert('请填写工具名');
      return;
    }
    const rule: Rule = { toolName: toolName.trim(), action };
    if (pathPattern.trim()) rule.pathPattern = pathPattern.trim();
    if (commandPattern.trim()) rule.commandPattern = commandPattern.trim();
    await window.cnke.approval.addRule(rule);
    setToolName('');
    setPathPattern('');
    setCommandPattern('');
    await load();
  };

  const handleRemove = async (index: number) => {
    await window.cnke.approval.removeRule(index);
    await load();
  };

  return createPortal(
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl w-[520px] max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            工具审批信任规则
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-md transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 添加规则表单 */}
        <div className="px-4 py-3 border-b border-border space-y-2">
          <div className="flex gap-2">
            <input
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="工具名，如 write_file"
              className="flex-1 bg-secondary/40 border border-border rounded-lg px-2.5 py-1.5 text-[12px] outline-none focus:border-primary/50"
            />
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as any)}
              className="bg-secondary/40 border border-border rounded-lg px-2 py-1.5 text-[12px] outline-none"
            >
              <option value="ask">询问</option>
              <option value="allow">允许</option>
              <option value="deny">拒绝</option>
            </select>
            <button onClick={handleAdd} className="px-2.5 py-1.5 bg-primary/15 border border-primary/30 text-primary rounded-lg hover:bg-primary/25 transition-colors text-[12px] flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" />
              添加
            </button>
          </div>
          <div className="flex gap-2">
            <input
              value={pathPattern}
              onChange={(e) => setPathPattern(e.target.value)}
              placeholder="路径模式（可选），如 src/*.ts"
              className="flex-1 bg-secondary/40 border border-border rounded-lg px-2.5 py-1.5 text-[11px] outline-none focus:border-primary/50"
            />
            <input
              value={commandPattern}
              onChange={(e) => setCommandPattern(e.target.value)}
              placeholder="命令模式（可选），如 npm install"
              className="flex-1 bg-secondary/40 border border-border rounded-lg px-2.5 py-1.5 text-[11px] outline-none focus:border-primary/50"
            />
          </div>
        </div>

        {/* 规则列表 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          ) : rules.length === 0 ? (
            <div className="text-center text-muted-foreground/60 text-[12px] py-8">暂无信任规则</div>
          ) : (
            rules.map((r, i) => {
              const meta = ACTION_LABEL[r.action] || ACTION_LABEL.ask;
              return (
                <div key={i} className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 bg-secondary/20">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-mono text-foreground">{r.toolName}</span>
                      <span className={`text-[10px] font-medium ${meta.cls}`}>{meta.label}</span>
                    </div>
                    {(r.pathPattern || r.commandPattern) && (
                      <div className="text-[10px] text-muted-foreground/60 mt-0.5">
                        {r.pathPattern && <span>路径: {r.pathPattern}</span>}
                        {r.pathPattern && r.commandPattern && ' · '}
                        {r.commandPattern && <span>命令: {r.commandPattern}</span>}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemove(i)}
                    className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-accent rounded-md transition-colors"
                    title="删除规则"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ApprovalRulesPanel;
