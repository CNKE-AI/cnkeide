# CnkeIDE 剩余 UI 功能补齐 - 完成报告

对照 `docs/cnkeide-vs-codebuddy-gap.md`，剩余未补齐的 UI 功能已全部实现。

## 实现清单

| # | 功能 | 实现方式 |
|---|------|---------|
| 1 | preload 桥接补全 | `electron/preload.ts` 新增 context / checkpoint / approval / sessionEx / plan 五组 API；`global.d.ts` 补类型 |
| 2 | 上下文占用进度条 | `ContextBar.tsx` 订阅 `context_state` 事件，顶部实时显示 token 占用比例（safe/warning/critical 三色） |
| 3 | Plan 面板 | `PlanPanel.tsx` 可视化任务计划步骤（pending/running/completed/failed/skipped 状态机 + 进度条） |
| 4 | 多模型快速切换下拉 | `ModelSwitcher.tsx` 对话头部下拉，切换 activeApiConfigId |
| 5 | 会话导出/导入/压缩 | `SessionToolbar.tsx` + 新增 IPC `session:export/import/summarize` |
| 6 | 单步回滚任意消息 | 消息气泡「回滚到此」按钮 + IPC `session:deleteMessage` |
| 7 | Ask 选区（选中代码发对话） | `EditorPanel.tsx` 选区监听 + 「发送选区」按钮 → 注入对话输入框 |
| 8 | Checkpoint 快照查看/恢复 | `CheckpointPanel.tsx` 快照列表 + 差异对比 + 恢复 |
| 9 | 工具审批信任规则管理 | `ApprovalRulesPanel.tsx` allow/deny/ask 规则 CRUD |

## 关键内核接线

1. `electron/ipc/handlers.ts`：给 `agentManager` 注入 `planManager`（此前未注入，plan 功能从未启用）；新增 6 个 IPC 端点（session:export/import/summarize/deleteMessage + plan:get）；PlanManager 事件转发到前端
2. `electron/core-fork/agent/AgentManager.ts`：新增 `summarizeContext()` 方法（LLM 摘要压缩早期历史）
3. `renderer/src/store/uiStore.ts`：新增 UI 状态中枢（上下文占用 / 计划 / 模型列表 / 待注入提示）
4. `renderer/src/store/AppProvider.tsx`：全局 `agent:event` 监听，把 `context_state` / `plan` 事件转发给 uiStore

## 验证

- `npx tsc --noEmit -p tsconfig.json` ✅ 通过
- `npx tsc -p electron/tsconfig.json` ✅ 通过（主进程 + preload）
- `npx vite build` ✅ 通过（2023 模块，渲染层产物已生成）
- 所有新增/修改文件 `read_lints` ✅ 0 错误
