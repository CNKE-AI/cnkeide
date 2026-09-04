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
