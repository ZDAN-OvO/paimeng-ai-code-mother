'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, FolderClosed, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { CodeView, FileTree } from '@/lib/code';
import type { FileMap } from '@/shared/api/schemas';

/** 项目当前文件（只读）：与预览、改动记录看的是同一份共享文件。 */
export function CodePanel({
  files,
  workspacePath,
  streaming,
  selectedPath,
  onSelectPath,
}: {
  files: FileMap;
  workspacePath: string;
  streaming: boolean;
  selectedPath: string;
  onSelectPath: (path: string) => void;
}) {
  const [copied, setCopied] = useState(false);
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
        <span className="text-[12px] font-medium">当前文件</span>
        <span className="flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
          <FolderClosed className="size-3 shrink-0" />
          <span className="truncate">{workspacePath}</span>
        </span>
        {streaming ? (
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9.5px] text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
            正在写入
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
          <Lock className="size-2.5" />
          只读
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-44 shrink-0 flex-col border-r border-border bg-muted/30">
          <div className="flex items-center justify-between px-2.5 py-1.5 text-[10px] text-muted-foreground">
            <span>项目文件</span>
            <span>{paths.length} 个</span>
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
            <CodeView code={code} filename={selectedPath} className="min-h-0 flex-1" />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-[12px]">
                {streaming ? '正在写入第一个文件…' : '这个项目还没有可查看的文件'}
              </p>
              <p className="max-w-xs text-[11px] leading-5 text-muted-foreground">
                {streaming
                  ? '文件树会在每次写入之后逐个出现，和项目目录里的内容保持一致。'
                  : '在左侧对话里描述你要改什么，助手写入文件后会出现在这里。'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
