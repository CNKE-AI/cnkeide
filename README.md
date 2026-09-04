# CnkeIDE

**独立 Electron 桌面 AI 编程 IDE** — 对标 Cursor、豆包 IDE、CodeBuddy 的全自研 AI IDE。

## 功能特性

- **完整代码编辑器**：Monaco Editor（VS Code 同款内核），多标签页、自动保存（Ctrl+S）
- **文件资源管理器**：树形目录浏览、目录懒加载展开、点击打开
- **内置终端**：真实 PTY 进程、输入输出回显、PID 管理、清空/终止
- **AI Agent 内核**（完全自研，零 VSCode 依赖）：
  - 四种工作模式：架构师 / 开发者 / 调试器 / 问答
  - 流式响应 + 思考过程展示 + 工具调用可视化
  - 文件读写、目录浏览、内容搜索、命令执行、Diff 智能编辑全套工具链
  - 工具调用审批弹窗（可自动批准）
  - 每轮对话前自动创建代码快照，支持回滚（CheckpointManager）
- **MCP 客户端**：stdio + HTTP 双协议，多服务器管理
- **多模型上游**：支持 OpenAI / DeepSeek / 通义 / 智谱 / Claude / Ollama / 自定义中转，可视化配置
- **会话持久化**：JSON 本地文件 + Electron userData，自动保存
- **现代 UI**：React 18 + TailwindCSS + shadcn 风格 + 三栏可拖拽布局

## 技术架构

```
┌────────────────────────────────────────────────┐
│                  渲染进程 (Renderer)            │
│   React 18 + Vite + TailwindCSS + Monaco       │
│   Zustand stores (chat/editor/file/terminal)   │
└──────────────┬─────────────────────────────────┘
               │ IPC (contextIsolation + preload)
┌──────────────▼─────────────────────────────────┐
│              主进程 (Main)                      │
│   ┌────────────────────────────────────────┐   │
│   │ core-fork  (自研 AI 内核)               │   │
│   │  AgentManager · LLMProvider · McpHub   │   │
│   │  ToolManager · CheckpointManager       │   │
│   └────────────────────────────────────────┘   │
│   adapter (平台适配层)                          │
│   Config/FileSystem/Terminal/Window/Storage    │
│   ipc/handlers.ts · store/SessionStore.ts      │
└────────────────────────────────────────────────┘
```

**架构原则**：
1. 完全剥离 VSCode 依赖（无任何 vscode 模块/API/类型）
2. 内核与 UI 完全分离 — 所有 Agent/MCP/LLM/工具系统运行在主进程
3. 渲染进程只负责 UI 交互，通过 preload 暴露的 `window.cnke` API 通信

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（热更新）
npm run dev

# 类型检查 + 构建
npm run build

# 打包安装包
npm run pack:win    # Windows (NSIS + portable)
npm run pack:mac    # macOS (dmg + zip)
npm run pack:linux  # Linux (AppImage + deb)
```

## 目录结构

```
cnke-claw/
├── electron/
│   ├── main.ts                 # 主进程入口
│   ├── preload.ts              # 渲染进程 API 桥（window.cnke）
│   ├── menu.ts                 # 应用菜单
│   ├── ipc/handlers.ts         # 全部 IPC 通道注册
│   ├── adapter/                # 平台适配层（替代 VSCode API）
│   │   ├── ConfigAdapter.ts    # 配置持久化
│   │   ├── FileSystemAdapter.ts
│   │   ├── TerminalAdapter.ts  # PTY 终端
│   │   ├── WindowAdapter.ts    # 对话框/窗口
│   │   └── StorageAdapter.ts   # JSON 存储
│   ├── store/SessionStore.ts   # 会话持久化
│   └── core-fork/              # ★ 自研 AI 内核（Roo-Code 架构移植）
│       ├── agent/AgentManager.ts    # Agent 循环调度
│       ├── llm/LLMProvider.ts       # 多模型 LLM 客户端
│       ├── mcp/McpHub.ts            # MCP 协议客户端
│       ├── tools/ToolManager.ts     # 全套工具链
│       └── checkpoint/CheckpointManager.ts  # 代码快照回滚
├── renderer/
│   └── src/
│       ├── App.tsx / main.tsx
│       ├── global.d.ts          # window.cnke 类型声明
│       ├── store/               # Zustand stores
│       └── components/          # TitleBar/FileTree/Editor/Chat/Terminal/Settings
├── vite.config.ts
├── electron-builder.config.ts   # 打包配置
└── package.json
```

## 使用指南

1. 启动后点击左上角「打开文件夹」选择工作区
2. 右侧 AI 面板选择工作模式，输入需求（支持 Ctrl+V 粘贴截图）
3. AI 自动读写文件、执行命令，工具调用时弹窗确认
4. 模型配置：右上角设置 → 模型配置 → 添加 API（Base URL + Key + Model）
5. MCP：设置 → MCP 服务器 → 添加 stdio/http 服务

## 会话与数据

- 配置/会话/快照均存储于 Electron `userData` 目录
- 对话自动保存，重启后可恢复
- Agent 每次修改文件前自动快照，可回滚
