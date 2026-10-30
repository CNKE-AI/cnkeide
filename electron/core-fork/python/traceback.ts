/**
 * Python traceback 结构化解析。
 *
 * 目的：脚本失败时，模型需要完整 stderr 才能定位问题，但前端只需要
 * 「哪个文件、第几行、什么异常」就能做跳转。把这两类需求分开：
 * 完整文本原样回给模型，结构化结果只给 UI（AgentManager 会剥离）。
 *
 * 只认 CPython 的标准格式，不做方言猜测——猜错的行号比没有更糟。
 */

export interface PythonTracebackMeta {
  kind: 'python-traceback';
  /** 出错文件（traceback 最后一帧） */
  file?: string;
  /** 出错行号 */
  line?: number;
  /** 异常类型，如 ValueError / SyntaxError */
  type?: string;
  /** 异常消息（不含类型前缀） */
  message?: string;
}

/**
 * 从 stderr 中提取最后一个 traceback 帧与末行异常。
 * 非 Python 报错（如命令不存在）返回 undefined。
 */
export function parsePythonTraceback(stderr: string): PythonTracebackMeta | undefined {
  const text = (stderr || '').trim();
  if (!text) return undefined;

  const lines = text.split('\n');
  const lastLine = (lines[lines.length - 1] || '').trim();

  // 典型末行：ValueError: invalid literal / SyntaxError: invalid syntax
  // 也兼容不带消息的裸异常名：KeyboardInterrupt / SystemExit
  const m = /^([A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Iteration))(?::\s*([\s\S]*))?$/.exec(
    lastLine,
  );

  let file: string | undefined;
  let line: number | undefined;
  // 从后往前找最后一个 File "...", line N（即真正出错的那一帧）
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const f = /File "(.+?)", line (\d+)/.exec(lines[i]);
    if (f) {
      file = f[1];
      line = Number(f[2]);
      break;
    }
  }

  if (!m && file === undefined) return undefined;
  return { kind: 'python-traceback', file, line, type: m?.[1], message: m?.[2] };
}
