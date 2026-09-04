/**
 * prompt 引用解析：把输入框中的 `@路径` 和 `#codebase 查询` 标记
 * 在发送前解析为实际内容注入 prompt（纯前端，复用 fs IPC，不动内核）。
 */

/** 单文件注入文本上限（防止超长文件打爆上下文） */
const MAX_INJECT_CHARS = 50_000;
/** #codebase 命中片段注入上限 */
const MAX_CODEBASE_HITS = 8;
/** 每个命中片段截断长度 */
const MAX_HIT_SNIPPET = 400;

/** 从 prompt 中提取 @文件/@文件夹 引用（形如 `@路径`，路径可含空格但以空白/换行结尾） */
export function extractFileRefs(prompt: string): string[] {
  const refs: string[] = [];
  // 匹配 @ 开头的路径：允许 Windows 盘符、正反斜杠、点、连字符、中文、空格（非换行）
  const re = /@([^\s\n"“”'‘’]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const candidate = m[1].replace(/[，。；：,;:]+$/, '');
    if (candidate && candidate.length > 1) refs.push(candidate);
  }
  return refs;
}

/** 判断字符串是否看起来像路径（含分隔符或扩展名） */
export function looksLikePath(s: string): boolean {
  return /[\\/]|\./.test(s) && !/^https?:\/\//i.test(s);
}

/** 读取文件内容并截断，失败返回 null */
async function readFileSnippet(filePath: string): Promise<string | null> {
  const res = await window.cnke.fs.readFile(filePath);
  if (!res.success || res.content == null) return null;
  let c = res.content;
  if (c.length > MAX_INJECT_CHARS) c = c.slice(0, MAX_INJECT_CHARS) + '\n…（内容过长已截断）';
  return c;
}

/** 判断文件是否为文本（按扩展名粗略判断，避免读二进制） */
function isTextExt(name: string): boolean {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const binary = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'pdf', 'zip', 'gz',
    'tar', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'bin', 'woff', 'woff2', 'ttf',
    'otf', 'eot', 'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flac', 'wav', 'wasm', 'class',
    'jar', 'war', 'pyc', 'o', 'a', 'lib', 'obj', 'db', 'sqlite', 'sqlite3', 'lock',
  ]);
  return !binary.has(ext);
}

/**
 * 把 prompt 中的 @引用 替换为注入内容。
 * 返回 { prompt, injected }：prompt 为注入后的文本，injected 为已注入的引用列表（用于 UI 提示）。
 */
export async function buildPromptWithRefs(
  prompt: string,
  workspacePath: string | null,
): Promise<{ prompt: string; injected: { path: string; kind: 'file' | 'dir'; ok: boolean }[] }> {
  const refs = extractFileRefs(prompt);
  const injected: { path: string; kind: 'file' | 'dir'; ok: boolean }[] = [];
  let out = prompt;

  for (const ref of refs) {
    // 跳过非路径（如 @某某 提到人名）
    if (!looksLikePath(ref)) continue;
    // 归一化路径：相对路径拼接工作区
    const isAbs = /^[a-zA-Z]:[\\/]|^[\\/]/.test(ref);
    const fullPath = isAbs ? ref : (workspacePath ? window.cnke.path.join(workspacePath, ref) : ref);

    const exists = await window.cnke.fs.exists(fullPath);
    if (!exists) {
      // 路径不存在：保持原样（用户可能只是打字提到）
      continue;
    }

    // 判断文件还是目录
    const listRes = await window.cnke.fs.listDir(fullPath);
    if (listRes.success) {
      // 是目录：注入目录清单
      const entries = listRes.entries || [];
      const lines = entries
        .slice(0, 200)
        .map((e: any) => `${e.isDirectory ? '[目录]' : '[文件]'} ${e.name}${e.isFile ? ` (${e.size}B)` : ''}`)
        .join('\n');
      const block = `【目录 ${ref}】\n${lines || '（空目录）'}`;
      out = out.replace(`@${ref}`, block);
      injected.push({ path: ref, kind: 'dir', ok: true });
      continue;
    }

    // 是文件：读取内容注入
    if (!isTextExt(ref)) {
      // 二进制文件：仅注入路径提示
      out = out.replace(`@${ref}`, `【文件 ${ref}】（二进制文件，AI 无法直接读取文本内容）`);
      injected.push({ path: ref, kind: 'file', ok: false });
      continue;
    }
    const content = await readFileSnippet(fullPath);
    if (content == null) {
      out = out.replace(`@${ref}`, `【文件 ${ref}】（读取失败）`);
      injected.push({ path: ref, kind: 'file', ok: false });
      continue;
    }
    out = out.replace(`@${ref}`, `【文件 ${ref}】\n\`\`\`\n${content}\n\`\`\``);
    injected.push({ path: ref, kind: 'file', ok: true });
  }

  return { prompt: out, injected };
}

/**
 * 处理 #codebase 查询：在工作区做关键词检索，把命中片段注入 prompt。
 * 形如 `#codebase 关键词`。
 */
export async function resolveCodebaseQuery(
  prompt: string,
  workspacePath: string | null,
): Promise<{ prompt: string; query: string | null; hits: number }> {
  const re = /#codebase\s+([^\n]+)/i;
  const m = prompt.match(re);
  if (!m) return { prompt, query: null, hits: 0 };
  const query = m[1].trim();
  if (!query || !workspacePath) return { prompt, query: null, hits: 0 };

  const res = await window.cnke.fs.searchFiles(workspacePath, query);
  if (!res.success || !res.results || res.results.length === 0) {
    return {
      prompt: prompt.replace(re, `【代码库检索「${query}」：未找到匹配结果】`),
      query,
      hits: 0,
    };
  }

  // 取前 N 个命中，读取命中行上下文
  const hits = res.results.slice(0, MAX_CODEBASE_HITS);
  const blocks: string[] = [];
  for (const h of hits) {
    const content = await readFileSnippet(h.path);
    if (content == null) continue;
    const lines = content.split('\n');
    const lineIdx = Math.max(0, (h.line || 1) - 1);
    const ctx = lines.slice(lineIdx, lineIdx + 6).join('\n');
    const snippet = ctx.length > MAX_HIT_SNIPPET ? ctx.slice(0, MAX_HIT_SNIPPET) + '…' : ctx;
    blocks.push(`【${h.relativePath || h.path}:${h.line}】\n\`\`\`\n${snippet}\n\`\`\``);
  }

  if (blocks.length === 0) {
    return { prompt: prompt.replace(re, `【代码库检索「${query}」：无可用结果】`), query, hits: 0 };
  }

  const injected = `【代码库检索「${query}」命中 ${blocks.length} 处】\n${blocks.join('\n')}`;
  return { prompt: prompt.replace(re, injected), query, hits: blocks.length };
}

/** 综合入口：先解析 @引用，再解析 #codebase */
export async function resolveAllRefs(
  prompt: string,
  workspacePath: string | null,
): Promise<{ prompt: string; injectedRefs: { path: string; kind: 'file' | 'dir'; ok: boolean }[]; codebaseHits: number }> {
  const r1 = await buildPromptWithRefs(prompt, workspacePath);
  const r2 = await resolveCodebaseQuery(r1.prompt, workspacePath);
  return { prompt: r2.prompt, injectedRefs: r1.injected, codebaseHits: r2.hits };
}
