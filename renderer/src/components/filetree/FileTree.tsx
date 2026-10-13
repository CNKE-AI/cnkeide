import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useFileStore, FileNode, onDirRefresh } from '../../store/fileStore';
import { useEditorStore } from '../../store/editorStore';
import { useApp } from '../../store/AppProvider';
import {
  ChevronRight, ChevronDown, File, Folder, FolderOpen, RefreshCw,
  FolderPlus, FilePlus, Trash2, Edit3, FolderOpen as OpenFolderIcon, Scissors, Loader2,
} from 'lucide-react';

/* ---------- 文件图标（按扩展名着色） ---------- */
const FileIcon: React.FC<{ name: string }> = ({ name }) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const colorMap: Record<string, string> = {
    ts: 'text-blue-400', tsx: 'text-blue-400', mts: 'text-blue-400',
    js: 'text-yellow-400', jsx: 'text-yellow-400', mjs: 'text-yellow-400',
    json: 'text-amber-400', html: 'text-orange-400', css: 'text-sky-400',
    scss: 'text-pink-400', py: 'text-emerald-400', go: 'text-cyan-400',
    rs: 'text-orange-500', md: 'text-gray-400', yml: 'text-purple-400',
    yaml: 'text-purple-400', sh: 'text-green-400', sql: 'text-fuchsia-400',
  };
  return <File className={`w-4 h-4 shrink-0 ${colorMap[ext] || 'text-gray-500'}`} />;
};

/* ---------- 树节点 ---------- */
const TreeNode: React.FC<{ node: FileNode; level: number; changed: Set<string> }> = ({ node, level, changed }) => {
  const { toggleExpand, selectedPath, setSelectedPath } = useFileStore();
  const openFile = useEditorStore((s) => s.openFile);
  const isSelected = selectedPath === node.path;
  // 最近被外部（Agent / 终端 / 其他视图）修改过的路径做高亮提示
  const isChanged = !node.isDirectory && changed.has(node.path);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedPath(node.path);
    if (node.isDirectory) {
      toggleExpand(node.path);
    } else {
      // 文件：在编辑器中打开
      void openFile(node.path, node.name);
    }
  };

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 mx-1 px-2 py-[3px] rounded-md cursor-pointer text-[13px] transition-colors ${
          isSelected
            ? 'bg-violet-500/15 text-foreground'
            : isChanged
              ? 'bg-amber-500/12 text-amber-200/90 hover:bg-amber-500/20'
              : 'hover:bg-accent text-muted-foreground'
        }`}
        style={{ paddingLeft: `${level * 14 + 8}px` }}
        onClick={onClick}
        title={node.path}
      >
        {node.isDirectory ? (
          <>
            {node.expanded
              ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-500" />
              : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-500" />}
            {node.expanded
              ? <FolderOpen className="w-4 h-4 text-cyan-400 shrink-0" />
              : <Folder className="w-4 h-4 text-cyan-400/70 shrink-0" />}
          </>
        ) : (
          <>
            <span className="w-3.5 shrink-0" />
            <FileIcon name={node.name} />
          </>
        )}
        <span className={`truncate ${isSelected ? 'font-medium' : ''}`}>{node.name}</span>
      </div>
      {node.isDirectory && node.expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} level={level + 1} changed={changed} />
          ))}
        </div>
      )}
    </div>
  );
};

/* ---------- 右键菜单 ---------- */
interface MenuState { x: number; y: number; target: FileNode }

const FileTree: React.FC = () => {
  const { tree, loadTree, loading, selectedPath, setSelectedPath, refreshDir, lastChangeAt, lastChangedPaths } = useFileStore();
  const { workspacePath, setWorkspacePath } = useApp();
  const treeRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // 外部变更高亮集合（3 秒后自动淡出）
  const [changed, setChanged] = useState<Set<string>>(new Set());

  // 文件树加载由 AppProvider 统一驱动（工作区单一数据源），此处不再重复请求。
  // 仅在切换工作区时清空本地的高亮/选中残留，避免旧工作区的状态串到新工作区。
  useEffect(() => {
    setChanged(new Set());
    setMenu(null);
  }, [workspacePath]);

  // 订阅目录刷新总线：编辑器 / 终端 / Agent 触发的变更都能让资源管理器同步
  useEffect(() => {
    const off = onDirRefresh(() => {
      // 变更后树已由 fileStore 就地更新，这里只需保持选中项可见
    });
    return off;
  }, []);

  // 变更高亮：把相对路径转为绝对路径集合
  useEffect(() => {
    if (!workspacePath || lastChangedPaths.length === 0) return;
    const base = workspacePath.replace(/\\/g, '/');
    const abs = new Set(
      lastChangedPaths.map((rel) => `${base}/${rel}`.replace(/\//g, window.cnke.path.sep))
    );
    setChanged(abs);
    const timer = setTimeout(() => setChanged(new Set()), 3000);
    return () => clearTimeout(timer);
  }, [workspacePath, lastChangeAt, lastChangedPaths]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const parentDirOf = (node: FileNode) =>
    node.isDirectory ? node.path : window.cnke.path.dirname(node.path);

  const doCreateFile = async (node: FileNode) => {
    if (!workspacePath) return;
    const parent = parentDirOf(node);
    const name = window.prompt('请输入文件名', '新建文件.txt');
    if (!name) return;
    const target = window.cnke.path.join(parent, name);
    const result = await window.cnke.fs.createFile(target, '');
    if (result.success) {
      await refreshDir(parent);
    } else {
      alert(result.error);
    }
  };

  const doCreateDir = async (node: FileNode) => {
    if (!workspacePath) return;
    const parent = parentDirOf(node);
    const name = window.prompt('请输入文件夹名', '新建文件夹');
    if (!name) return;
    const target = window.cnke.path.join(parent, name);
    const result = await window.cnke.fs.createDir(target);
    if (result.success) await refreshDir(parent);
    else alert(result.error);
  };

  const doRename = async (node: FileNode) => {
    if (!workspacePath) return;
    const name = window.prompt('重命名', node.name);
    if (!name || name === node.name) return;
    const parent = window.cnke.path.dirname(node.path);
    const newPath = window.cnke.path.join(parent, name);
    const result = await window.cnke.fs.renamePath(node.path, newPath);
    if (result.success) {
      if (selectedPath === node.path) setSelectedPath(newPath);
      await refreshDir(parent);
    } else {
      alert(result.error);
    }
  };

  const doDelete = async (node: FileNode) => {
    if (!workspacePath) return;
    if (!window.confirm(`确定要删除 "${node.name}" 吗？\n此操作不可恢复。`)) return;
    const result = await window.cnke.fs.deletePath(node.path);
    if (result.success) {
      if (selectedPath === node.path) setSelectedPath(null);
      await refreshDir(parentDirOf(node));
    } else {
      alert(result.error);
    }
  };

  const doCopyPath = (node: FileNode) => {
    navigator.clipboard.writeText(node.path);
    setMenu(null);
  };

  const doShowInFolder = async (node: FileNode) => {
    await window.cnke.shell.openPath(node.path);
    setMenu(null);
  };

  const onContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPath(node.path);
    const rect = treeRef.current?.getBoundingClientRect();
    setMenu({
      x: Math.min(e.clientX, (rect?.right ?? e.clientX + 180) - 190),
      y: Math.min(e.clientY, (rect?.bottom ?? e.clientY + 240) - 260),
      target: node,
    });
  };

  /* ---------- 未打开工作区 ---------- */
  if (!workspacePath) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-500 p-6">
        <Folder className="w-10 h-10 opacity-40" />
        <p className="text-sm text-center">尚未打开工作区</p>
        <button
          onClick={async () => {
            const p = await window.cnke.fs.openFolder();
            if (p) setWorkspacePath(p);
          }}
          className="text-xs border border-border rounded-md px-3 py-1.5 hover:bg-accent transition-colors"
        >
          打开文件夹
        </button>
      </div>
    );
  }

  const MenuItem: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }> =
    ({ icon, label, onClick, danger }) => (
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-2.5 px-3 py-1.5 transition-colors text-left ${
          danger ? 'hover:bg-red-500/15 text-red-400' : 'hover:bg-accent text-foreground'
        }`}
      >
        {icon}
        {label}
      </button>
    );

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider truncate">
          {workspacePath ? workspacePath.split(window.cnke.path.sep).filter(Boolean).pop() : '资源管理器'}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* 自动同步状态指示：有外部变更时短暂亮起 */}
          {changed.size > 0 && (
            <span
              className="text-[10px] text-amber-400/90 px-1 rounded"
              title={`已自动同步 ${changed.size} 个文件变更`}
            >
              同步中
            </span>
          )}
          <button
            onClick={() => loadTree(workspacePath)}
            className="p-1 hover:bg-accent rounded-md transition-colors"
            title="刷新"
          >
            {loading
              ? <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />}
          </button>
        </div>
      </div>

      {/* 树 */}
      <div ref={treeRef} className="flex-1 overflow-auto py-1 relative">
        {loading && tree.length === 0 ? (
          <div className="p-4 text-xs text-gray-500">加载中...</div>
        ) : tree.length === 0 ? (
          <div className="p-4 text-xs text-gray-600">空文件夹</div>
        ) : (
          tree.map((node) => (
            <div key={node.path} onContextMenu={(e) => onContextMenu(e, node)}>
              <TreeNode node={node} level={0} changed={changed} />
            </div>
          ))
        )}

        {/* 右键菜单 */}
        {menu && (
          <div
            className="fixed z-50 bg-popover border border-border rounded-lg shadow-2xl py-1 min-w-[180px] text-xs"
            style={{ top: menu.y, left: menu.x }}
          >
            <div
              className="px-3 py-1.5 border-b border-border mb-1 truncate text-muted-foreground"
              title={menu.target.path}
            >
              {menu.target.name}
            </div>
            <MenuItem icon={<FilePlus className="w-3.5 h-3.5" />} label="新建文件" onClick={() => { doCreateFile(menu.target); setMenu(null); }} />
            <MenuItem icon={<FolderPlus className="w-3.5 h-3.5" />} label="新建文件夹" onClick={() => { doCreateDir(menu.target); setMenu(null); }} />
            <MenuItem icon={<Edit3 className="w-3.5 h-3.5" />} label="重命名" onClick={() => { doRename(menu.target); setMenu(null); }} />
            <MenuItem icon={<Scissors className="w-3.5 h-3.5" />} label="复制路径" onClick={() => doCopyPath(menu.target)} />
            <MenuItem icon={<OpenFolderIcon className="w-3.5 h-3.5" />} label="在文件夹中显示" onClick={() => doShowInFolder(menu.target)} />
            <div className="border-t border-border my-1" />
            <MenuItem icon={<Trash2 className="w-3.5 h-3.5" />} label="删除" danger onClick={() => { doDelete(menu.target); setMenu(null); }} />
          </div>
        )}
      </div>
    </div>
  );
};

export default FileTree;
