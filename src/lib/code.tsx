'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { ThemedToken } from 'shiki';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileJson2,
  FileText,
  FolderClosed,
  FolderOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Node = { name: string; path: string; file?: boolean; children: Node[] };

export function buildTree(paths: string[]): Node[] {
  const root: Node[] = [];
  for (const path of [...paths].sort()) {
    const segments = path.split('/').filter(Boolean);
    let cursor = root;
    let prefix = '';
    segments.forEach((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isFile = index === segments.length - 1;
      let node = cursor.find((item) => item.name === segment);
      if (!node) {
        node = { name: segment, path: prefix, file: isFile, children: [] };
        cursor.push(node);
      }
      cursor = node.children;
    });
  }
  const sortNodes = (nodes: Node[]) => {
    nodes.sort((a, b) => {
      if (a.file !== b.file) return a.file ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(root);
  return root;
}

function FileIcon({ name, className }: { name: string; className?: string }) {
  const base = 'size-3.5 shrink-0';
  if (name.endsWith('.json') || name.endsWith('.jsonc')) {
    return <FileJson2 className={cn(base, 'text-amber-600', className)} />;
  }
  if (name.endsWith('.css')) {
    return <FileText className={cn(base, 'text-sky-600', className)} />;
  }
  if (name.endsWith('.md')) {
    return <FileText className={cn(base, 'text-muted-foreground', className)} />;
  }
  return <FileCode2 className={cn(base, 'text-violet-600', className)} />;
}

export function FileTree({
  paths,
  selected,
  onSelect,
}: {
  paths: string[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const [closed, setClosed] = useState<Record<string, boolean>>({ app: false });

  const renderNodes = (nodes: Node[], depth: number): ReactNode =>
    nodes.map((node) => {
      if (node.file) {
        return (
          <button
            key={node.path}
            type="button"
            onClick={() => onSelect(node.path)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[13px] transition-colors',
              selected === node.path
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            <FileIcon name={node.name} />
            <span className="truncate">{node.name}</span>
          </button>
        );
      }
      const isClosed = closed[node.path] ?? false;
      return (
        <div key={node.path}>
          <button
            type="button"
            onClick={() => setClosed((current) => ({ ...current, [node.path]: !isClosed }))}
            className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] font-medium text-muted-foreground hover:bg-muted/60"
            style={{ paddingLeft: depth * 12 + 4 }}
          >
            {isClosed ? (
              <ChevronRight className="size-3.5 shrink-0" />
            ) : (
              <ChevronDown className="size-3.5 shrink-0" />
            )}
            {isClosed ? (
              <FolderClosed className="size-3.5 shrink-0 text-muted-foreground/70" />
            ) : (
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground/70" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {isClosed ? null : renderNodes(node.children, depth + 1)}
        </div>
      );
    });

  return <div className="space-y-0.5">{renderNodes(tree, 0)}</div>;
}

export function CodeView({
  code,
  filename = '',
  className,
  startLine = 1,
}: {
  code: string;
  filename?: string;
  className?: string;
  startLine?: number;
}) {
  const visibleCode = code.replace(/\n$/, '');
  const lines = useMemo(() => visibleCode.split('\n'), [visibleCode]);
  const [highlighted, setHighlighted] = useState<{
    code: string;
    filename: string;
    tokens: ThemedToken[][];
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    // 避免大文件高亮占用界面；源码仍可完整查看和复制。
    if (visibleCode.length <= 200000) {
      void import('./syntax')
        .then(async ({ highlightCode, languageForFile }) => {
          const tokens = await highlightCode(visibleCode, languageForFile(filename));
          if (!cancelled) setHighlighted({ code: visibleCode, filename, tokens });
        })
        .catch(() => {
          /* 语法资源加载失败时继续显示纯文本。 */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [visibleCode, filename]);
  const tokens =
    highlighted?.code === visibleCode && highlighted.filename === filename
      ? highlighted.tokens
      : null;
  return (
    <div
      className={cn('overflow-auto bg-card font-mono text-[12.5px] leading-5', className)}
      data-testid="code-view"
      data-highlighted={Boolean(tokens)}
    >
      <div className="flex min-w-max">
        <div
          className="sticky left-0 w-11 shrink-0 select-none border-r border-border/60 bg-muted/50 py-3 text-right"
          aria-hidden="true"
        >
          {lines.map((_, index) => (
            <div key={index} className="pr-2 text-muted-foreground/70">
              {startLine + index}
            </div>
          ))}
        </div>
        <pre className="min-w-0 py-3 pl-3 pr-6 whitespace-pre text-foreground">
          <code>
            {tokens
              ? tokens.map((line, index) => (
                  <span key={index}>
                    {line.map((token, number) => (
                      <span
                        className="code-token"
                        key={number}
                        style={token.htmlStyle as CSSProperties}
                      >
                        {token.content}
                      </span>
                    ))}
                    {index < tokens.length - 1 ? '\n' : ''}
                  </span>
                ))
              : visibleCode}
          </code>
        </pre>
      </div>
    </div>
  );
}
