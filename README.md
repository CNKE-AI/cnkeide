# CnkeIDE

[![Version](https://img.shields.io/badge/version-1.3.3-22d3ee?style=flat-square)](https://ai.cnkes.cn/cnkeide/updates/latest.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-8b5cf6?style=flat-square)](#安装)
[![Electron](https://img.shields.io/badge/Electron-31-47848f?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](./LICENSE)

**独立 Electron 桌面 AI 编程 IDE** — 完全自研的 Agent 内核，零 VSCode 依赖。

官网：[https://ai.cnkes.cn](https://ai.cnkes.cn) · 使用文档：[https://ai.cnkes.cn/docs.html](https://ai.cnkes.cn/docs.html)

---

## 项目简介

CnkeIDE 是一款从零构建的桌面 AI 编程工具。它的 AI 内核（Agent 循环、LLM 客户端、工具链、规划器、检索引擎）全部自行实现，不依赖 VSCode 的任何模块或 API，因此可以独立演进、自由裁剪。

与「编辑器 + AI 插件」的形态不同，CnkeIDE 把 AI 当作一等公民：Agent 运行在主进程的独立子进程中，拥有文件读写、命令执行、代码检索、浏览器自动化、文档问答、演示文稿生成等 39 项内置工具，通过审批策略与检查点机制保证操作可控、可回滚。

### 核心设计原则

1. **完全剥离 VSCode 依赖** — 无任何 `vscode` 模块 / API / 类型引用。
2. **内核与 UI 分离** — Agent、LLM、工具、检索系统全部运行在主进程，渲染进程只负责交互。
3. **进程隔离** — Agent 运行在 `utilityProcess` 子进程中，崩溃或卡死不影响主界面。
4. **能力可编排** — 工具调用按 DAG 拓扑排序并发调度，而非简单串行。

---

## 功能特性

### 编辑器与工作区

- **代码编辑器** — 基于 CodeMirror 6，支持 JavaScript / TypeScript / Python / Go / Rust / Java / C++ / PHP / SQL / YAML / HTML / CSS / JSON / Markdown / XML 语法高亮，多标签页、自动保存
- **AI 行内补全** — 编辑器内光标处 AI 补全建议，基于当前文件与光标上下文构造提示，LRU 缓存命中、并发去重、可随时打断（Esc），可在设置中开关
- **文件资源管理器** — 树形目录、懒加载展开、右键引用（`@文件` / `@目录`）
- **内置终端** — 真实 PTY 进程、流式输出回显、PID 管理，与编辑器同面板切换
- **可拖拽布局** — 文件树 / 编辑器 / 对话 / 规划四区自由调整

### AI Agent 内核

- **三种交互模式**
  - `Ask`（问答）— 只读，禁用所有写工具与命令执行
  - `Craft`（快速）— 完整工具链，迭代上限受模式约束
  - `Plan`（深度）— 完整工具链 + 任务规划器，支持多步任务分解
- **流式响应** — 思考过程实时展示、工具调用可视化、Markdown 渲染
- **任务规划器** — 状态机严格约束 `pending → running → completed | failed | skipped`，终态不可回退；计划面板支持跳过 / 重试 / 中止，进度实时推送
- **并行工具调度** — DAG 拓扑排序，无依赖读并发、同路径写串行、命令与写全局串行
- **上下文追踪** — 实时估算 token 占用，分 `safe / warning / critical` 三档提示
- **自动压缩** — 保留最近 K 轮对话，早期内容摘要为单条 system 消息
- **子 Agent 委派** — `explore` 类型强制只读白名单，支持并发互斥与 AbortSignal 取消

### 39 项内置工具

| 分类 | 工具 |
|---|---|
| 文件操作 | `read_file` `write_to_file` `create_file` `apply_diff` `delete_file` `rename_file` `list_directory` |
| 代码检索 | `search_files` `search_symbol` `find_references` `get_file_outline` `grep` `semantic_search` `project_structure` |
| 命令与测试 | `execute_command` `run_tests` `format_code` |
| 版本控制 | `git_status` `git_diff` `git_log` `git_commit` |
| 任务规划 | `create_plan` `add_plan_item` `update_plan_status` `get_plan` `mark_plan_complete` |
| 文档问答 | `doc_ingest` `doc_query` `doc_list` `doc_remove` |
| 浏览器自动化 | `browser_navigate` `browser_screenshot` `browser_click` `browser_input` `browser_extract` `browser_close` |
| 网络与多模态 | `web_search` `web_fetch` `image_generate` |

> 工具按**真实可用性**投放给模型：未安装 Playwright 时浏览器工具、未配置 API Key 时 `image_generate` 不会出现在工具表中，避免模型调用必然失败的工具白白消耗轮次。

### 特色功能

- **AI 演示文稿生成** — 扫描工作区 README 与目录结构自动提炼大纲，内置商业 / 学术 / 中国风 / 插画 4 套主题 × 6 种版式（封面/目录/分节/内容/数据/结尾），支持 PPTX / PDF 导出
- **代码库语义检索** — 关键词 + 语义向量 + 符号三路召回加权融合，增量索引避免重复计算
- **智能模型路由** — 内置 DeepSeek / 通义千问 / GLM / Kimi / 文心 / Gemini 等能力矩阵（旗舰 / 标准 / 快速 / 推理四档），按任务特征自动选型，支持 `@模型名` 手动覆盖
- **文档问答 RAG** — 本地解析 PDF / DOCX / Markdown / HTML / CSV / XLSX 后切块建索引，问答附带来源引用
- **多模型上游** — 支持 AI Platform / DeepSeek / 通义 / 智谱 / Kimi / Claude / Ollama 及自定义中转，可视化配置
- **extension 支持** — stdio + HTTP 双协议，多服务器管理
- **多模态输入** — `Ctrl+V` 粘贴截图，图片随消息一并送入模型

### 可靠性与安全

- **LLM 容错** — 指数退避重试（带抖动）、单次与总超时双约束、主备模型 Fallback 链
- **检查点回滚** — 每轮对话前自动快照，支持增量快照与文件级 diff
- **审批策略** — 规则化工具审批（glob 路径匹配 + 命令匹配），支持 `allow` / `deny` / `ask`
- **熔断保护** — 连续工具调用失败自动终止，避免死循环
- **全局错误边界** — 渲染层任意组件异常只降级当前界面并提供「重新加载」，不会白屏
- **窗口保护** — AI 任务执行期防误关闭（二次确认）、被最小化/隐藏时自动拉回；任务结束 / 异常弹系统通知
- **配置写盘告警** — 配置文件写入连续失败（磁盘满 / 权限问题）时弹窗提示，设置不再静默丢失
- **增量热更新** — 差分下载 + SHA512 完整性校验 + 失败重试

---

## 技术架构

```
┌──────────────────────────────────────────────────────┐
│              渲染进程 (Renderer)                      │
│   React 18 + Vite + TailwindCSS + CodeMirror 6       │
│   Zustand stores · 三栏可拖拽布局                     │
└─────────────────────┬────────────────────────────────┘
                      │ IPC (contextIsolation + preload)
┌─────────────────────▼────────────────────────────────┐
│                   主进程 (Main)                       │
│  ┌────────────────────────────────────────────────┐  │
│  │  core-fork — 自研 AI 内核                       │  │
│  │  agent/    AgentManager · ContextTracker       │  │
│  │            ContextCompressor · SubAgentManager │  │
│  │  llm/      LLMProvider · ModelRouter           │  │
│  │            ProviderCapabilities                │  │
│  │  tools/    ToolManager · ParallelToolScheduler │  │
│  │  plan/     PlanManager                         │  │
│  │  checkpoint/ CheckpointManager · ApprovalPolicy│  │
│  │  codebase/ SemanticRetriever · SemanticIndex   │  │
│  │            EmbeddingProvider · CodebaseIndexer │  │
│  │  rag/      RagManager · DocumentParser         │  │
│  │  ppt/      pptRenderer · pptThemes             │  │
│  │  extension/ McpHub · memory/ MemoryStore       │  │
│  └────────────────────────────────────────────────┘  │
│  adapter/    Config · FileSystem · Terminal · Window │
│  ipc/handlers.ts · updater/UpdateManager.ts          │
└─────────────────────┬────────────────────────────────┘
                      │ MessagePort
┌─────────────────────▼────────────────────────────────┐
│        Agent 子进程 (utilityProcess)                  │
│        agentWorker.ts — 独立运行，崩溃不影响主界面      │
└──────────────────────────────────────────────────────┘
```

**技术栈**

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 31 |
| 渲染层 | React 18 + TypeScript 5.5 + Vite 5 |
| 样式 | TailwindCSS 3.4 |
| 编辑器 | CodeMirror 6 |
| 状态管理 | Zustand 4 |
| 文档处理 | pptxgenjs · xlsx · adm-zip |
| 更新机制 | electron-updater 6 |

---

## 安装

### 方式一：下载安装包（推荐）

前往 [官网下载页](https://ai.cnkes.cn#download) 获取最新版本，或直接下载：

```
https://ai.cnkes.cn/cnkeide/updates/CnkeIDE%20Setup%201.3.3.exe
```

安装包为 NSIS 格式，双击按引导完成安装。已安装的客户端会在启动时自动检测更新，支持差分增量下载。

### 方式二：从源码构建

```bash
# 前置要求：Node.js >= 18、npm >= 9
git clone https://github.com/CNKE-AI/cnkeide.git
cd cnke-claw

# 安装依赖
npm install

# 开发模式（热更新）
npm run dev
```

打包安装包：

```bash
npm run pack:win     # Windows — NSIS
npm run pack:mac     # macOS — dmg + zip
npm run pack:linux   # Linux — AppImage + deb
```

> **国内网络提示**：Electron 二进制下载较慢时，可指定镜像后再打包：
>
> ```bash
> # Windows PowerShell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm run pack:win
>
> # macOS / Linux
> export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" && npm run pack:mac
> ```

> **打包注意事项**（踩坑记录）：
>
> 1. **使用 JSON 配置** — `electron-builder.config.ts` 在 Windows 上编译会因路径含冒号报 `EINVAL`，故 `pack` 脚本统一指向 `electron-builder.json`。
> 2. **`win.target` 只保留 `nsis`** — 若同时配置 `nsis` 与 `portable`，两者 `artifactName` 相同会互相覆盖，导致 `latest.yml` 记录的 `sha512` / `size` 与实际文件不一致，客户端差分更新校验必然失败。`portable` 亦不支持 blockmap 差分。
> 3. **发布更新** — 将生成的 `exe` + `.blockmap` + `latest.yml` 一并上传至 `/cnkeide/updates/`，官网首页的下载按钮会自动指向最新版本。

---

## 使用说明

### 1. 打开工作区

启动后点击左上角「打开文件夹」选择项目根目录，文件树与终端随即就绪。工作区会被记住，下次启动自动恢复。

### 2. 配置模型

右上角 **设置 → 模型配置 → 添加 API**，填写：

| 字段 | 说明 | 示例 |
|---|---|---|
| 名称 | 自定义标识 | `DeepSeek` |
| Base URL | API 端点 | `https://api.deepseek.com/v1` |
| API Key | 密钥 | `sk-...` |
| Model | 模型 ID | `deepseek-chat` |

可添加多个 API，在对话输入框上方随时切换。

### 3. 开始对话

1. 在输入区上方选择交互模式（`Ask` / `Craft` / `Plan`）
2. 输入需求，回车发送；`Shift + Enter` 换行
3. `Ctrl + V` 可直接粘贴截图作为图片输入
4. AI 调用敏感工具时会弹窗确认，可在审批规则面板中将其加入白名单

### 4. 上下文引用

在输入框中输入以下标记，可将对应内容注入上下文：

| 标记 | 效果 |
|---|---|
| `@文件路径` | 注入该文件的完整内容 |
| `@目录路径` | 注入该目录的文件清单 |
| `#codebase 你的问题` | 触发仓库级语义检索 |
| `@模型名` | 强制指定本次使用的模型 |

### 5. 生成演示文稿

侧边栏选择「演示文稿」打开 PPT 工作台，三种创作方式：

- **项目一键成稿** — 扫描工作区 README 与目录结构，自动提炼大纲
- **一句话生成** — 输入演示主题，从零生成
- **内置主题设计** — 选择商业、学术、中国风或插画主题，生成可编辑的演示文稿

生成后可在左侧逐页编辑标题与要点，支持单页 / 全部 AI 细化扩写，最终导出 PPTX 或 PDF。

### 6. 常见操作

| 操作 | 方式 |
|---|---|
| 保存文件 | `Ctrl + S` |
| 压缩上下文 | 输入 `/summarize` |
| 切换交互模式 | 输入区上方 `Ask` / `Craft` / `Plan` |
| 刷新演示文稿预览 | `F5` 或 `Ctrl + R` |

### 7. 命令行运行（headless）

同一套 Agent 内核可在无界面环境运行，适合 CI 与脚本流水线：

```bash
# 从源码构建 CLI（产物 dist-cli/cnkeide.cjs）
npm run build:cli

# 单次任务，输出 NDJSON 事件流
node dist-cli/cnkeide.cjs -p "把 src/utils 里的重复函数合并" --cwd ./my-project --mode craft --json

# 无人值守流水线：放行全部工具
node dist-cli/cnkeide.cjs -p "跑一遍测试并修复失败用例" --approve-policy never --max-turns 30
```

要点：

- **事件流** — `run_start` / `assistant_delta` / `tool_call` / `tool_result` / `usage` / `run_end`
- **退出码** — `0` 成功、`1` 任务失败、`2` 参数错误、`3` 审批被拒、`4` 配置错误、`124` 超时
- **审批策略** — `never` 全部放行；默认 `untrusted` 只读工具自动放行，写操作与 `execute_command` 需 `--allow-tool` / `--allow-command-pattern` 显式放行

详见 [docs/headless-cli.md](docs/headless-cli.md)。

---

## 目录结构

```
cnke-claw/
├── electron/
│   ├── main.ts                  # 主进程入口
│   ├── preload.ts               # 渲染进程 API 桥（window.cnke）
│   ├── menu.ts                  # 应用菜单
│   ├── adapter/                 # 平台适配层（替代 VSCode API）
│   │   ├── ConfigAdapter.ts     # 配置持久化
│   │   ├── FileSystemAdapter.ts
│   │   ├── TerminalAdapter.ts   # PTY 终端
│   │   ├── WindowAdapter.ts
│   │   └── StorageAdapter.ts
│   ├── ipc/handlers.ts          # 全部 IPC 通道注册
│   ├── store/SessionStore.ts    # 会话持久化
│   ├── terminal/                # 终端进程管理
│   ├── updater/UpdateManager.ts # 增量热更新
│   └── core-fork/               # ★ 自研 AI 内核
│       ├── agent/               # AgentManager · ContextTracker
│       │                        # ContextCompressor · SubAgentManager
│       ├── llm/                 # LLMProvider · ModelRouter
│       │                        # ProviderCapabilities
│       ├── tools/               # ToolManager · ParallelToolScheduler
│       │                        # Web/Git/Grep/Test/Format/Playwright
│       │                        # ImageGen/Pptx 工具模块
│       ├── plan/PlanManager.ts  # 任务规划状态机
│       ├── checkpoint/          # CheckpointManager · ApprovalPolicy
│       ├── codebase/            # SemanticRetriever · SemanticIndex
│       │                        # EmbeddingProvider · CodebaseIndexer
│       ├── rag/                 # RagManager · DocumentParser · DocumentIndex
│       ├── ppt/                 # pptRenderer · pptThemes · pptOutlineExpand
│       │                        # pptPdf · pptPreview
│       ├── extension/McpHub.ts  # extension 协议客户端
│       ├── memory/MemoryStore.ts
│       └── util/AgentError.ts   # 标准化错误类型
├── renderer/
│   ├── index.html
│   ├── ppt.html                 # 演示文稿独立窗口
│   └── src/
│       ├── App.tsx / main.tsx / ppt-main.tsx
│       ├── global.d.ts          # window.cnke 类型声明
│       ├── components/
│       │   ├── TitleBar.tsx / MainLayout.tsx / SettingsSheet.tsx
│       │   ├── chat/            # ChatPanel · ToolCallView · PlanPanel
│       │   │                    # ContextBar · MemoryPanel · RefPicker
│       │   ├── editor/          # EditorPanel · TerminalPanel
│       │   ├── filetree/
│       │   └── ui/
│       ├── pages/PptPage.tsx    # 演示文稿工作台
│       ├── store/               # Zustand stores
│       ├── hооk/
│       └── utils/
├── scripts/                     # 测试与部署脚本
│   ├── test_w1_llm_resilience.mjs
│   ├── test_w2_parallel_tools.mjs
│   ├── ...
│   └── test_w14_pptx.mjs
├── build/                       # 打包资源（图标、NSIS 脚本）
├── docs/                        # 设计与能力文档
├── electron-builder.json        # 打包配置
├── vite.config.ts
└── package.json
```

---

## 测试

内核各模块配有独立测试脚本，基于 Node + `tsx` 运行，无需测试框架：

```bash
# 单个模块
npx tsx scripts/test_w1_llm_resilience.mjs    # LLM 容错（重试/超时/中止/Fallback）
npx tsx scripts/test_w2_parallel_tools.mjs    # 并行工具 DAG 调度
npx tsx scripts/test_w3_plan.mjs              # 规划状态机
npx tsx scripts/test_w3_plan_integration.mjs  # 规划器与工具链集成
npx tsx scripts/test_w4_tools.mjs             # 工具实现（web/git/grep/test/format）
npx tsx scripts/test_w5_semantic.mjs          # 三路召回语义检索
npx tsx scripts/test_w6_routing.mjs           # 模型路由
npx tsx scripts/test_w7_approval.mjs          # 检查点 diff + 审批规则
npx tsx scripts/test_w8_compression_subagent.mjs  # 上下文压缩 + 子 Agent
npx tsx scripts/test_w9_production.mjs        # 错误类型 + 增量快照
npx tsx scripts/test_w10_rag.mjs              # 文档问答 RAG
npx tsx scripts/test_w11_context_tracker.mjs  # 上下文用量追踪
npx tsx scripts/test_w12_browser_image.mjs    # 浏览器自动化 + 图片生成
npx tsx scripts/test_w13_updater_fix.mjs      # 更新器修复
npx tsx scripts/test_w14_pptx.mjs             # 演示文稿生成

# 类型检查
npx tsc --noEmit -p tsconfig.json
```

---

## 常见问题

<details>
<summary><b>Agent 提示「连续 N 次工具调用失败」并中断</b></summary>

熔断机制触发，说明工具连续返回错误。常见原因：工作区路径被删除、命令始终以非零码退出、或依赖的外部程序缺失。

处理：查看对话中的工具调用详情定位失败原因，修复后重新发送需求。若为误判，可在设置中调整熔断阈值。
</details>

<details>
<summary><b>模型已配置但对话无响应或报鉴权错误</b></summary>

依次检查：

1. **Base URL 格式** — 需包含版本前缀，如 `https://api.deepseek.com/v1`，而非仅域名
2. **API Key 是否有效** — 部分厂商密钥有额度过期限制
3. **Model ID 拼写** — 须与厂商文档完全一致
4. **网络连通性** — 国内直连部分境外端点需配置代理

若使用中转服务，确认其兼容 OpenAI Chat Completions 协议。
</details>

<details>
<summary><b>思考过程中界面卡顿</b></summary>

已针对该场景优化：会话写库改为防抖合并 + 异步落盘，思考面板默认收起，流式事件 50ms 节流。

若仍卡顿，通常是超长对话（数千条消息）导致。可输入 `/summarize` 压缩上下文，或新建会话继续。
</details>

<details>
<summary><b>更新后进程无法退出、安装失败</b></summary>

典型原因是旧版本进程未完全退出，导致安装包无法替换文件。处理步骤：

1. `Ctrl + Shift + Esc` 打开任务管理器，结束所有 `CnkeIDE.exe` 进程
2. 确认无残留的 `installer.exe` 进程
3. 清理 `%LOCALAPPDATA%\cnkeide-updater\pending\` 目录
4. 重新启动客户端触发更新

若 `installer.exe` 无法结束（被系统 Job Object 锁定），需重启电脑后再操作。
</details>

<details>
<summary><b>项目一键成稿的内容不准确</b></summary>

该功能完全基于工作区内的 README 与目录结构提炼，不会编造未提及的功能。请先完善项目 README，或在生成前指定关注方向。
</details>

<details>
<summary><b>代码库语义检索返回结果不理想</b></summary>

语义检索依赖向量模型。若未配置 embedding 模型，会自动降级为关键词检索，召回质量下降。

在设置的模型配置中指定 embedding 模型后即可启用完整的三路召回。首次索引大型仓库需要一定时间，后续为增量更新。
</details>

---

## 贡献指南

欢迎提交 Issue 与 Pull Request。

### 开发流程

```bash
# 1. Fork 并克隆仓库
git clone https://github.com/<your-name>/cnkeide.git
cd cnke-claw

# 2. 创建特性分支
git checkout -b feature/your-feature

# 3. 安装依赖并开发
npm install
npm run dev
```

### 提交前检查

```bash
# 类型检查必须通过
npx tsc --noEmit -p tsconfig.json

# 内核改动需跑通对应测试
npx tsx scripts/test_w<N>_<name>.mjs

# 构建验证
npm run build
```

### 代码规范

- **TypeScript 严格模式** — 避免 `any`，优先使用明确类型；错误统一走 `AgentError`
- **内核不依赖 Electron UI** — `core-fork/` 下的模块应保持纯逻辑，不直接引用 `BrowserWindow` 等
- **新增工具需注册三处** — `ToolManager` 的 `getBuiltinTools`、`execute` 分支，以及 `ParallelToolScheduler` 的并发策略
- **IPC 变更需同步类型** — 同时更新 `ipc/handlers.ts`、`preload.ts` 与 `global.d.ts`
- **提交信息** — 使用 `<type>: <description>` 格式（`feat` / `fix` / `refactor` / `docs` / `test` / `chore`）

### 新增一个 Agent 工具的步骤

```typescript
// 1. electron/core-fork/tools/YourTools.ts
export interface YourToolResult {
  success: boolean;
  data?: string;
  error?: string;
}

export async function yourToolExecute(args: { input: string }): Promise<YourToolResult> {
  try {
    return { success: true, data: `processed: ${args.input}` };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
```

```typescript
// 2. electron/core-fork/tools/ToolManager.ts — 注册定义
{
  name: 'your_tool',
  description: '工具用途的简要说明，Agent 依赖此描述决定何时调用',
  parameters: {
    type: 'object',
    properties: { input: { type: 'string', description: '输入参数说明' } },
    required: ['input'],
  },
}
```

```typescript
// 3. ToolManager.execute — 添加分发分支
case 'your_tool':
  return await yourToolExecute(args as { input: string });

// 4. ParallelToolScheduler — 声明并发策略
//    safe（可并发读）| path-serial（同路径串行）| global-serial（全局串行）
```

```typescript
// 5. scripts/test_w<N>_your_tool.mjs — 补充测试用例
```

### PR 要求

- 描述清楚改动动机与实现思路
- 关联相关 Issue
- 通过类型检查与相关测试
- 涉及 UI 的改动请附截图

---

## 许可证

本项目基于 [MIT License](./LICENSE) 发布。

你可以自由使用、修改、分发本软件（包括商业用途），只需保留原始版权声明与许可声明。软件按「原样」提供，不附带任何形式的担保。

---

<div align="center">

**[官网](https://ai.cnkes.cn)** · **[使用文档](https://ai.cnkes.cn/docs.html)** · **[Github 仓库](https://github.com/CNKE-AI/cnkeide)**

</div>
