import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useApp } from '../store/AppProvider';
import { useUiStore } from '../store/uiStore';
import TitleBar from './TitleBar';
import FileTree from './filetree/FileTree';
import ChatPanel from './chat/ChatPanel';
import EditorPanel from './editor/EditorPanel';
import TerminalPanel from './editor/TerminalPanel';
import SettingsSheet from './SettingsSheet';
import AnnouncementCenter from './backend/AnnouncementCenter';
import { Code2, TerminalSquare, X } from 'lucide-react';

const MainLayout: React.FC = () => {
  const { settingsOpen } = useApp();
  const [editorVisible, setEditorVisible] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(true);

  // 应用启动时自动同步官方内置模型到「我的 API 配置」；用户自定义添加的配置不受影响
  useEffect(() => {
    useUiStore.getState().refreshModels();
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* 最左：AI 对话 */}
          <Panel defaultSize={60} minSize={30}>
            <ChatPanel />
          </Panel>
          <PanelResizeHandle className="w-1 bg-border/60 hover:bg-primary/60 active:bg-primary transition-colors" />

          {/* 中间：编辑器（上）+ 终端（下） */}
          <Panel defaultSize={30} minSize={15}>
            <div className="flex flex-col h-full">
              {/* 面板切换标签 */}
              <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-secondary/20 shrink-0">
                {editorVisible && (
                  <button
                    onClick={() => setEditorVisible(true)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                      'bg-primary/15 text-foreground border border-primary/30'
                    }`}
                  >
                    <Code2 className="w-3.5 h-3.5" />
                    编辑器
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditorVisible(false);
                      }}
                      className="ml-0.5 p-0.5 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground"
                      title="隐藏编辑器"
                    >
                      <X className="w-3 h-3" />
                    </span>
                  </button>
                )}
                {!editorVisible && (
                  <button
                    onClick={() => setEditorVisible(true)}
                    className="p-1.5 rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
                    title="显示编辑器"
                  >
                    <Code2 className="w-3.5 h-3.5" />
                  </button>
                )}

                <span className="w-px h-4 bg-border mx-1" />

                {terminalVisible && (
                  <button
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                      'bg-primary/15 text-foreground border border-primary/30'
                    }`}
                  >
                    <TerminalSquare className="w-3.5 h-3.5" />
                    终端
                    <span
                      onClick={() => setTerminalVisible(false)}
                      className="ml-0.5 p-0.5 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground"
                      title="隐藏终端"
                    >
                      <X className="w-3 h-3" />
                    </span>
                  </button>
                )}
                {!terminalVisible && (
                  <button
                    onClick={() => setTerminalVisible(true)}
                    className="p-1.5 rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
                    title="显示终端"
                  >
                    <TerminalSquare className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* 编辑器在上，终端在下 */}
              <div className="flex-1 overflow-hidden">
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
                ) : terminalVisible ? (
                  <TerminalPanel />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
                    <Code2 className="w-10 h-10 opacity-30" />
                    <p className="text-sm">请通过上方标签栏显示编辑器或终端</p>
                  </div>
                )}
              </div>
            </div>
          </Panel>
          <PanelResizeHandle className="w-1 bg-border/60 hover:bg-primary/60 active:bg-primary transition-colors" />

          {/* 最右：资源管理器（文件树） */}
          <Panel defaultSize={10} minSize={6}>
            <FileTree />
          </Panel>
        </PanelGroup>
      </div>
      {settingsOpen && <SettingsSheet />}
      <AnnouncementCenter />
    </div>
  );
};

export default MainLayout;
