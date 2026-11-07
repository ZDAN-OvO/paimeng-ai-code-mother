'use client';

import { useState } from 'react';
import { ChevronDown, CornerUpLeft, Eye, FileDiff, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { collapseUnchanged, diffLines, diffStats } from '@/lib/diff';
import { formatTime } from '@/lib/time';
import type { DiffLine } from '@/lib/diff';
import type { ChatRecord, Version } from '@/shared/api/schemas';

export function VersionsPanel({
  chat,
  onViewVersion,
  onRollback,
  onShowDiffFile,
}: {
  chat: ChatRecord;
  onViewVersion: (versionId: string) => void;
  onRollback: (versionId: string) => void;
  onShowDiffFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(chat.activeVersionId);
  const versions = [...chat.versions].reverse();
  const active = chat.versions[chat.versions.length - 1];
  const viewing = chat.viewVersionId;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FileDiff className="size-3.5 text-muted-foreground/70" />
        <span className="text-[12px] font-medium text-foreground/90">版本</span>
        <span className="text-[11px] text-muted-foreground/70">每条助手消息一个版本</span>
        <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {chat.versions.length} 个
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {versions.length === 0 ? (
          <p className="p-6 text-center text-xs leading-5 text-muted-foreground">
            还没有版本。第一轮生成结束后，这里会出现一条源码树快照。
          </p>
        ) : null}

        {versions.map((version, index) => {
          const previous = versions[index + 1];
          const isLatest = version.id === active?.id;
          const isViewing = version.id === viewing;
          const isOpen = expanded === version.id;
          return (
            <div key={version.id} className="border-b border-border/60">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : version.id)}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40',
                  isViewing && 'bg-muted/40',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]',
                    isLatest
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  v{version.seq}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-foreground">
                      {version.restoredFrom
                        ? `回滚到 v${version.restoredFrom}`
                        : version.seq === 1
                          ? '首次生成'
                          : '对话修改'}
                    </span>
                    {isLatest ? (
                      <span className="rounded bg-emerald-50 px-1 py-0.5 text-[9px] text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                        当前
                      </span>
                    ) : null}
                    {isViewing && !isLatest ? (
                      <span className="rounded bg-sky-50 px-1 py-0.5 text-[9px] text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
                        预览中
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
                    {version.summary}
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/70">
                    <span>{formatTime(version.createdAt)}</span>
                    <span>·</span>
                    <span>{version.changedFiles.length} 个文件变化</span>
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    'mt-1 size-3.5 shrink-0 text-muted-foreground/40 transition-transform',
                    isOpen && 'rotate-180',
                  )}
                />
              </button>

              {isOpen ? (
                <div className="space-y-2 bg-muted/30 px-3 pt-1 pb-3">
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`view-${version.seq}`}
                      className="h-7 gap-1 text-[11px]"
                      onClick={() => onViewVersion(version.id)}
                    >
                      <Eye className="size-3" />
                      在预览中查看
                    </Button>
                    {!isLatest ? (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`rollback-${version.seq}`}
                        className="h-7 gap-1 text-[11px]"
                        onClick={() => {
                          onRollback(version.id);
                          toast.success(`已回滚到 v${version.seq}`, {
                            description: '工作区换成旧源码树，并追加了一个新版本。',
                          });
                        }}
                      >
                        <Undo2 className="size-3" />
                        回滚到此版本
                      </Button>
                    ) : (
                      <span className="inline-flex items-center gap-1 self-center text-[10px] text-muted-foreground/70">
                        <CornerUpLeft className="size-3" />
                        这是当前工作区
                      </span>
                    )}
                  </div>

                  <div className="space-y-1">
                    {version.changedFiles.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">这一版没有文件变化。</p>
                    ) : (
                      version.changedFiles.map((path) => (
                        <DiffFileRow
                          key={path}
                          path={path}
                          version={version}
                          previous={previous}
                          onOpen={() => onShowDiffFile(path)}
                        />
                      ))
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffFileRow({
  path,
  version,
  previous,
  onOpen,
}: {
  path: string;
  version: Version;
  previous?: Version;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const before = previous?.files[path] ?? '';
  const after = version.files[path] ?? '';
  const lines = diffLines(before, after);
  const stats = diffStats(lines);
  const status = !previous?.files[path] ? '新增' : !version.files[path] ? '删除' : '修改';

  return (
    <div className="overflow-hidden rounded border border-border bg-card">
      <div
        role="button"
        tabIndex={0}
        data-testid={`diff-${path}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/40"
      >
        <span
          className={cn(
            'rounded px-1 py-0.5 text-[9px]',
            status === '新增'
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
              : status === '删除'
                ? 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                : 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
          )}
        >
          {status}
        </span>
        <span className="truncate font-mono text-[11px] text-foreground/90">{path}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px]">
          <span className="text-emerald-600">+{stats.added}</span>{' '}
          <span className="text-red-500">-{stats.removed}</span>
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="shrink-0 rounded px-1 text-[10px] text-muted-foreground/70 hover:bg-muted hover:text-foreground/90"
        >
          在代码面板打开
        </button>
      </div>
      {open ? (
        <div className="max-h-64 overflow-auto border-t border-border/60 font-mono text-[11px] leading-5">
          {collapseUnchanged(lines, 2).map((line, index) =>
            line.type === 'gap' ? (
              <div
                key={index}
                className="bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground/70"
              >
                {line.text}
              </div>
            ) : (
              <DiffRow key={index} line={line} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        'flex gap-2 px-2 whitespace-pre',
        line.type === 'add' && 'bg-emerald-50/70 dark:bg-emerald-950/30',
        line.type === 'del' && 'bg-red-50/70 dark:bg-red-950/30',
      )}
    >
      <span className="w-7 shrink-0 select-none text-right text-muted-foreground/40">
        {line.oldNo ?? ''}
      </span>
      <span className="w-7 shrink-0 select-none text-right text-muted-foreground/40">
        {line.newNo ?? ''}
      </span>
      <span
        className={cn(
          'w-3 shrink-0 select-none',
          line.type === 'add'
            ? 'text-emerald-700 dark:text-emerald-400'
            : line.type === 'del'
              ? 'text-red-600 dark:text-red-400'
              : 'text-muted-foreground/40',
        )}
      >
        {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
      </span>
      <span className="whitespace-pre text-foreground/90">{line.text || ' '}</span>
    </div>
  );
}
