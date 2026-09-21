import { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useApp } from '../store/AppProvider';
import { useUiStore } from '../store/uiStore';
import { useLayoutStore } from '../store/layoutStore';
import TitleBar from './TitleBar';
import FileTree from './filetree/FileTree';
import ChatPanel from './chat/ChatPanel';
import EditorPanel from './editor/EditorPanel';
import TerminalPanel from './editor/TerminalPanel';
import SettingsSheet from './SettingsSheet';
import AnnouncementCenter from './backend/AnnouncementCenter';
import { Code2, TerminalSquare, FolderTree, X } from 'lucide-react';

const MainLayout: React.FC = () => {
  const { settingsOpen } = useApp();
  // 面板可见性统一放 store：各面板自己的头部 × 按钮与这里共享同一份状态
  const { chatVisible, editorVisible, terminalVisible, explorerVisible, setPanelVisible } = useLayoutStore();

  // 应用启动时自动同步官方内置模型到「我的 API 配置」；用户自定义添加的配置不受影响
  useEffect(() => {
    useUiStore.getState().refreshModels();
  }, []);

  const showPanel = (p: 'chat' | 'editor' | 'terminal' | 'explorer') => setPanelVisible(p, true);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* 最左：AI 对话 */}
          {chatVisible ? (
            <>
              <Panel defaultSize={60} minSize={30}>
                <div className="flex flex-col h-full">
                  {/* 头部：标题 + 隐藏按钮（与其他面板一致） */}
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-secondary/20 shrink-0">
                    <span className="text-[11px] text-foreground/80 font-medium">对话</span>
                    <button
                      onClick={() => setPanelVisible('chat', false)}
                      className="p-1 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-colors"
                      title="隐藏对话"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <ChatPanel />
                  </div>
                </div>
              </Panel>
              <PanelResizeHandle className="w-1 bg-border/60 hover:bg-primary/60 active:bg-primary transition-colors" />
            </>
          ) : (
            <CollapsedBar
              icon={<ChatIcon />}
              title="显示对话"
              onClick={() => showPanel('chat')}
            />
          )}

          {/* 中间：编辑器（上）+ 终端（下），各自独立头部栏 + × */}
          {editorVisible || terminalVisible ? (
            <Panel defaultSize={30} minSize={15}>
              <div className="flex flex-col h-full">
                {editorVisible && terminalVisible ? (
                  <PanelGroup direction="vertical">
                    <Panel defaultSize={65} minSize={20}>
                      <EditorPanel />
                    </Panel>
                    <PanelResizeHandle className="h-1 bg-border/60 hover:bg-primary/60 active:bg-primary transition-colors" />
                    <Panel defaultSize={35} minSize={15}>
                      <TerminalPanel />
                    </Panel>
                  </PanelGroup>
                ) : editorVisible ? (
                  <EditorPanel />
                ) : (
                  <TerminalPanel />
                )}
              </div>
            </Panel>
          ) : (
            <>
              <CollapsedBar
                icon={<Code2 className="w-3.5 h-3.5" />}
                title="显示编辑器"
                onClick={() => showPanel('editor')}
              />
              <CollapsedBar
                icon={<TerminalSquare className="w-3.5 h-3.5" />}
                title="显示终端"
                onClick={() => showPanel('terminal')}
              />
            </>
          )}

          {/* 资源管理器栏：隐藏时只留切换按钮 */}
          {explorerVisible ? (
            <>
              <PanelResizeHandle className="w-1 bg-border/60 hover:bg-primary/60 active:bg-primary transition-colors" />
              <Panel defaultSize={10} minSize={6}>
                <div className="flex flex-col h-full">
                  {/* 顶部标签栏：标题 + 关闭按钮 */}
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-secondary/20 shrink-0">
                    <div className="flex items-center gap-1.5 text-[11px] text-foreground/80 font-medium">
                      <FolderTree className="w-3.5 h-3.5 text-amber-400" />
                      资源管理器
                    </div>
                    <button
                      onClick={() => setPanelVisible('explorer', false)}
                      className="p-1 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-colors"
                      title="隐藏资源管理器"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <FileTree />
                  </div>
                </div>
              </Panel>
            </>
          ) : (
            <CollapsedBar
              icon={<FolderTree className="w-3.5 h-3.5" />}
              title="显示资源管理器"
              onClick={() => showPanel('explorer')}
            />
          )}
        </PanelGroup>
      </div>
      {settingsOpen && <SettingsSheet />}
      <AnnouncementCenter />
    </div>
  );
};

/** 折叠后的窄边栏：整条可点击，点击即恢复对应面板 */
const CollapsedBar: React.FC<{ icon: React.ReactNode; title: string; onClick: () => void }> = ({ icon, title, onClick }) => (
  <div className="w-9 shrink-0 border-l border-border bg-secondary/20 flex flex-col items-center py-2">
    <button
      onClick={onClick}
      className="p-1.5 rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
      title={title}
    >
      {icon}
    </button>
  </div>
);

/** 对话图标：单独抽出避免额外 import 冲突 */
const ChatIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

export default MainLayout;
