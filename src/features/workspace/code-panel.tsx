'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, FileWarning, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FileTree, CodeView } from '@/lib/code';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import type { FileIndex, FileWindow } from '@/shared/api/schemas';
import { fileWindowSchema } from '@/shared/api/schemas';
import { cn } from '@/lib/utils';

const PAGE_LINES = 400;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function CodePanel({
  projectId,
  fileIndex,
  filesVersion,
}: {
  projectId: string;
  fileIndex: FileIndex;
  filesVersion: number;
}) {
  const [selected, setSelected] = useState('');
  const [file, setFile] = useState<FileWindow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  const loadFile = useCallback(
    async (path: string, offset: number, append: boolean) => {
      if (!path) return;
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      if (!append) {
        setFile(null);
        setSelected(path);
      }
      try {
        const url = `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}&offset=${offset}&limit=${PAGE_LINES}`;
        const next = await api.get<FileWindow>(url, fileWindowSchema, {
          signal: controller.signal,
        });
        if (requestRef.current !== requestId) return;
        setFile((current) => {
          if (!append || !current) return next;
          const separator = current.content.endsWith('\n') || !current.content ? '' : '\n';
          return {
            ...next,
            offset: current.offset,
            content: current.content + separator + next.content,
          };
        });
      } catch (cause) {
        if (controller.signal.aborted || requestRef.current !== requestId) return;
        setError(errorMessage(cause));
        if (!append) setFile(null);
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (!selected) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFile(selected, 1, false);
  }, [selected, filesVersion, loadFile]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <p className="text-xs font-semibold">项目文件</p>
          <p className="text-[10px] text-muted-foreground">
            {fileIndex.paths.length} 个路径
            {fileIndex.truncated ? ` · 仅显示前 ${fileIndex.limit} 个路径` : ''}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="刷新当前文件"
          onClick={() => selected && void loadFile(selected, 1, false)}
          disabled={!selected || loading}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="max-h-[38%] min-h-24 shrink-0 overflow-y-auto border-b border-border p-2">
        {fileIndex.paths.length === 0 ? (
          <p className="px-2 py-3 text-[11px] leading-5 text-muted-foreground">
            这个目录里还没有可显示的文件。
          </p>
        ) : (
          <FileTree
            paths={fileIndex.paths}
            selected={selected}
            onSelect={(path) => setSelected(path)}
          />
        )}
      </div>

      <div className="min-h-0 flex-1">
        {!selected ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <FileWarning className="size-5 text-muted-foreground/70" />
            <p className="text-xs font-medium">选择一个文件查看内容</p>
            <p className="text-[11px] leading-5 text-muted-foreground">
              文件只在点击时读取，不会一次加载整个项目。
            </p>
          </div>
        ) : loading && !file ? (
          <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在读取 {selected}…
          </div>
        ) : error ? (
          <div className="m-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[11px] leading-5 text-destructive">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="size-3.5" />
              读取失败
            </div>
            <p className="mt-1 break-words">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-[11px]"
              onClick={() => void loadFile(selected, 1, false)}
            >
              重试
            </Button>
          </div>
        ) : file ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.path}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {file.binary ? formatBytes(file.size) : `${file.totalLines} 行`}
              </span>
              {loading ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {file.binary ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <FileWarning className="size-5 text-muted-foreground/70" />
                  <p className="text-xs font-medium">二进制文件，大小 {formatBytes(file.size)}</p>
                  <p className="text-[11px] text-muted-foreground">不显示文件内容。</p>
                </div>
              ) : file.content ? (
                <CodeView
                  code={file.content}
                  filename={file.path}
                  startLine={file.offset}
                  className="h-full"
                />
              ) : (
                <p className="px-4 py-3 text-[11px] text-muted-foreground">文件为空。</p>
              )}
            </div>
            {!file.binary && (file.truncated || file.nextOffset !== null) ? (
              <div className="flex items-center gap-2 border-t border-border px-3 py-2">
                <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">
                  已读取前{' '}
                  {file.nextOffset !== null ? file.nextOffset - file.offset : file.totalLines}{' '}
                  行，共 {file.totalLines} 行
                </span>
                {file.nextOffset !== null ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    disabled={loading}
                    onClick={() => void loadFile(file.path, file.nextOffset ?? 0, true)}
                  >
                    {loading ? '读取中…' : '继续读取'}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
