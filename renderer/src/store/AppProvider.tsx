import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useUiStore } from './uiStore';

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

  // 全局 agent 事件监听：把 context_state / plan 等 UI 事件转发给 uiStore
  useEffect(() => {
    const handleAgentEvent = useUiStore.getState().handleAgentEvent;
    const off = window.cnke.agent.onEvent((event: any) => {
      handleAgentEvent(event);
    });
    return off;
  }, []);

  const setWorkspacePath = useCallback((path: string | null) => {
    setWorkspacePathState(path);
    if (path) window.cnke.config.set('workspace.lastWorkspace', path);
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
