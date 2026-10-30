# CnkeIDE vs CodeBuddy 能力对标与差距分析

> 评估对象：`c:/Users/yuhen/Downloads/CNKE/cnke-claw`（v1.2.4，Electron 桌面 AI 编程 IDE）
> 对标基准：CodeBuddy（腾讯云 AI 编程 IDE）
> 评估方式：源码盘点（renderer 渲染层 + electron 内核层 + IPC 端点全量核对），非仅依赖 README
> 评估日期：2026-09-04

---

## 1. 结论速览

| 维度 | CnkeIDE 现状 | 对标结论 |
|---|---|---|
| AI 内核（工具/调度/路由/记忆） | 12 周 T0 路线成果完整，**39 个内置工具 + MCP 动态扩展** | 领先，超过对标基线 |
| 编辑器 + 终端（IDE 底座） | **本副本缺失**（目录为空，README 描述与实际不符） | 落后，P0 差距 |
| 对话交互（多会话/多模式/审批） | 完整可用 | 持平，局部领先 |
| 上下文引用（@ 文件 / #codebase） | 有代码库检索能力但**无 UI 入口** | 落后 |
| 插件/生态/云端服务 | 无 | 落后，P2 |
| 应用管理（更新/托盘/通知/反馈） | 完整（含差分更新/强制更新） | 持平 |

---

## 2. CnkeIDE 实际能力盘点（基于代码）

### 2.1 版本与应用形态
- `package.json` version **1.2.4**，electron ^31、React 18 + Vite 5 + TailwindCSS
- 主进程入口 `electron/main.ts`：无边框窗口、托盘、系统通知、MCP/子进程资源清理、`window.cnke` preload 桥（contextIsolation 开启）

### 2.2 AI 内核（core-fork，全部主进程自研）
已确认模块齐全：

| 目录 | 模块 | 能力 |
|---|---|---|
| `agent/` | AgentManager / ContextCompressor / ContextTracker / SubAgentManager | 多轮 Agent 主循环、自动压缩、上下文占用实时追踪（context_state 事件）、子 Agent 委派（explore 只读白名单） |
| `tools/` | ToolManager + 8 个工具模块 | **39 个内置工具**；并行 DAG 调度器（safe/path-serial/global-serial） |
| `plan/` | PlanManager | 任务规划状态机（pending→running→completed/failed/skipped）+ 5 个 plan_* 工具 |
| `llm/` | LLMProvider / ModelRouter / ProviderCapabilities | 重试/退避/Abort/超时/Fallback、@model 显式路由 + 任务特征路由、17+ 国内模型能力矩阵 |
| `rag/` | DocumentParser / DocumentIndex / RagManager | PDF/DOCX/HTML/TXT 解析 + 切块 + embedding 检索 + 4 个 doc_* 工具 |
| `codebase/` | SemanticIndex / SemanticRetriever / EmbeddingProvider / CodebaseIndexer | 3 路召回（关键词+语义+符号）、增量索引 |
| `memory/` | MemoryStore | 跨会话记忆（workspace/global 作用域） |
| `checkpoint/` | CheckpointManager / ApprovalPolicy | 每轮快照 + diff + 恢复；工具审批信任规则（allow/deny/ask） |
| `mcp/` | McpHub | stdio + HTTP 双协议 MCP 客户端 |

**46 个内置工具清单**：read_file / write_to_file / create_file / delete_file / rename_file / search_files / list_directory / execute_command / apply_diff / search_symbol / get_file_outline / semantic_search / doc_ingest / doc_query / doc_list / doc_remove / browser_navigate / browser_screenshot / browser_click / browser_input / browser_extract / browser_close / image_generate / find_references / project_structure / create_plan / update_plan_status / add_plan_item / get_plan / mark_plan_complete / delegate_subagent / web_search / web_fetch / git_status / git_diff / git_commit / git_log / git_branch / git_checkout / git_fetch / git_pull / git_push / grep / run_tests / auto_fix_tests / format_code

### 2.3 IPC 端点全貌（ipc/handlers.ts 核对，约 90 个 handle + 多个 on）
- `session:*` 多会话 CRUD（listAll 跨工作区）
- `fs:*` 文件系统（listDir/read/write/create/delete/rename/searchFiles）
- `terminal:*` PTY 终端 spawn/write/resize/kill（IPC 已注册，**UI 未接**）
- `agent:run / abort / enhancePrompt`；`tool:approve-response` 审批
- `memory:*` CRUD
- `config:*` API 配置多份管理（7 类 provider 预设）
- `mcp:*` 服务器/工具管理
- `checkpoint:*` / `approval:*` / `context:*`（getState/listStates/removeState）
- `dialog:*` / `shell:*` / `window:*`
- `backend:*` 官方后台（ping/getDeviceId/getBuiltins/getAnnouncements/反馈）
- `update:*` 差分/强制更新 + 状态推送

### 2.4 UI 层实际形态（重点：与 README 有出入）
`renderer/src/` 实际组件清单：

```
MainLayout.tsx        → 仅两栏：FileTree(20%) | ChatPanel(80%)，可拖拽
TitleBar.tsx          → 窗口控制/标题栏
components/filetree/FileTree.tsx
components/chat/ChatPanel.tsx   ← 全部对话能力在这里
components/chat/Markdown.tsx / ToolCallView.tsx / MemoryPanel.tsx
components/backend/AnnouncementCenter.tsx
SettingsSheet.tsx     → 4 个 Tab：models / agent / skills / about
components/editor/    ← 【空目录】无 Monaco 编辑器
components/ui/        ← 【空目录】
pages/ hooks/ ipc-client/ ← 【空目录】
```

**README 声称的「Monaco 编辑器 + 多标签 + 内置终端」在本副本中不存在**（依赖里有 monaco 包但渲染层未接入，editor/ 目录为空；TerminalAdapter 在主进程存在但无 UI 消费）。

### 2.5 ChatPanel 对话能力（已实现项）
- **四态模式**：架构师 / 开发者 / 调试器 / 问答（区别于完整版的 Ask/Craft/Plan）
- **多会话标签栏**：新建（继承工作区 / 选新目录）、切换（自动切工作区）、删除、回滚（撤销上一轮）、重新回答
- **输入区**：文件上传（文本/代码自动读内容 ≤50K 字符截断 + 图片走多模态）、剪贴板粘贴截图、AI 一键增强（enhancePrompt）、全自动模式（工具自动批准，Zap 按钮）
- **消息气泡**：思考过程折叠展示、工具调用可视化、Markdown 渲染、Token 消耗明细 Popover（含缓存命中率）、复制 / 存入记忆 / 重新回答
- **记忆管理**：MemoryPanel 查看/管理跨对话记忆
- **工具审批弹窗**：工具名 + 参数 JSON 展示，允许/拒绝
- 绑定：每会话独立工作区，切换对话自动切换文件树

### 2.6 SettingsSheet 设置能力
- models：多 API 配置（AI Platform / DeepSeek / 通义 / GLM / Claude / Ollama / 自定义），active 切换
- agent：systemPrompt / maxTurns / temperature / topP / autoApproveTools / replyFormat
- skills：内置技能（代码审查/文档生成/单测/重构/解释）
- MCP：服务器增删、连接状态、工具列表展开/刷新
- about：版本（动态读取）、软件更新（检查/下载/安装/进度）、官方内置模型拉取、意见反馈

---

## 3. 与 CodeBuddy 的差距矩阵

### P0 —— IDE 底座缺失（当前副本最大差距）
| # | 能力 | CodeBuddy | CnkeIDE 本副本 | 备注 |
|---|---|---|---|---|
| 1 | 代码编辑器（Monaco/VS Code 内核） | ✅ 多标签页编辑、语法高亮、跳转 | ❌ editor/ 为空目录 | README 声称有，实际未接 UI |
| 2 | 内置终端（PTY 面板） | ✅ | ❌ 主进程 TerminalAdapter 已就绪，无 UI 消费 | IPC terminal:* 已注册，缺面板组件 |
| 3 | 编辑-对话联动（diff 应用到编辑器 / 打开文件定位） | ✅ | ❌ | 需 editor 底座支撑 |

### P1 —— 上下文引用与检索入口
| # | 能力 | CodeBuddy | CnkeIDE 本副本 | 备注 |
|---|---|---|---|---|
| 4 | @ 文件/目录引用（注入内容/清单） | ✅ 输入框内 | ❌ 输入区无 @ 选择器 | 内核 parseMarkers/引用注入逻辑在完整版有，本副本 UI 未带 |
| 5 | #codebase / 代码库语义检索入口 | ✅ | ⚠️ 内核 semantic_search + CodebaseIndexer 完整，但对话无 UI 唤起 | 可加 # 前缀或斜杠命令 |
| 6 | 选中代码片段送对话（Ask 选区） | ✅ | ❌ | 无编辑器即无选区链路 |

### P1 —— Agent 交互完善度
| # | 能力 | CodeBuddy | CnkeIDE 本副本 | 备注 |
|---|---|---|---|---|
| 7 | 任务进度/计划可视化（Plan 面板） | ✅ 步骤勾选 | ⚠️ 内核 PlanManager 完整但 UI 无 Plan 面板 | plan_* 工具可用，界面未呈现 |
| 8 | 多模型按会话记忆 + 快速切换下拉 | ✅ | ⚠️ 设置页可切 active，对话头部无快速切换 | |
| 9 | 单步回滚到任意消息（非仅上一轮） | ✅ | ❌ 仅 rollback(撤销上一轮)/regenerate(重答) | |
| 10 | 会话导出/导入、上下文手动压缩（/summarize） | ✅ | ❌ 本副本无导出/压缩 UI | 完整版有 session-export/import + summarize-context，本副本 IPC 未注册 |

### P2 —— 生态与扩展
| # | 能力 | CodeBuddy | CnkeIDE 本副本 | 备注 |
|---|---|---|---|---|
| 11 | 插件市场（技能市场/SDK） | ✅ 有生态 | ⚠️ 内置 5 个技能静态列表 | |
| 12 | MCP 商店 / 一键安装 | ✅ | ⚠️ 仅手动添加 stdio/http 服务器 | |
| 13 | 云端（代码托管/预览/部署） | ✅ | ❌ | backend:* 仅有公告/反馈/内置模型 |

### 持平或领先项（无需追赶）
- 工具审批弹窗 + 全自动模式（autoApprove）✅ 强于多数基线
- Token 消耗明细 + 缓存命中率展示 ✅
- 跨会话记忆管理面板 ✅
- 多会话绑定独立工作区、标签栏切换自动联动文件树 ✅
- 应用自更新（差分 + 强制更新 + 断点续传 + 状态推送）✅
- 39 工具全链路（浏览器自动化 / 图片生成 / RAG 文档问答 / 语义检索 / 计划状态机）✅ 内核领先

---

## 4. 建议路线（按投入产出排序）

1. **P0-1 恢复编辑器面板**：接入 monaco-editor（依赖已存在），实现 FileTree 点击打开 + 多标签 + Ctrl+S 保存 + read_file 落盘后自动刷新。这是补齐「IDE」形态的第一步。
2. **P0-2 恢复终端面板**：复用主进程 `terminal:*` IPC（已注册），实现终端组件 + 活动日志分流（activity-event），与 editor 共用底部区域。
3. **P1-1 输入区增强**：加 @ 文件/文件夹引用选择器（内核 FileReference/buildPromptWithRefs 逻辑可移植）、#codebase 语义检索触发、斜杠命令（/summarize、/export）。
4. **P1-2 Plan 面板**：订阅 plan 状态事件，把 PlanManager 状态机渲染为步骤卡片（可勾选/失败标红），并让 ask 模式白名单与 Plan 工具联动。
5. **P1-3 对话体验**：会话导出/导入 JSON、单条消息级回滚、上下文占用进度条（ContextTracker 的 context_state 事件已有，缺 UI）。
6. **P2 生态**：技能从静态列表升级为可下载技能包；MCP 一键导入常用服务器模板。

---

## 5. 备注（数据可信度）
- 工具数、IPC 清单、组件清单均为 2026-09-04 源码直接核对（ToolManager.ts 39 个 name、handlers.ts documentSymbol 全量、components/ 目录逐层列出）。
- 与完整版（cnkeclaw 主工程）差异：本副本是「文件树 + 对话」两栏精简形态，内核 12 周成果（W1–W12）保持完整。
- 若以完整版（含编辑器/终端/Ask-Craft-Plan/@引用/会话导入导出）为准，则 P0 项多数已具备，本报告差距集中在 P2 生态层。
