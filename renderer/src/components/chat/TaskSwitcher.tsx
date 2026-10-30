import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown, FolderKanban, FolderPlus, Loader2, AlertTriangle, ArrowLeft, Check, FolderSearch,
  FolderOpen, Pencil, Archive, ArchiveRestore,
} from 'lucide-react';
import type { TaskItem } from '../../global';
import { toast } from '../../utils/toast';

export interface TaskSwitcherProps {
  /** 当前工作区绝对路径（可能是通过"打开文件夹"进来的非任务目录） */
  currentWorkspace: string | null;
  /** 切到某个任务（父层负责 setWorkspacePath + 切会话） */
  onOpenTask: (task: TaskItem) => void;
  /** 任务刚建好：父层负责切工作区并开一个会话 */
  onCreated: (task: TaskItem) => void;
  /** 当前任务被改名且目录跟着变了：父层要把工作区指到新路径 */
  onRenamed?: (task: TaskItem, previousPath: string) => void;
  /** 会话正在加载时禁止切换，避免丢掉未保存的消息 */
  disabled?: boolean;
}

/** 与 ChatHeaderMenu 一致的行样式（内联，避免循环依赖） */
const ROW_CLS =
  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-foreground/85 transition-colors hover:bg-accent';

const basename = (p: string) => window.cnke.path.basename(p) || p;
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** 行内小图标按钮（重命名/归档/定位），默认半透明，hover 行时变实 */
const ACT_CLS =
  'rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground disabled:opacity-30';

/**
 * 任务切换器（TRAE 式）：
 * 一个「任务」= 一个工作区文件夹 + 绑定该文件夹的会话。
 *
 * 为什么不复用已有的「会话标签」：
 * 会话标签是**扁平**的，十几个对话混在一起时看不出它们分属哪个文件夹；
 * 任务是更高一层的容器，先选任务、再在任务内切对话，才是实际的心智模型。
 *
 * 新建任务时文件夹由**主进程**创建（命名清洗/重名避让/失败回滚都在那边），
 * 这里只负责收集名字和位置 —— 渲染层拿不到 fs，也不该自己拼路径。
 */
const TaskSwitcher: React.FC<TaskSwitcherProps> = ({
  currentWorkspace, onOpenTask, onCreated, onRenamed, disabled,
}) => {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 新建表单：非空即处于"输入中"状态 */
  const [draftName, setDraftName] = useState<string | null>(null);
  const [parentDir, setParentDir] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /** 重命名：就地编辑某一行（不弹框、不切表单，避免误以为在新建） */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  /** 已归档默认折叠：归档的意义就是把不再动的任务从日常视野里挪开 */
  const [showArchived, setShowArchived] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.cnke.task.list();
      if (!res.success) {
        setError(res.error || '读取任务列表失败');
        return;
      }
      setTasks(res.data || []);
    } catch (e: unknown) {
      setError(errText(e, '读取任务列表失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  // 每次打开都重新拉一次：用户可能在文件管理器里删了文件夹，
  // 缓存住旧列表会点进去一个已经不存在的目录。
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setDraftName(null);
        setRenamingId(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (renamingId !== null) {
        setRenamingId(null);
        setFormError(null);
        return;
      }
      if (draftName !== null) {
        setDraftName(null);
        setFormError(null);
        return;
      }
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, draftName, renamingId]);

  // 进入新建表单时自动聚焦输入框（用布尔量做依赖，避免 draftName 每次输入都重跑）
  const editing = draftName !== null;
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startCreate = () => {
    setDraftName('');
    setFormError(null);
    setRenamingId(null);
  };

  const pickParent = async () => {
    const p = await window.cnke.fs.openFolder();
    if (p) setParentDir(p);
  };

  const submitCreate = async () => {
    const name = (draftName || '').trim();
    if (!name) {
      setFormError('请填写任务名');
      inputRef.current?.focus();
      return;
    }
    if (creating) return;
    setCreating(true);
    setFormError(null);
    try {
      const res = await window.cnke.task.create(name, parentDir || undefined);
      if (!res.success || !res.data) {
        setFormError(res.error || '创建任务失败');
        return;
      }
      const task = res.data;
      setTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)]);
      setDraftName(null);
      setOpen(false);
      // 把真实落盘路径告诉用户：命名被清洗过（例如 "a/b" → "a-b"）时，
      // 光看任务名是猜不到文件夹叫什么、落在哪的。
      toast.success(`任务「${task.name}」已创建：${task.workspacePath}`);
      onCreated(task);
    } catch (e: unknown) {
      setFormError(errText(e, '创建任务失败'));
    } finally {
      setCreating(false);
    }
  };

  const startRename = (t: TaskItem) => {
    setRenamingId(t.id);
    setRenameValue(t.name);
    setFormError(null);
  };

  /**
   * 提交重命名。
   *
   * 主进程会同时改磁盘目录名并把会话迁到新路径，所以这里必须把
   * 「当前任务被改名」的情况告诉父层 —— 否则文件树/终端还指着旧目录，
   * 用户会看到侧边栏叫新名字、左边却是个已不存在的路径。
   */
  const submitRename = async () => {
    const id = renamingId;
    const name = renameValue.trim();
    if (!id || !name) return;
    if (renaming) return;
    setRenaming(true);
    setFormError(null);
    try {
      const res = await window.cnke.task.rename(id, name);
      if (!res.success || !res.data) {
        setFormError(res.error || '重命名失败');
        return;
      }
      const updated = res.data;
      const previousPath = updated.previousPath || id;
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated, sessionCount: t.sessionCount } : t)));
      setRenamingId(null);
      // 和「创建」保持一致：改完就收起面板，别让下拉一直挡在文件树前面
      setOpen(false);
      if (updated.dirChanged) {
        // 目录被占用（终端 shell 的 cwd）时主进程会先关掉那些终端，
        // 这里说明一句，免得用户以为终端是自己崩的。
        toast.success(
          updated.terminalsClosed
            ? `任务已改名，文件夹变为「${updated.dirName}」，终端已在新目录重启`
            : `任务已改名，文件夹变为「${updated.dirName}」`,
        );
        onRenamed?.(updated, previousPath);
      } else {
        toast.success('任务名已更新（文件夹名不变）');
      }
    } catch (e: unknown) {
      setFormError(errText(e, '重命名失败'));
    } finally {
      setRenaming(false);
    }
  };

  const toggleArchive = async (t: TaskItem) => {
    const next = !t.archived;
    try {
      const res = await window.cnke.task.archive(t.id, next);
      if (!res.success) {
        toast.error(res.error || '归档失败');
        return;
      }
      setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, archived: next } : x)));
      toast.success(next ? `已归档「${t.name}」` : `已取消归档「${t.name}」`);
    } catch (e: unknown) {
      toast.error(errText(e, '归档失败'));
    }
  };

  const reveal = async (t: TaskItem) => {
    try {
      const res = await window.cnke.task.reveal(t.workspacePath);
      if (!res.success) toast.error(res.error || '无法打开文件夹');
    } catch (e: unknown) {
      toast.error(errText(e, '无法打开文件夹'));
    }
  };

  const currentName = currentWorkspace ? basename(currentWorkspace) : '未选择任务';
  const liveTasks = tasks.filter((t) => !t.archived);
  const archivedTasks = tasks.filter((t) => t.archived);

  /** 单个任务行（列表 + 已归档分组共用） */
  const renderTask = (t: TaskItem) => {
    const active = !!currentWorkspace && t.id === currentWorkspace;
    const isRenaming = renamingId === t.id;

    if (isRenaming) {
      return (
        <div key={t.id} className="px-1 py-1">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => {
              setRenameValue(e.target.value);
              setFormError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitRename();
              }
            }}
            disabled={renaming}
            className="w-full rounded-lg border border-border bg-background px-2 py-1 text-[11.5px] outline-none focus:border-primary/60"
          />
          {/* 失败原因必须显示出来：目录被占用时只在控制台报错等于"点了没反应" */}
          {formError && (
            <p className="mt-1 px-0.5 text-[10px] leading-relaxed text-rose-500">{formError}</p>
          )}
          <div className="mt-1 flex items-center justify-between gap-1">
            <span className="min-w-0 flex-1 truncate px-0.5 text-[10px] text-muted-foreground/70">
              文件夹会一起改名；已被占用则自动加 -2
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setRenamingId(null)}
                disabled={renaming}
                className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitRename()}
                disabled={renaming || !renameValue.trim()}
                className="flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[10.5px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                {renaming && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                确定
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        key={t.id}
        role="menuitem"
        tabIndex={0}
        onClick={() => {
          if (disabled || t.missing) return;
          setOpen(false);
          onOpenTask(t);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          if (disabled || t.missing) return;
          setOpen(false);
          onOpenTask(t);
        }}
        title={t.missing ? `文件夹已不存在：${t.workspacePath}` : t.workspacePath}
        className={`group ${ROW_CLS} ${active ? 'bg-primary/10' : ''} ${
          disabled || t.missing ? 'cursor-not-allowed opacity-40 hover:bg-transparent' : 'cursor-pointer'
        }`}
      >
        <FolderKanban
          className={`h-3.5 w-3.5 shrink-0 ${t.missing ? 'text-rose-500' : 'text-amber-500'}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="truncate">{t.name}</span>
            {active && <Check className="h-3 w-3 shrink-0 text-primary" />}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <span className="truncate">{t.dirName}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{t.sessionCount} 个对话</span>
            {t.missing && (
              <span className="flex shrink-0 items-center gap-0.5 text-rose-500">
                <AlertTriangle className="h-2.5 w-2.5" />
                文件夹缺失
              </span>
            )}
          </span>
        </span>

        {/* 行内操作：hover / 聚焦时才显形，平时不干扰扫读 */}
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            disabled={t.missing}
            onClick={(e) => {
              e.stopPropagation();
              void reveal(t);
            }}
            className={ACT_CLS}
            title="在资源管理器中显示"
          >
            <FolderOpen className="h-3 w-3" />
          </button>
          <button
            type="button"
            disabled={t.missing}
            onClick={(e) => {
              e.stopPropagation();
              startRename(t);
            }}
            className={ACT_CLS}
            title="重命名"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void toggleArchive(t);
            }}
            className={ACT_CLS}
            title={t.archived ? '取消归档' : '归档（只从列表隐藏，不删文件）'}
          >
            {t.archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
          </button>
        </span>
      </div>
    );
  };

  return (
    <div className="relative shrink-0" ref={boxRef}>
      <button
        type="button"
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex max-w-[160px] items-center gap-1 rounded-lg border px-1.5 py-1 text-[11px] transition-colors ${
          open
            ? 'border-primary/40 bg-primary/15 text-foreground'
            : 'border-border/50 text-muted-foreground hover:border-border hover:bg-accent/60'
        }`}
        title={currentWorkspace ? `当前任务：${currentWorkspace}` : '选择或新建任务'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FolderKanban className="h-3 w-3 shrink-0 text-amber-500" />
        <span className="truncate">{currentName}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="overlay-panel absolute left-0 top-full z-50 mt-1.5 w-[min(19rem,calc(100vw-1rem))] max-h-[min(24rem,calc(100vh-4rem))] overflow-y-auto p-1.5 text-popover-foreground"
        >
          {draftName === null ? (
            <>
              <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                任务
              </div>

              {loading && (
                <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  读取中…
                </div>
              )}

              {!loading && error && (
                <div className="px-2.5 py-2 text-[11px] text-rose-500">{error}</div>
              )}

              {!loading && !error && liveTasks.length === 0 && (
                <div className="px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground/70">
                  {archivedTasks.length > 0
                    ? '没有进行中的任务，已归档的任务在下方。'
                    : '还没有任务。新建任务会同时创建一个同名文件夹，以后这个文件夹里的代码和对话就归在这个任务下。'}
                </div>
              )}

              {liveTasks.map(renderTask)}

              {archivedTasks.length > 0 && (
                <>
                  <div className="my-1 border-t border-border/60" />
                  <button
                    type="button"
                    onClick={() => setShowArchived((v) => !v)}
                    className={`${ROW_CLS} text-muted-foreground/70`}
                  >
                    <Archive className="h-3 w-3 shrink-0" />
                    <span className="flex-1">已归档（{archivedTasks.length}）</span>
                    <ChevronDown
                      className={`h-3 w-3 shrink-0 transition-transform ${showArchived ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {showArchived && archivedTasks.map(renderTask)}
                </>
              )}

              <div className="my-1 border-t border-border/60" />
              <button type="button" role="menuitem" className={ROW_CLS} onClick={startCreate}>
                <FolderPlus className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                新建任务…
              </button>
            </>
          ) : (
            /* 新建表单：不弹模态框，就地展开 —— 只填一个名字，弹窗反而多一次打断 */
            <div className="p-1">
              <div className="flex items-center gap-1 px-1.5 pb-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setDraftName(null);
                    setFormError(null);
                  }}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="返回任务列表"
                >
                  <ArrowLeft className="h-3 w-3" />
                </button>
                <span className="text-[11px] font-medium">新建任务</span>
              </div>

              <input
                ref={inputRef}
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value);
                  setFormError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void submitCreate();
                  }
                }}
                placeholder="任务名，例如：统计看板导出"
                disabled={creating}
                className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-[11.5px] outline-none focus:border-primary/60"
              />

              <div className="mt-1.5 flex items-center gap-1 px-0.5 text-[10px] text-muted-foreground/80">
                <span className="shrink-0">位置</span>
                <span className="min-w-0 flex-1 truncate" title={parentDir || '默认：文档 / CnkeIDE'}>
                  {parentDir || '默认：文档 / CnkeIDE'}
                </span>
                <button
                  type="button"
                  onClick={() => void pickParent()}
                  disabled={creating}
                  className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title="选择其他位置"
                >
                  <FolderSearch className="h-3 w-3" />
                  更改
                </button>
              </div>

              <p className="mt-1.5 px-0.5 text-[10px] leading-relaxed text-muted-foreground/60">
                文件夹名取自任务名（非法字符换成 -）；同名已存在时自动加 -2、-3，不会覆盖已有目录。
              </p>

              {formError && (
                <p className="mt-1.5 px-0.5 text-[10px] leading-relaxed text-rose-500">{formError}</p>
              )}

              <div className="mt-2 flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setDraftName(null);
                    setFormError(null);
                  }}
                  disabled={creating}
                  className="rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void submitCreate()}
                  disabled={creating || !(draftName || '').trim()}
                  className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                >
                  {creating && <Loader2 className="h-3 w-3 animate-spin" />}
                  创建
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TaskSwitcher;
