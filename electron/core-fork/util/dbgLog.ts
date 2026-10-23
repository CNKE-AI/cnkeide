/**
 * 诊断日志（按需开启）。
 *
 * 默认【关闭】。原因有二：
 * 1. 历史实现把日志路径硬编码成开发者本机的绝对路径
 *    （C:\Users\<开发者>\Downloads\...\agent-debug.log），对其他机器完全无效，
 *    还会把开发者的目录结构带进仓库；
 * 2. 它用的是同步 appendFileSync，而调用点分布在 LLM 流式响应与工具循环的热路径上，
 *    对正常用户只是纯粹的磁盘 I/O 开销。
 *
 * 需要排查「对话没反应 / 工具卡住」时按需开启（改完需重启应用）：
 *   CNKE_DEBUG_LOG=1                 → 写入 <当前工作目录>/agent-debug.log
 *   CNKE_DEBUG_LOG=D:\logs\agent.log → 写入指定文件
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const TARGET = (() => {
  const raw = (process.env.CNKE_DEBUG_LOG || '').trim();
  if (!raw) return null;
  // 常见开关写法：1 / true / yes 都视为「写到默认位置」
  if (raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes') {
    return path.join(process.cwd(), 'agent-debug.log');
  }
  return raw;
})();

/** 是否已开启诊断日志 */
export const DBG_LOG_ENABLED = TARGET !== null;

export function dbgLog(msg: string): void {
  if (!TARGET) return;
  try {
    appendFileSync(TARGET, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* 写日志失败绝不能影响主流程 */
  }
}
