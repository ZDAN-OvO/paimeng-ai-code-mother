'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn('min-w-0 space-y-3 break-words text-[13px] leading-6', className)}
      data-testid="assistant-markdown"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          p: ({ children }) => <p>{children}</p>,
          h1: ({ children }) => <h1 className="text-lg font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children, start }) => (
            <ol start={start} className="list-decimal space-y-1 pl-5">
              {children}
            </ol>
          ),
          li: ({ children }) => <li>{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          pre: ({ children }) => (
            <pre className="max-w-full overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs leading-5 whitespace-pre [&>code]:bg-transparent [&>code]:p-0">
              {children}
            </pre>
          ),
          code: ({ children, className: language }) => (
            <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]', language)}>
              {children}
            </code>
          ),
          table: ({ children }) => (
            <div className="max-w-full overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          th: ({ children, style }) => (
            <th style={style} className="border border-border bg-muted/50 px-3 py-1.5 font-medium">
              {children}
            </th>
          ),
          td: ({ children, style }) => (
            <td style={style} className="border border-border px-3 py-1.5">
              {children}
            </td>
          ),
          img: ({ alt }) => (
            <span className="text-muted-foreground">[图片：{alt || '未命名'}]</span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
