# CnkeIDE Headless CLI

把 IDE 内的 Agent 内核（`electron/core-fork`）搬到纯 Node 进程运行，用于 CI、脚本、管道等无窗口场景。
与 GUI 共用同一套配置、工具、审批策略与模型路由，差别只在 adapter 实现。

## 构建与安装

```bash
npm run build:cli          # 产物 dist-cli/cnkeide.cjs（单文件，~1MB）
npm run test:headless      # 构建 + 端到端验收（内置 mock LLM，不消耗额度）
```

`package.json` 已声明 `bin.cnkeide`，`npm i -g .` 或 `npm link` 后可直接用 `cnkeide` 命令。

## 基本用法

```bash
# 一次性任务
cnkeide -p "把这个报错修掉" --cwd ./repo

# 从管道读任务
git diff | cnkeide --stdin --mode debug

# CI 内机器可读输出
cnkeide -p "修复 lint" --json --approve-policy never

# 只取最终文本，方便 shell 变量
TEXT=$(cnkeide -p "总结这次改动" --final-only)
```

## 参数

| 参数 | 说明 |
| --- | --- |
| `-p, --prompt <text>` | 任务描述；也可用位置参数直接跟文本 |
| `--stdin` | 从标准输入读取任务（与 `-p` 同时存在时拼接） |
| `--cwd <dir>` | 工作区根目录，工具相对路径以此为根（默认当前目录） |
| `--mode <m>` | `ask` / `craft` / `plan` / `debug`（映射到内部 `ask/coder/architect/debugger`） |
| `--model <id>` | 锁定模型：先按配置 ID 匹配，再按模型名匹配；命中后关闭自动路由 |
| `--max-turns <n>` | Agent 最大轮次 |
| `--timeout <sec>` | 整体超时，超时触发 `abort` 并以 124 退出 |
| `--approve-policy <p>` | `never` / `untrusted`（默认）/ `on-request` |
| `--allow-tool <name>` | 额外放行的工具，可重复或逗号分隔，`*` 表示全部 |
| `--allow-command-pattern <re>` | `execute_command` 允许的命令正则，可重复 |
| `--json` | NDJSON 事件流（每行一个 JSON 对象） |
| `--final-only` | 只输出最终文本 |
| `-v, --verbose` | 调试日志（写 stderr） |
| `--no-persist` | 无状态运行，数据落临时目录 |
| `--data-dir <dir>` | 指定数据目录（默认 `~/.cnkeide`） |
| `--no-memory` | 关闭本地记忆 |
| `--mcp` | 启动已配置的 MCP 服务器（默认关闭，避免静默拉起常驻进程） |

## 输出与退出码

- **stdout 只有数据**：默认是流式回复文本；`--json` 时是 NDJSON 事件；`--final-only` 时只有最终结果。
- **所有日志走 stderr**（含工具调用提示、错误、`-v` 调试信息），管道友好。

事件类型（`--json`）：`run_start`、`assistant_delta`、`thinking`、`tool_call`、`tool_result`、`context_state`、`context_compressed`、`error`、`usage`、`run_end`。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含用户主动中止） |
| 1 | 任务失败（含未配置 API） |
| 2 | 用法错误（缺 prompt、未知参数、非法取值） |
| 3 | 审批被拒 |
| 4 | 上下文超限 |
| 124 | 超时 |

## 审批模型（重要）

无窗口时无法弹窗，`ApprovalPolicy` 命中 `ask` 后会交给 CLI 注入的裁决器（`AgentManager.setApprovalHandler`）：

- `--approve-policy never`：全部放行。
- `--approve-policy untrusted`（默认）/ `on-request`：只读工具自动放行；`write_to_file` 等写操作、`execute_command`
  一律拒绝（`execute_command` 可用 `--allow-command-pattern` 精确放行）；`--allow-tool` 可逐个追加。
- 被拒时不会落盘，工具结果返回「已拒绝」，Agent 会拿到该结果继续推理。

只读白名单见 `electron/headless/bootstrap.ts` 的 `READ_ONLY_TOOLS`。

> GUI 不注入裁决器，行为与之前完全一致（仍走弹窗 + 60s 超时）。

## 数据与配置

CLI 与 GUI 默认数据目录分离：GUI 用 Electron `userData`，CLI 用 `~/.cnkeide`（可用 `CNKEIDE_HOME` 覆盖）。
想复用 GUI 已配置的 API/模型，直接指过去即可：

```bash
cnkeide -p "..." --data-dir "%APPDATA%/CnkeIDE"
```

`--no-persist` 时数据写入系统临时目录，进程结束即丢弃（同时默认关闭记忆）。

## 架构

```
cli/index.ts                 参数解析 / 事件渲染 / 退出码
electron/headless/bootstrap.ts          组装内核（Config/FS/Terminal/Storage/Checkpoint/RAG/MCP…）
electron/headless/HeadlessWindowAdapter.ts  无窗口的 WindowAdapter 替身（日志走 stderr）
electron/util/paths.ts       数据目录解析（CNKEIDE_HOME > Electron userData > ~/.cnkeide）
scripts/build-cli.mjs        esbuild 打成单文件 CJS，构建后前置 shebang
```

解除对 Electron 的硬依赖共 4 处：`app.getPath('userData')`、`app.getAppPath()`、`process.resourcesPath`、
`BrowserWindow.getAllWindows()`，分别改由 `paths.ts` 的环境探测、`SkillRegistryOptions` 注入与 `WindowAdapter.getMainWindow()` 承担。
