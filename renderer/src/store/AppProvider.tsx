import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useUiStore } from './uiStore';
import { useFileStore, bindWorkspaceWatcher, unbindWorkspaceWatcher } from './fileStore';
import { useEditorStore } from './editorStore';
import { useAgentActivityStore } from './agentActivityStore';
import { attachAgentActivityBridge } from './agentActivityBridge';

interface AppContextValue {
  workspacePath: string | null;
  setWorkspacePath: (path: string | null) => void;
  activePage: string;
  setActivePage: (page: string) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [workspacePath, setWorkspacePathState] = useState<string | null>(null);
  const [activePage, setActivePage] = useState('ide');
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    window.cnke.config.get('workspace.lastWorkspace').then((ws: string | null) => {
      if (ws) setWorkspacePathState(ws);
    });
  }, []);

  /**
   * 工作区 ↔ 资源管理器强关联：
   * 工作区路径一旦就绪，立即同步到 fileStore 并启动文件监听，
   * 使资源管理器/编辑器/终端三视图共享同一份文件树状态（单一数据源）。
   */
  useEffect(() => {
    if (!workspacePath) return;
    void useFileStore.getState().loadTree(workspacePath);
    const dispose = bindWorkspaceWatcher(workspacePath);
    return () => {
      dispose();
    };
  }, [workspacePath]);

  // 应用退出时释放监听（避免主进程 watcher 泄漏）
  useEffect(() => {
    return () => unbindWorkspaceWatcher();
  }, []);

  // 全局 agent 事件监听：把 context_state / plan 等 UI 事件转发给 uiStore
  useEffect(() => {
    const handleAgentEvent = useUiStore.getState().handleAgentEvent;
    const off = window.cnke.agent.onEvent((event: any) => {
      handleAgentEvent(event);
    });
    return off;
  }, []);

  /**
   * Agent 活动桥接：把 agent 事件转换为终端/编辑器/资源管理器可直接消费的状态。
   * 与上面的 uiStore 监听并存（两个消费者共用同一次 IPC 广播）。
   */
  useEffect(() => {
    const off = attachAgentActivityBridge();
    return off;
  }, []);

  const setWorkspacePath = useCallback((path: string | null) => {
    setWorkspacePathState(path);
    if (!path) return;

    window.cnke.config.set('workspace.lastWorkspace', path);

    // 1) 关闭不属于新工作区的编辑器标签，避免旧工作区文件残留
    useEditorStore.getState().closeTabsOutsideRoot(path);
    // 2) 清理上一个工作区遗留的 Agent 活动/触碰记录，防止误导为当前项目
    const activity = useAgentActivityStore.getState();
    activity.clear();
    activity.resetWorkspaceState();

    // 3) 资源管理器立即切到新工作区（文件树加载由下方 effect 统一驱动，避免重复请求竞态）
    useFileStore.setState({ selectedPath: null, lastChangedPaths: [], rootPath: null });
  }, []);

  return (
    <AppContext.Provider value={{ workspacePath, setWorkspacePath, activePage, setActivePage, settingsOpen, setSettingsOpen }}>
      {children}
    </AppContext.Provider>
  );
};

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
