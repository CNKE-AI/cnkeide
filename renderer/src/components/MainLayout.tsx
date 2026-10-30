import React, { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useApp } from '../store/AppProvider';
import { useUiStore } from '../store/uiStore';
import { useLayoutStore, type PanelKey } from '../store/layoutStore';
import TitleBar from './TitleBar';
import FileTree from './filetree/FileTree';
import ChatPanel from './chat/ChatPanel';
import EditorPanel from './editor/EditorPanel';
import TerminalPanel from './editor/TerminalPanel';
import PreviewPanel from './preview/PreviewPanel';
import SettingsSheet from './SettingsSheet';
import StatsPage from './stats/StatsPage';
import AnnouncementCenter from './backend/AnnouncementCenter';
import GlobalSearch, { OPEN_GLOBAL_SEARCH_EVENT } from './search/GlobalSearch';
import { Code2, TerminalSquare, FolderTree, X, MessageCircle, Monitor, Search } from 'lucide-react';

/**
 * 面板拖拽分隔条统一样式。
 * 视觉上完全隐形（透明背景），只靠 index.css 里的 ::after 光带在 hover/拖拽时浮现，
 * 命中区仍然保留 8px，符合 iOS "无边框、靠浮起分层"的表达方式。
 */
const RESIZE_HANDLE_H = 'h-2 bg-transparent';
const RESIZE_HANDLE_W = 'w-2 bg-transparent';

/** 折叠窄条的单条宽度（与合并后的容器宽度保持一致，避免视觉错位） */
const COLLAPSED_BAR_W = 32;

/** 折叠面板项：图标 + 名称 + 恢复动作 */
interface CollapsedItem {
  key: PanelKey;
  icon: React.ReactNode;
  label: string;
  title: string;
}

/**
 * 主布局（VSCode 式）：对话 | [ 编辑区(编辑器 + 终端) | 资源管理器 ]
 *
 * 水平方向分三块，最右侧再纵向二分：
 *   - 最左  对话
 *   - 中间  编辑区，纵向 = 编辑器(上) + 终端(下)
 *   - 最右  资源管理器，与编辑区顶部对齐
 *
 * 三块的可见性存在 layoutStore 中（含 localStorage 持久化），
 * 各面板头部的 × 按钮与这里读写同一份状态。
 *
 * 折叠规则（重要）：所有被隐藏的面板共用**一个**折叠窄条，而不是每个面板各出一条。
 * 例如对话 / 编辑区 / 资源管理器全部隐藏时，右侧只出现一条统一的窄条，
 * 条内按顺序排列各面板的恢复按钮（对话 / 编辑器 / 终端 / 资源管理器），
 * 避免出现多条并排的窄条把主区域挤得又碎又窄。
 */
const MainLayout: React.FC = () => {
  const { settingsOpen, activePage, setActivePage } = useApp();
  const { chatVisible, editorVisible, previewVisible, terminalVisible, explorerVisible, setPanelVisible } = useLayoutStore();

  // 应用启动时自动同步官方内置模型到「我的 API 配置」；用户自定义添加的配置不受影响
  useEffect(() => {
    useUiStore.getState().refreshModels();
  }, []);

  const showPanel = (p: PanelKey) => setPanelVisible(p, true);

  /**
   * 中间列可纵向堆叠三个面板：编辑器 / 预览 / 终端。
   * 只显示一个时直接占满；多个时用默认比例分栏（编辑器权重最高）。
   */
  const centerPanes: { key: PanelKey; node: React.ReactNode; size: number }[] = [];
  if (editorVisible) centerPanes.push({ key: 'editor', node: <EditorPanel />, size: 50 });
  if (previewVisible) centerPanes.push({ key: 'preview', node: <PreviewPanel />, size: 30 });
  if (terminalVisible) centerPanes.push({ key: 'terminal', node: <TerminalPanel />, size: 20 });

  const editorArea = centerPanes.length === 1 ? (
    centerPanes[0].node
  ) : (
    <PanelGroup direction="vertical">
      {centerPanes.map((pane, i) => (
        <React.Fragment key={pane.key}>
          {i > 0 && <PanelResizeHandle className={RESIZE_HANDLE_H} />}
          <Panel defaultSize={pane.size} minSize={12}>
            {pane.node}
          </Panel>
        </React.Fragment>
      ))}
    </PanelGroup>
  );

  /**
   * 收集所有被隐藏的面板，交给统一的 CollapsedBar 渲染。
   * 顺序固定为「对话 → 编辑器 → 终端 → 资源管理器」，与实际面板位置一致，
   * 用户恢复时不会因为顺序跳变而迷失。
   */
  const collapsedItems: CollapsedItem[] = [];
  if (!chatVisible) {
    collapsedItems.push({
      key: 'chat',
      icon: <MessageCircle className="w-3.5 h-3.5" />,
      label: '对话',
      title: '显示对话',
    });
  }
  if (!editorVisible) {
    collapsedItems.push({
      key: 'editor',
      icon: <Code2 className="w-3.5 h-3.5" />,
      label: '编辑器',
      title: '显示编辑器',
    });
  }
  if (!previewVisible) {
    collapsedItems.push({
      key: 'preview',
      icon: <Monitor className="w-3.5 h-3.5" />,
      label: '预览',
      title: '显示预览（点选页面元素即可改源码）',
    });
  }
  if (!terminalVisible) {
    collapsedItems.push({
      key: 'terminal',
      icon: <TerminalSquare className="w-3.5 h-3.5" />,
      label: '终端',
      title: '显示终端',
    });
  }
  if (!explorerVisible) {
    collapsedItems.push({
      key: 'explorer',
      icon: <FolderTree className="w-3.5 h-3.5" />,
      label: '资源管理器',
      title: '显示资源管理器',
    });
  }

  /** 任一可见面板存在时，折叠条才作为「侧栏」贴在最后一个可见面板右侧 */
  const hasVisiblePanel = chatVisible || editorVisible || previewVisible || terminalVisible || explorerVisible;

  return (
    <div className="app-shell relative flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* 环境光：让上层毛玻璃面板透出颜色，是半透明质感成立的前提 */}
      <div className="app-ambient" aria-hidden="true">
        <div className="app-ambient__glow" />
      </div>
      <TitleBar />
      {/* relative：统计看板作为内容区的浮层挂在这里，天然避开标题栏的拖拽区 */}
      <div className="relative flex-1 overflow-hidden">
        <PanelGroup direction="horizontal" className="h-full p-1.5 gap-0">
          {/* 最左：AI 对话 */}
          {chatVisible && (
            <>
              <Panel defaultSize={50} minSize={25}>
                <div className="panel-card flex flex-col h-full">
                  {/* 头部：标题 + 隐藏按钮（与其他面板一致） */}
                  <div className="panel-header shrink-0">
                    <span className="panel-header__title">
                      <MessageCircle className="w-3.5 h-3.5 text-primary" />
                      对话
                    </span>
                    <button
                      onClick={() => setPanelVisible('chat', false)}
                      title="隐藏对话"
                      aria-label="隐藏对话"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <ChatPanel />
                  </div>
                </div>
              </Panel>
              <PanelResizeHandle className={RESIZE_HANDLE_W} />
            </>
          )}

          {/* 中间：编辑区（编辑器 + 预览 + 终端） */}
          {(editorVisible || previewVisible || terminalVisible) && (
            <Panel defaultSize={40} minSize={20}>
              <div className="panel-card flex flex-col h-full">{editorArea}</div>
            </Panel>
          )}

          {/* 最右：资源管理器，与编辑区顶部对齐 */}
          {explorerVisible && (
            <>
              <PanelResizeHandle className={RESIZE_HANDLE_W} />
              <Panel defaultSize={16} minSize={8}>
                <div className="panel-card flex flex-col h-full">
                  {/* 顶部标签栏：标题 + 关闭按钮 */}
                  <div className="panel-header shrink-0">
                    <div className="panel-header__title">
                      <FolderTree className="w-3.5 h-3.5 text-amber-400" />
                      资源管理器
                    </div>
                    <div className="flex items-center gap-0.5">
                      {/* 全文搜索入口：快捷键之外给个可点的入口，否则新用户发现不了 */}
                      <button
                        onClick={() => window.dispatchEvent(new Event(OPEN_GLOBAL_SEARCH_EVENT))}
                        title="在工作区中搜索内容 (Ctrl+Shift+F)"
                        aria-label="全文搜索"
                      >
                        <Search className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setPanelVisible('explorer', false)}
                        title="隐藏资源管理器"
                        aria-label="隐藏资源管理器"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <FileTree />
                  </div>
                </div>
              </Panel>
            </>
          )}

          {/*
            统一的折叠窄条：所有隐藏面板合并为一条。
            注意必须放在 PanelGroup 之外（作为 Panel 的兄弟节点），
            否则 react-resizable-panels 会要求每个直接子节点都是 Panel/PanelResizeHandle，
            导致渲染报错或布局计算异常。
          */}
          {collapsedItems.length > 0 && (
            <CollapsedBar
              items={collapsedItems}
              onClick={showPanel}
              bordered={hasVisiblePanel}
            />
          )}
        </PanelGroup>
        {/* 历史统计看板：整页浮层，覆盖主布局但保留标题栏入口 */}
        {activePage === 'stats' && <StatsPage onClose={() => setActivePage('ide')} />}
      </div>
      {settingsOpen && <SettingsSheet />}
      {/* 全文搜索：自带快捷键与开关状态，常驻挂载、关闭时不渲染任何 DOM */}
      <GlobalSearch />
      <AnnouncementCenter />
    </div>
  );
};

/**
 * 折叠后的统一窄边栏：一条窄条承载所有隐藏面板的恢复入口。
 *
 * - 单一宽度（COLLAPSED_BAR_W），无论隐藏几个面板都只占一条，
 *   不会出现 3 条窄条并排挤压主区域的情况；
 * - 每个按钮 hover 右侧浮出面板名称提示，避免纯图标无法辨识；
 * - 按钮纵向排列，面板数量多时自动滚动。
 */
const CollapsedBar: React.FC<{
  items: CollapsedItem[];
  onClick: (panel: PanelKey) => void;
  /** 左侧是否需要边框（左侧有可见面板时显示分隔线，全隐藏时不显示） */
  bordered: boolean;
}> = ({ items, onClick, bordered }) => (
  <div
    className={`shrink-0 flex flex-col items-center gap-1.5 py-2 overflow-y-auto glass-panel-flat ${
      bordered ? 'ml-1.5' : ''
    }`}
    style={{ width: COLLAPSED_BAR_W, borderRadius: 14 }}
    role="toolbar"
    aria-label="已隐藏的面板"
  >
    {items.map((item) => (
      <button
        key={item.key}
        onClick={() => onClick(item.key)}
        className="group relative flex items-center justify-center w-6 h-6 rounded-[9px] text-muted-foreground ios-press hover:bg-white/10 hover:text-foreground shrink-0"
        title={item.title}
        aria-label={item.title}
      >
        {item.icon}
        {/* 悬浮标签：折叠条很窄，用绝对定位浮层展示完整名称 */}
        <span className="pointer-events-none absolute left-full ml-2.5 z-50 hidden group-hover:block whitespace-nowrap rounded-lg border border-hairline bg-popover/95 px-2.5 py-1 text-[11px] text-popover-foreground shadow-float backdrop-blur-glass">
          {item.label}
        </span>
      </button>
    ))}
  </div>
);

export default MainLayout;
