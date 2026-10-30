# CnkeIDE 功能总览

版本：1.3.2 　|　整理日期：2026-10-27 　|　代码基线：`cnke-claw` 仓库当前工作副本

按能力域穷举现有功能，每项均对应仓库真实实现；第 23 节另列**未实现项**，便于排期。

## 统计摘要

| 指标 | 数量 |
| --- | --- |
| 内置 Agent 工具 | 39 |
| 交互模式 | 4（Ask / Craft / Plan / Debug） |
| 主进程 IPC 端点 | 112（107 handle + 5 on） |
| IPC 命名空间 | 21 |
| 编辑器支持语言 | 14 |
| PPT 主题 / 版式 / 场景 | 4 套 / 6 类 / 6 个 |
| MCP 内置目录条目 | 10 |
| 内置提示词技能 | 5 |
| 模型能力矩阵 | 17+ 主流模型 |

---

## 1. 定位与技术底座

桌面端 AI IDE：本地仓库读写 + 多模型 Agent + 计划执行 + 演示文稿生成 + 云端更新/公告/模板生态。

| 层 | 技术 |
| --- | --- |
| 运行时 | Electron 31 |
| 界面 | React 18.3 + TypeScript 5.5 + Tailwind 3.4 + Zustand 4.5 |
| 编辑器内核 | CodeMirror 6（14 个语言包） |
| 构建 | Vite 5 + vite-plugin-electron + electron-builder（NSIS） |
| 文档渲染 | react-markdown + remark-gfm + rehype-highlight + DOMPurify |
| 通信 | 自定义 IPC 客户端 + preload 暴露 `window.cnke` |
| 扩展协议 | `@modelcontextprotocol/sdk`（MCP 客户端） |
| 演示文稿 | 自研渲染器 + pptxgenjs |

## 2. 进程模型

- 单实例锁：二次启动聚焦已有窗口。
- 主窗口：自定义标题栏，窗口按钮走 preload `window:*` 通道。
- 应用菜单（`electron/menu.ts`）+ 系统托盘（单击/双击唤起，含上下文菜单）。
- Agent 运行在独立子进程中，经消息端口与主进程通信（主进程负责事件转发、工具执行、审批回调）。
- 会话级事件隔离：`AgentManager.sessionEmitters`，多会话并行不串流。

## 3. 四种交互模式

`AgentMode = 'architect' | 'coder' | 'debugger' | 'ask'`，各自独立系统提示词 + 工具集。

| 模式 | 界面名 | 定位 |
| --- | --- | --- |
| `ask` | Ask | 只读问答：仅 10 个只读工具（`read_file`、`search_files`、`list_directory`、`get_plan`、`grep`、`web_search`、`web_fetch`、`git_status`、`git_log`、`semantic_search`） |
| `coder` | Craft | 编码实现：全量工具 |
| `architect` | Plan | 规划：先拆解计划再执行（`PLAN_GUIDE`） |
| `debugger` | Debug | 排错：定位、复现、修复 |

公共提示词含**结构化 Markdown 排版规范**（标题层级、列表缩进、表格列数、行内代码等 21 条），保证渲染稳定。

## 4. 内置工具集（46 个）

注册于 `electron/core-fork/tools/ToolManager.ts`；MCP 动态工具运行时追加。

### 4.1 文件与编辑（10）

| 工具 | 作用 |
| --- | --- |
| `read_file` | 读取文件内容（支持区间） |
| `write_to_file` | 整文件写入/覆盖 |
| `create_file` | 新建文件 |
| `apply_diff` | `SEARCH / === / >>>REPLACE` 块精确替换（推荐局部修改） |
| `delete_file` | 删除文件 |
| `rename_file` | 重命名/移动 |
| `list_directory` | 列目录 |
| `search_files` | 文件名模式搜索 |
| `get_file_outline` | 文件大纲（符号结构） |
| `format_code` | 自动识别并格式化（prettier / eslint --fix / black / gofmt / rustfmt） |

### 4.2 搜索与语义检索（4）

| 工具 | 作用 |
| --- | --- |
| `grep` | 内容正则搜索（优先 ripgrep，Node 兜底，跳过 `node_modules/.git/dist`） |
| `semantic_search` | 三路混合召回（关键词 + Embedding + 符号引用） |
| `search_symbol` | 符号定义查找 |
| `find_references` | 引用查找 |

### 4.3 项目结构（1）

`project_structure`：生成项目结构视图，供模型建立全局认知。

### 4.4 Git（9）

| 工具 | 作用 |
| --- | --- |
| `git_status` | 工作区状态 |
| `git_diff` | 差异（带体积上限） |
| `git_log` | 提交历史 |
| `git_commit` | 提交（支持 `addAll`、作者） |
| `git_branch` | 分支管理（list / create / delete / rename，可顺带 checkout） |
| `git_checkout` | 切换分支或提交（支持 `create` + `startPoint`、`force`） |
| `git_fetch` | 拉取远端引用（默认 `--prune`） |
| `git_pull` | 拉取并合并（默认 `--ff-only`，分叉时报错并提示可改 rebase） |
| `git_push` | 推送（从不 force；`main`/`master` 需显式 `allowProtected`，支持 `-u` 与 `--tags`） |

### 4.5 执行与验证（3）

| 工具 | 作用 |
| --- | --- |
| `execute_command` | 执行 Shell 命令（可指定 cwd、超时、可中止） |
| `run_tests` | 自动识别测试框架并运行（npm/yarn/pnpm/pytest/go/cargo/make）；**失败时保留完整输出** |
| `auto_fix_tests` | 测试自愈循环：跑测试 → 结构化解析失败 → 子 Agent 修代码 → 再跑，直到全绿 / 到轮数上限 / 无进展 |

### 4.6 任务计划与委派（6）

| 工具 | 作用 |
| --- | --- |
| `delegate_subagent` | 委派子 Agent（general-purpose / explore，explore 强制只读白名单） |
| `create_plan` | 创建计划 |
| `update_plan_status` | 推进/更新步骤状态 |
| `add_plan_item` | 追加步骤 |
| `get_plan` | 读取计划 |
| `mark_plan_complete` | 收尾计划 |

### 4.7 网络（2）

| 工具 | 作用 |
| --- | --- |
| `web_search` | 联网搜索（DuckDuckGo HTML 端点，无需 Key） |
| `web_fetch` | 抓网页转纯文本（200KB 上限） |

### 4.8 浏览器自动化（6）

基于 Playwright，可用于端到端验证与信息采集：`browser_navigate`（打开）、`browser_screenshot`（截图）、`browser_click`（点击）、`browser_input`（输入）、`browser_extract`（取文）、`browser_close`（关闭）。

### 4.9 文档 RAG（4）

| 工具 | 作用 |
| --- | --- |
| `doc_ingest` | 摄入文档（PDF/DOCX/HTML/MD/TXT/CSV/LOG） |
| `doc_query` | 检索并返回带 `[1][2]` 编号上下文 |
| `doc_list` | 列出已索引文档 |
| `doc_remove` | 移除索引 |

### 4.10 多模态生成（1）

`image_generate`：调用图像生成接口出图（支持落盘）。

## 5. Agent 内核机制（25 项）

1. **四套模式提示词**：按模式注入系统提示。
2. **模式化工具白名单**：`ask` 仅 10 个只读工具。
3. **流式增量输出**：`streamBuf` / `pushStream` / `flushStream`，边生成边显示。
4. **并行工具 DAG 调度**：拓扑排序，策略 `safe`（只读并发）/ `path-serial`（同路径写串行）/ `global-serial`（危险操作串行），默认并发 4，循环依赖回退串行。
5. **工具审批**：`ApprovalPolicy` 按 `toolName / pathPattern / commandPattern` 匹配 `allow / deny / ask`，首条命中生效；发 `approval_request` / `approval_resolved` 事件。
6. **零审批模式**：`zeroApprovalMode`（默认开）对 `write_to_file` / `create_file` / `apply_diff` 及只读白名单免弹窗；删除、重命名、命令、测试、格式化仍需确认。
7. **工具结果预算裁剪**：`enforceTurnBudget` 按上下文窗口 30% 裁剪（保留头 70% + 尾 25%）。
8. **自动压缩**：达阈值摘要化早期对话，发 `context_compressed`。
9. **手动压缩**：`summarizeContext`，界面有入口。
10. **上下文实时追踪**：记录 token、字符量、占用比例与三档水位（safe/warning/critical），发 `context_state`。
11. **模型路由**：首轮决策（`@模型` > 任务特征 > 用户配置 > 当前模型），后续轮固定防漂移。
12. **主备 Fallback**：主配置失败按 `fallbackModelIds` 或其它已启用 API 派生备用链（最多 3 个），发 `model_fallback`。
13. **重试与超时**：`maxRetries`（默认 3）、指数退避 + 抖动、单次与整体超时、429/5xx/网络错误可重试、4xx 不重试。
14. **中止**：每会话独立 `AbortController`，中止时释放挂起审批。
15. **幻觉检测**：`detectHallucination` 校验回复提到的工具是否真实存在，抑制编造。
16. **自动记忆抽取**：从对话提炼 `preference` / `project` 条目，作用域 global/workspace，重要度 1–3。
17. **SubAgent 委派**：`general-purpose` 与 `explore`（强制只读白名单），同父会话并发互斥，可限轮次与取消。
18. **计划引导**：多步任务先建 2–8 步计划并逐步推进。
19. **输出格式规范**：结构化 Markdown 21 条。
20. **会话级事件隔离**。
21. **耗时统计**：单轮 LLM 与工具执行耗时。
22. **熔断**：连续工具失败达阈值中止，避免无效循环。
23. **提示词增强**：`enhancePrompt` 把简短需求扩写为结构化描述。
24. **修改文件追踪**：`getModifiedFiles`。
25. **错误标准化与安全执行**：`AgentError`（LLM/TOOL/PLAN/CFG/FS/CKP/UNKNOWN + 不可重试判定）；`SafeSpawn`（二进制黑名单、环境变量清理、安全 spawn）。

## 6. 模型层

- **多提供商配置**：OpenAI 兼容协议；预设 AI Platform、DeepSeek、通义千问、智谱 GLM、Claude、Ollama、自定义中转。
- **能力矩阵**：`ProviderCapabilities` 描述 function calling / vision / reasoning / streaming、上下文窗口、档位（flagship / standard / fast / reasoning），覆盖 17+ 模型。
- **路由**：`ModelRouter` 四层决策 + 任务类型识别（vision / reasoning / plan / code / summarize / chat）。
- **模型 AUTO（W28）**：模型下拉首项 `AUTO`，按任务自动升降档；**候选池仅内置 API**（`official_` 前缀或 `builtin` 标记），用户自定义配置只能手动选用、永不参与自动路由，无内置模型时沿用当前模型并提示；能力硬约束先过滤（带图只发 vision 模型，`@` 到不满足能力的模型会被拦截并改由路由选择）、重工具链（≥3 条工具结果）直上旗舰档、推理强弱信号分级防误判；首轮决策写入本次 run 的应答配置，多轮不漂移；每次决策通过 `model_routed` 事件回传界面，展示本轮模型与理由；`modelSelectionMode=manual` 时行为与固定模型完全一致。
- **AUTO 路由设置（W28 P1）**：设置 → Agent 页提供「任务 → 模型映射」（日常问答 / 编码任务 / 推理分析 / 图片理解 / 规划任务 / 总结摘要），候选项只列内置模型，留空即跟随自动选档；写入 `agentConfig.routing`，保存时只保留合法任务键，脏键不会落盘。
- **别名与提及**：`resolveModelAlias` 模糊匹配、`extractModelMention` 解析 `@模型`。
- **参数可调**：温度、topP、`maxTurns`、历史条数、系统提示词覆盖。
- **用量回传**：usage 解析后计入上下文追踪与消息底部统计。

## 7. 代码理解与检索

- **仓库索引**：`CodebaseIndexer` 建文件/符号/引用索引。
- **代码切块**：按符号行 + 空行切分（2000 字符上限），文件签名增量避免重复解析。
- **Embedding**：`EmbeddingProvider` 走 `/v1/embeddings`，LRU 缓存、并发合并、模型可配（默认 `text-embedding-3-small`）。
- **三路混合召回**：关键词（行级反向索引 + 中英文分词）、语义（cosine topK）、符号（定义 + 引用），默认权重 0.4 / 0.5 / 0.3；无 embedding 自动降级纯关键词。
- **扫描排除**：`node_modules`、`.git`、`dist` 等。

## 8. 上下文与记忆

- **水位追踪**：占用比例、字符数、估算 token、消息轮数，三档提示。
- **压缩**：自动 + 手动。
- **历史裁剪**：`maxMode=false` 时仅保留最近若干条（默认 20）。
- **记忆库**：`MemoryStore` 增删改查、作用域 global/workspace、类型 preference/project、重要度分级、容量上限。
- **自动记忆**：见 5.16；界面有记忆面板。

## 9. 任务计划

- **状态机**：`pending → running → completed | failed | skipped`，终态不可回退，另有 `abandon`。
- **聚合**：进度统计 + `summaryForLlm` 供模型自省。
- **事件**：`PlanEvent` 订阅，界面实时刷新。
- **工具**：5 个 plan 工具。
- **界面**：跳过、重试、废弃。

## 10. Checkpoint 与审批

- **自动快照**：每轮改动留痕，首次全量、后续增量；文件未变则 no-op 快照。
- **差异**：`computeFileDiff` 输出 `added / deleted / modified / unchanged` 与 `unifiedDiff`、增删行数（LCS + hunk，context=3）。
- **回滚**：`restore(snapshotId)` 一键回到任意快照。
- **统计**：快照数、原始体积、节省字节、no-op 数。
- **审批规则**：持久化到 `agentConfig.approvalRules`，增删改查 + glob（`**` / `*` / `?`，Windows 路径自动归一）。
- **界面**：审批规则面板 + 审批弹窗（含"记住此决定"）。

## 11. MCP 生态

- **客户端**：`McpHub` 支持 `stdio` 与 `streamable HTTP`，连接状态机、工具发现与调用、`autoApprove` 名单。
- **服务器管理**：增删、启停、编辑、刷新工具、查看工具清单。
- **内置目录**：10 个一键安装条目——File System、GitHub、Fetch/Puppeteer、SQLite、Git、Time/Date、PostgreSQL、Tavily Search、Playwright、Memory。
- **参数归一**：`normalizeMcpArgs` 兼容不同服务器入参风格。
- **与审批联动**：并入统一策略表，参与并行调度与审批。

## 12. 技能系统

- **两类**：包技能（本地目录包 + 清单）与提示词技能（内置）。
- **注册表**：`SkillRegistry` 扫描本地目录、解析清单、启用/禁用。
- **内置 5 个**：代码审查助手、文档生成器、单测生成器、重构大师、代码解释器。
- **注入**：启用技能内容并入 system prompt。
- **界面**：与 MCP 市场同屏（已安装 / 目录）。

## 13. 文档 RAG

- **解析**：`DocumentParser` 零外部依赖支持 `.md/.markdown/.txt/.log/.csv/.html/.htm/.pdf/.docx`。
- **切块**：段落优先 + 滑窗（约 800 字符 / 100 重叠）。
- **检索**：embedding cosine topK，缺 embedding 降级关键词。
- **格式化**：`formatHitsForLlm` 输出带编号引用。
- **管理**：`RagManager` 提供 `ingest / query / list / remove`。

## 14. 演示文稿（PPT）

- **链路**：扫描工作区 → 提炼大纲 → 选场景/主题 → HTML 预览 → 导出 PPTX / PDF。
- **主题 4 套**：商业/产品风、简约学术风、中国风、轻松插画风。
- **版式 6 类**：封面、目录、分节、内容、数据、结尾。
- **场景 6 个**：商务汇报、产品发布、项目提案、年度总结、培训课件、通用演示。
- **AI 设计**：模型输出配色/艺术方向/单页提示并归一化。
- **大纲扩写**：按目标页数扩写。
- **渲染**：HTML（含 SVG 图表）、预览、栅格版式规格、装饰图形、品牌配色（可存默认品牌）。
- **质量审查**：检查大纲/单页（含图片拉伸变形），输出问题摘要。
- **导出**：PPTX（pptxgenjs）、PDF。
- **在线模板库**：索引、缩略图、下载、缓存、文件名安全化、中文 ID 编码，支持套用。
- **PptMaster 工作区**：管理外部 Python 依赖环境（检测、安装、绑定、列出能力/项目、打开目录、选择保存路径）。

## 15. 浏览器自动化与图片生成

- **浏览器**：`PlaywrightAdapter` 抽象，未安装时 Mock + 安装提示；真实适配器 headless Chromium（1280×720），截图支持 base64/落盘。
- **图片**：`ImageGenAdapter` 抽象，真实实现走 `/v1/images/generations`（`dall-e-3`，5 种尺寸，b64 落盘，60s 超时）。
- **开关**：设置中分别启用并指定模型配置。

## 16. 会话管理

- 创建/保存/加载/删除/列举（按工作区与全局）。
- 消息级：编辑、删除单条、从某条重新生成。
- 分支：`forkSession` 复制历史。
- 导入/导出：JSON，支持带图片消息。
- 压缩：摘要替换历史。
- 图片附件持久化（消息表 images 列，JSON 存 dataURL 列表）。
- 多会话标签，按工作区恢复最近会话。

## 17. 界面功能

### 17.1 布局

- 自定义标题栏：Logo、工作区切换标签、窗口按钮、设置入口。
- 可拖拽分栏：文件树 / 编辑器 / 对话 / 计划；编辑器区内部再分「编辑器 / 终端」上下可调；支持折叠与最小尺寸。
- 主题：亮 / 暗（`themeStore`）。

### 17.2 编辑器

- CodeMirror 6，14 种语言：JS / TS / JSX / TSX、Python、Go、Rust、Java、C/C++、PHP、SQL、HTML、CSS、JSON、XML、YAML、Markdown。
- 多标签、未保存标记、保存、语法高亮、搜索替换、一键格式化。
- 只读预览模式（查看 diff / 生成内容）。
- 内联补全：`InlineCompletionService`（可开关、可取消）。
- Agent 改动可视化（diff 视图与 checkpoint 联动）。

### 17.3 终端

- `TerminalAdapter` 管理子进程终端：`spawn / write / resize / kill`，stdout/stderr 流式推送渲染层（`terminal:output` / `terminal:exit`）。
- 标签页、清屏、关闭。
- Agent 执行的命令与输出在同一终端视图呈现（机器人标识区分来源）。

### 17.4 文件树

- 新建文件/文件夹、重命名、删除、刷新。
- 目录展开、文件图标、当前文件高亮。
- 工作区监听（`WorkspaceWatcher`）：外部变更自动刷新。
- 与 `@引用` 选择器联动。

### 17.5 对话区

| 组件 | 功能 |
| --- | --- |
| `ChatPanel` | 主容器，顶部四模式切换 |
| `ChatHeader` / `ChatHeaderMenu` | 会话标题、模型切换、会话菜单（新建工作区、导入、压缩、回滚、删除、记忆） |
| `ModelSwitcher` | 切换当前模型 |
| `ContextBar` | 上下文占用条（比例、token、水位色） |
| `ToolCallView` | 工具卡片：名称、参数、状态、输出折叠、耗时 |
| `PlanPanel` | 计划步骤与进度，跳过/重试/废弃 |
| `CheckpointPanel` | 快照列表、逐文件 diff、一键回滚 |
| `ApprovalRulesPanel` | 审批规则管理 + 零审批开关 |
| `MemoryPanel` | 记忆条目增删改查 |
| `RefPicker` | `@` 文件/目录/工作区引用选择器 |
| `SessionToolbar` | 导出/导入/新建/删除等会话操作 |
| `Markdown` | 渲染回答：代码高亮 + 复制、表格、外链拦截（仅 http/https/mailto） |
| `ToastHost` | 全局 toast（替代原生 alert） |
| `ErrorBoundary` | 渲染异常兜底 |

- 输入框：多行、Enter 发送 / Shift+Enter 换行、停止生成、图片粘贴（剪贴板截图 → dataURL，缩略图可移除）、`@` 引用。
- 思考过程面板：可展开/收起，流式显示。
- 审批弹窗：允许/拒绝 + 记住选择。

### 17.6 预览

`PreviewPanel`：HTML / Markdown / 文本 / 图片预览（PPT 预览、生成物查看）。

### 17.7 公告与反馈

- `AnnouncementCenter`：拉取云端公告、按版本/平台过滤、一次性公告已读、订阅推送。
- 意见反馈：提交与历史查看（关于页）。

### 17.8 设置面板（4 个 Tab）

**模型配置**
- 提供商预设（AI Platform / DeepSeek / 通义千问 / 智谱GLM / Claude / Ollama / 自定义）
- Base URL、API Key、模型名、上下文窗口
- 新增 / 编辑 / 删除、设为当前、测试连通性
- 官方模型列表拉取与同步

**Agent 设置**
- 默认交互模式、Max 模式（完整历史 vs 裁剪）、历史条数上限
- 系统提示词覆盖、`maxTurns`
- 温度、topP
- 自动批准工具调用（`autoApproveTools`）
- 零审批模式（`zeroApprovalMode`）
- 模型路由开关（`enableRouting`）
- 工具并发数（`toolConcurrency`）
- 重试次数、LLM 超时、备用模型列表
- 浏览器自动化开关、图片生成开关 + 指定配置
- 内联补全开关（`enableInlineCompletion`）
- 回复格式（`replyFormat`）

**技能 / MCP 市场**
- 子页：已安装 / 目录
- MCP：新增（stdio/http + 命令/参数/URL）、启停、删除、刷新工具、查看工具清单
- 技能：扫描、启用/禁用、来源与描述

**关于**
- 版本信息、更新检查/下载/安装、进度条、差分标识
- 专业版能力总览（能力卡片 + 关键数字）
- 公告中心入口、意见反馈、更新日志、软件信息

## 18. IPC 接口清单（112 个，21 个命名空间）

| 命名空间 | 数量 | 覆盖能力 |
| --- | --- | --- |
| `fs` | 13 | 打开文件夹、读写、列目录、新建、删除、重命名、存在判断、搜索、监听与状态 |
| `ppt` | 12 | 场景/主题列表、大纲、预览、生成、AI 设计、品牌读写、工作区扫描、保存 HTML |
| `session` | 10 | 增删查、消息删除、导入导出、摘要压缩、全部会话 |
| `mcp` | 9 | 服务器增删改查、启停、工具列表/刷新/调用、目录安装 |
| `update` | 8 | 检查、下载、安装、取消、状态、日志、更新说明、公告检查 |
| `backend` | 7 | 公告获取/订阅、反馈提交/列表、设备 ID、内置配置、ping |
| `pptmaster` | 7 | 环境检查、装依赖、能力/项目列表、打开目录、选保存路径、重绑 Python |
| `config` | 6 | 读写配置、API 配置增删查、内置同步 |
| `checkpoint` | 5 | 快照列表/单查/diff/回滚/修改文件 |
| `memory` | 5 | 增删改查、清空 |
| `plan` | 4 | 读取、跳过、重试、废弃 |
| `terminal` | 4 | spawn、write、resize、kill |
| `context` | 3 | 单会话状态、列表、移除 |
| `agent` | 3 | 运行、提示词增强、事件流 |
| `approval` | 3 | 规则列表/新增/删除 |
| `dialog` | 3 | 打开、保存、消息 |
| `skills` | 3 | 列表、扫描、启用 |
| `shell` | 2 | 打开外链、打开路径 |
| `app` | 2 | 版本、平台 |
| `completion` | 2 | 内联补全、取消 |
| `tool` | 1 | 工具相关查询 |

另有窗口控制通道（`window:minimize / maximize / close / isMaximized / set-agent-busy`）与事件订阅（`agent:onEvent / onToolCall / onToolResult`、`fs:onChanged`、`terminal:onOutput / onExit`、`update:onStatus`）。

## 19. 更新与发布

- **更新器**：`electron-updater` + 自研 `UpdateManager`，generic provider（`https://ai.cnkes.cn/cnkeide/updates`）。
- **能力**：语义化版本比较、静默/手动检查、下载进度与状态机（idle/checking/available/not-available/downloading/downloaded/installing/error）、blockmap 差分、SHA512 校验、失败重试、更新日志（JSONL，环形截断）、取消。
- **强制更新**：`minimumRunVersion` 低于要求时弹不可跳过对话框（稍后提醒/立即更新/失败重弹）。
- **稳定性**：安装前清理残留进程、延时释放句柄、自动模式倒计时安装、NSIS 预清理旧 updater 目录。
- **发布链**：`electron-builder` NSIS 打包 → 上传 exe / blockmap / latest.yml / releasenotes → 官网下载按钮自动指向最新版。

## 20. 云端服务与生态

- **公告系统**：云端 `api.php` 管理，按 `platform` / `minVersion` / `channel` 过滤，客户端订阅 + 公告中心网页版。
- **意见反馈**：客户端提交，后台列表管理。
- **设备标识**：设备 ID 生成与上报。
- **内置配置同步**：云端下发的内置 API/模型配置。
- **PPT 模板服务**：索引、缩略图、下载、分类、搜索。
- **官网**：首页（功能/路线/下载）、文档帮助页、公告页、反馈页，下载地址动态跟随 `latest.yml`。

## 21. 本地数据

| 数据 | 位置 |
| --- | --- |
| 配置（含 API 配置、Agent 配置、审批规则、MCP 服务、技能开关） | 用户数据目录 `config/`（`ConfigAdapter`） |
| API Key | 独立的加密存储（内置存储适配器） |
| Checkpoint 快照 | 用户数据目录 `checkpoints/` |
| 会话与消息 | 本地会话库（`sessionDb`，含图片列、工具调用、分支） |
| 记忆 | `MemoryStore` 持久化 |
| RAG 文档索引 | 本地索引文件 + embedding 缓存（内存 LRU） |
| 更新日志 | `logs/update-log.jsonl` |
| PPT 模板缓存 | 用户缓存目录（文件名安全化后） |

## 22. 工程质量

- 类型检查：`tsc -p electron/tsconfig.json --noEmit`、`tsc -p renderer/tsconfig.json --noEmit`。
- 提交前：`npm run build`（tsc + vite build）。
- 回归：`scripts/run_all_w1_w16.ps1` 汇总 W1–W16 阶段单测（LLM 容错、并行调度、计划、工具、语义检索、路由、审批、压缩与子代理、加固、RAG、上下文、浏览器与图片、更新器等）；W18–W28 另有独立脚本（历史统计、任务工作区、报告导出、任务管理、内容检索、项目指令、权限档位、git 写操作、测试自愈循环、模型 AUTO 路由、AUTO 界面验收）。
- Lint：ESLint 9（`typescript-eslint` + `react-hooks`）。

## 23. 已知边界与未实现项

按对用户价值排序，均为当前版本确实缺失：

| 优先级 | 缺失项 | 说明 |
| --- | --- | --- |
| P1 | **并行任务隔离** | 无 git worktree 级隔离，多会话并行改同一仓库会互相覆盖 |
| P1 | **代码托管平台集成** | git 写操作已闭环（branch / checkout / fetch / pull / push），但未对接 GitHub / GitLab API：不能自动建 PR、读 CI 状态、处理评审意见 |
| P1 | **合并冲突处理** | `git_pull` 默认 `--ff-only`，遇到真实冲突不自动解决，只返回提示让人决策 |
| P1 | **结构化代码审查** | 无 `/review` 式分支级审查面板（可用 checkpoint diff 复用实现） |
| P1 | **推理强度开关** | 可选模型但未暴露 reasoning effort |
| P1 | **成本与限额** | 有 token 统计，缺费用累计与超限告警 |
| P2 | **MCP 服务端模式** | 仅客户端，不能把自身能力以 MCP server 形式对外提供 |
| P2 | **语音输入** | 未支持 |
| P2 | **完成通知** | 长任务结束无系统级提醒（托盘已具备基础能力） |
| P2 | **配置 profile 分层** | 无多套行为配置快速切换 |

## 24. 关键文件索引

| 能力 | 文件 |
| --- | --- |
| Agent 内核 | `electron/core-fork/agent/AgentManager.ts` |
| 工具注册与执行 | `electron/core-fork/tools/ToolManager.ts` |
| 并行调度 | `electron/core-fork/tools/ParallelToolScheduler.ts` |
| LLM 容错 | `electron/core-fork/llm/LLMProvider.ts` |
| 模型路由 | `electron/core-fork/llm/ModelRouter.ts`、`ProviderCapabilities.ts` |
| 语义检索 | `electron/core-fork/codebase/SemanticRetriever.ts`、`SemanticIndex.ts`、`EmbeddingProvider.ts` |
| 上下文 | `electron/core-fork/agent/ContextTracker.ts`、`ContextCompressor.ts` |
| 计划 | `electron/core-fork/plan/PlanManager.ts` |
| Checkpoint / 审批 | `electron/core-fork/checkpoint/CheckpointManager.ts`、`ApprovalPolicy.ts` |
| 记忆 | `electron/core-fork/memory/MemoryStore.ts` |
| MCP | `electron/core-fork/mcp/McpHub.ts`、`McpCatalogService.ts` |
| 技能 | `electron/core-fork/skills/SkillRegistry.ts`、`builtins.ts` |
| RAG | `electron/core-fork/rag/*` |
| PPT | `electron/core-fork/ppt/*`、`pptmaster/*` |
| 补全 | `electron/core-fork/completion/InlineCompletionService.ts` |
| 子代理 | `electron/core-fork/agent/SubAgentManager.ts` |
| 更新 | `electron/updater/UpdateManager.ts` |
| IPC | `electron/ipc/handlers.ts` |
| 前端入口 | `renderer/src/components/MainLayout.tsx`、`TitleBar.tsx` |
| 对话区 | `renderer/src/components/chat/*` |
| 设置 | `renderer/src/components/SettingsSheet.tsx` |
| 编辑器 / 终端 | `renderer/src/components/editor/*` |
