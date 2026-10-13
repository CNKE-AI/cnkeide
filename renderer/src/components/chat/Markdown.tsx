import React, { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/**
 * 基于 react-markdown 的 Markdown 渲染器
 * 支持 GFM：表格、删除线、任务列表、自动链接、代码高亮等
 */
const Markdown: React.FC<{ content: string }> = memo(({ content }) => {
  if (!content) return null;

  return (
    <div className="text-[13px] leading-relaxed markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          code: CodeBlock,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) window.cnke.shell.openExternal(href);
              }}
              className="text-primary underline underline-offset-2 hover:opacity-80 break-all"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/** 代码块折叠阈值：超过该行数默认折叠，避免长代码块把整条消息撑得极长 */
const CODE_COLLAPSE_LINES = 20;
/** 折叠时显示的最大高度 */
const CODE_COLLAPSED_HEIGHT = 260;

/**
 * 启发式判断一段"代码块"其实并不是代码（文件名/路径/工具名/标识符/短语），
 * 是的话降级为行内 code，而不是占满宽度的灰色大代码框。
 *
 * 为什么需要这个兜底：模型即使被要求"单行内容不要用围栏代码块"，
 * 仍会偶发地把 `apply_diff`、`create_file` 这类工具名包进 ```bash / ```text，
 * 渲染出来就是截图里那种"一个标题栏 + 一片空白"的大灰块，非常难看。
 * 提示词是第一道防线，这里是第二道。
 */
function looksLikeNonCodeLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 只处理单行：多行内容一律视为真代码
  if (t.includes('\n')) return false;

  // Windows / Unix 路径
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
  if (t.startsWith('~/') || t.startsWith('./') || t.startsWith('../') || t.startsWith('/')) return true;
  // 纯文件名 / 扩展名
  if (/^[\w.\- ]+\.[a-zA-Z0-9]{1,5}$/.test(t)) return true;
  // 裸标识符：工具名 / 函数名 / 变量名 / 常量（snake_case、camelCase、SCREAMING_CASE、
  // 以及 file.ts:12 这类定位写法）。这是截图里最主要的退化形态。
  if (/^[A-Za-z_][A-Za-z0-9_]{0,60}(\.[A-Za-z0-9_]{1,10})?(:\d+(:\d+)?)?$/.test(t)) return true;
  // 短中文短语（≤16 字符）没有特殊字符 → 更像说明文字而非代码
  if (/^[\u4e00-\u9fa5()\sA-Za-z0-9·.\-]{1,16}$/.test(t) && !/[{}()\[\];=<>]/.test(t)) return true;
  return false;
}

/** 代码块/行内代码渲染，带语言标签与复制按钮 */
const CodeBlock: React.FC<any> = ({ inline, className, children, ...props }) => {
  const match = /language-(\w+)/.exec(className || '');
  const codeText = String(children ?? '').replace(/\n$/, '');
  const [expanded, setExpanded] = useState(false);

  if (inline) {
    return (
      <code className="bg-secondary/70 rounded-md px-1.5 py-0.5 text-[0.9em] font-mono text-cyan-300">
        {codeText}
      </code>
    );
  }

  // 兜底：单行 + 内容看起来不是代码（路径/文件名/短语）→ 降级为行内 code。
  // 不再要求"无语言标识"：模型常把文件名/工具名写成 ```bash 或 ```text，
  // 若因有 language-xxx 就跳过往返回，会渲染成占满宽度的空灰框（见截图中的
  // create_file / apply_diff 等）。只要带语言标注且内容确实只有一行短文本，
  // 同样按非代码处理。
  if (looksLikeNonCodeLine(codeText)) {
    return (
      <code className="bg-secondary/70 rounded-md px-1.5 py-0.5 text-[0.9em] font-mono text-cyan-300">
        {codeText}
      </code>
    );
  }

  const lineCount = codeText.split('\n').length;
  const collapsible = lineCount > CODE_COLLAPSE_LINES;

  return (
    <div className="group relative code-block-container border border-border rounded-lg overflow-hidden my-2">
      <div className="flex items-center justify-between px-3 py-1.5 bg-secondary/40 border-b border-border">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
          {match ? match[1] : 'code'}
        </span>
        <button
          onClick={() => navigator.clipboard.writeText(codeText)}
          className="text-[10px] text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        >
          复制
        </button>
      </div>
      <div className="relative">
        <pre
          className={`p-3 overflow-x-auto font-mono text-[12.5px] leading-relaxed ${
            collapsible && !expanded ? 'overflow-y-hidden' : ''
          }`}
          style={collapsible && !expanded ? { maxHeight: CODE_COLLAPSED_HEIGHT } : undefined}
        >
          <code className={className}>{codeText}</code>
        </pre>
        {collapsible && !expanded && (
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#0d1117] to-transparent pointer-events-none" />
        )}
      </div>
      {collapsible && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full py-1.5 text-[11px] text-muted-foreground hover:text-foreground bg-secondary/30 hover:bg-secondary/50 border-t border-border transition-colors"
        >
          {expanded ? '收起' : `展开全部（${lineCount} 行）`}
        </button>
      )}
    </div>
  );
};

export default Markdown;
