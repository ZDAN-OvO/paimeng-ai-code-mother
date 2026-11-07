'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { CodeView, FileTree } from '@/lib/code';
import { formatTime } from '@/lib/time';
import type { ChatRecord } from '@/shared/api/schemas';

export function CodePanel({
  chat,
  selectedPath,
  onSelectPath,
}: {
  chat: ChatRecord;
  selectedPath: string;
  onSelectPath: (path: string) => void;
}) {
  const active = chat.versions[chat.versions.length - 1];
  const viewed = chat.versions.find((version) => version.id === chat.viewVersionId) ?? active;
  const [copied, setCopied] = useState(false);

  // 生成中先展示正在写入的工作区，版本快照在生成结束后才出现。
  const live = chat.streaming ? chat.liveFiles : undefined;
  const files = useMemo(() => live ?? viewed?.files ?? {}, [live, viewed?.files]);
  const code = files[selectedPath] ?? '';
  const paths = useMemo(() => Object.keys(files).sort(), [files]);

  useEffect(() => {
    if (!files[selectedPath] && paths.length) {
      onSelectPath(paths[0]);
    }
  }, [files, onSelectPath, paths, selectedPath]);

  function copy() {
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      toast.success('已复制文件内容');
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12px] font-medium">代码</span>
        <span className="text-[10.5px] text-muted-foreground">
          {chat.streaming ? '正在写入工作区' : viewed ? `${viewed.label} · 只读` : '暂无文件'}
        </span>
        {viewed && viewed.id !== active?.id ? (
          <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[9.5px] text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
            历史版本
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          {viewed ? <span>{formatTime(viewed.createdAt)}</span> : null}
          <span className="flex items-center gap-1">
            <Lock className="size-2.5" />
            只读
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-44 shrink-0 flex-col border-r border-border bg-muted/30">
          <div className="flex items-center justify-between px-2.5 py-1.5 text-[10px] text-muted-foreground">
            <span>{chat.streaming ? '正在写入' : '工作区'}</span>
            <span>{paths.length} 个文件</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
            <FileTree files={files} selected={selectedPath} onSelect={onSelectPath} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="truncate font-mono text-[11px] text-foreground/90">
              {selectedPath}
            </span>
            {chat.streaming ? (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9.5px] text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                生成中
              </span>
            ) : null}
            <button
              type="button"
              onClick={copy}
              className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="复制文件内容"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>
          {code ? (
            <CodeView code={code} className="min-h-0 flex-1" />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-[12px]">
                {chat.streaming ? '正在写入第一个文件…' : '这个版本没有可查看的文件'}
              </p>
              <p className="max-w-xs text-[11px] leading-5 text-muted-foreground">
                {chat.streaming
                  ? '文件树会在每次 write_file 之后逐个出现，和沙箱里发生的事保持一致。'
                  : '换一个版本试试。'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
