/**
 * 工具执行进度：把命令输出里的约定标记解析成结构化进度。
 *
 * 为什么需要：全盘扫描 / 批量清理这类任务动辄跑几分钟，期间界面只有一圈
 * 转圈的 spinner，用户很容易误判成「卡死 / 白屏」。让模型在脚本里输出
 * `PROGRESS n/m`、`PROGRESS 45%` 这样的行，就能给出确定性进度。
 *
 * 刻意只认显式约定，不去猜测输出里的百分比：猜错画出来的进度条比没有更糟。
 */
export interface ToolProgress {
  current?: number;
  total?: number;
  /** 0-100，便于前端直接画进度条 */
  percent?: number;
}

/**
 * 从输出片段中取出**最后一次**出现的进度标记（即最新进度）。
 * 传入的一般是输出尾部的一小段窗口，而不是全量输出。
 */
export function parseProgress(text: string): ToolProgress | null {
  if (!text) return null;

  // 形如 PROGRESS 12/34
  const ratio = /PROGRESS\s+(\d+)\s*\/\s*(\d+)/gi;
  let lastRatio: RegExpExecArray | null = null;
  for (let m = ratio.exec(text); m; m = ratio.exec(text)) lastRatio = m;
  if (lastRatio) {
    const current = Number(lastRatio[1]);
    const total = Number(lastRatio[2]);
    // total 为 0 时无法计算百分比，直接忽略，避免除零得到 Infinity
    if (total > 0 && current >= 0) {
      return {
        current,
        total,
        percent: Math.min(100, Math.max(0, Math.round((current / total) * 100))),
      };
    }
  }

  // 形如 PROGRESS 45%
  const pctRe = /PROGRESS\s+(\d{1,3})\s*%/gi;
  let lastPct: RegExpExecArray | null = null;
  for (let m = pctRe.exec(text); m; m = pctRe.exec(text)) lastPct = m;
  if (lastPct) {
    const pct = Math.min(100, Math.max(0, Number(lastPct[1])));
    return { current: pct, total: 100, percent: pct };
  }

  return null;
}
