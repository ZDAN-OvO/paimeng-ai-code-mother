'use client';

import { useState } from 'react';
import { ChevronDown, FileDiff, FolderOpen, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { collapseUnchanged, diffLines, diffStats } from '@/lib/diff';
import { formatTime } from '@/lib/time';
import type { DiffLine } from '@/lib/diff';
import type { ChangeSet, Project } from '@/shared/api/schemas';

/**
 * 改动记录：每轮对话对项目文件做了什么、diff 与撤销入口。
 * 撤销是否允许由服务端按当前磁盘文件判断，冲突时这里只展示原因，不强行覆盖。
 */
export function ChangeSetsPanel({
  project,
  focusChangeSetId,
  onShowFile,
  onUndo,
}: {
  project: Project;
  focusChangeSetId?: string | null;
  onShowFile: (path: string) => void;
  onUndo: (changeSetId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<string | null>(
    focusChangeSetId ?? project.changeSets.at(-1)?.id ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const changeSets = [...project.changeSets].reverse();
  const applied = project.changeSets.filter((item) => item.status === 'applied');

  async function undo(changeSet: ChangeSet) {
    setError(null);
    setUndoing(changeSet.id);
    try {
      await onUndo(changeSet.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '撤销失败，请重试');
    } finally {
      setUndoing(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FileDiff className="size-3.5 text-muted-foreground/70" />
        <span className="text-[12px] font-medium text-foreground/90">改动记录</span>
        <span className="text-[11px] text-muted-foreground/70">每轮一条，可查看 diff 并撤销</span>
        <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {applied.length} 条生效
        </span>
      </div>

      {error ? (
        <p
          data-testid="undo-error"
          className="border-b border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {changeSets.length === 0 ? (
          <p className="p-6 text-center text-xs leading-5 text-muted-foreground">
            还没有改动。助手第一次写入项目文件后，这里会出现一条可撤销的记录。
          </p>
        ) : null}

        {changeSets.map((changeSet) => {
          const isOpen = expanded === changeSet.id;
          const undone = changeSet.status === 'undone';
          return (
            <div key={changeSet.id} className="border-b border-border/60">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : changeSet.id)}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40',
                  focusChangeSetId === changeSet.id && 'bg-muted/40',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]',
                    undone
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-primary text-primary-foreground',
                  )}
                >
                  #{changeSet.seq}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        'truncate text-[12px] font-medium',
                        undone ? 'text-muted-foreground line-through' : 'text-foreground',
                      )}
                    >
                      {changeSet.summary}
                    </span>
                    {undone ? (
                      <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                        已撤销
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/70">
                    <span>{formatTime(changeSet.createdAt)}</span>
                    <span>·</span>
                    <span>{changeSet.changedFiles.length} 个文件变化</span>
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
                    {!undone ? (
                      <button
                        type="button"
                        data-testid={`undo-${changeSet.seq}`}
                        disabled={undoing === changeSet.id}
                        onClick={() => void undo(changeSet)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        <Undo2 className="size-3" />
                        {undoing === changeSet.id ? '正在撤销…' : '撤销这次改动'}
                      </button>
                    ) : (
                      <span className="self-center text-[10px] text-muted-foreground/70">
                        这次改动已经撤销，文件回到改动前。
                      </span>
                    )}
                    <span className="self-center text-[10px] text-muted-foreground/60">
                      撤销只回退这一轮动过的文件；文件后来又被改过时会拒绝。
                    </span>
                  </div>

                  <div className="space-y-1">
                    {changeSet.changedFiles.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">这一轮没有文件变化。</p>
                    ) : (
                      changeSet.changedFiles.map((path) => (
                        <DiffFileRow
                          key={path}
                          path={path}
                          changeSet={changeSet}
                          onOpen={() => onShowFile(path)}
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
  changeSet,
  onOpen,
}: {
  path: string;
  changeSet: ChangeSet;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const before = changeSet.before[path] ?? '';
  const after = changeSet.after[path] ?? '';
  const lines = diffLines(before, after);
  const stats = diffStats(lines);
  const status = !changeSet.before[path] ? '新增' : !changeSet.after[path] ? '删除' : '修改';

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
          title="在代码面板打开"
          className="shrink-0 rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground/90"
        >
          <FolderOpen className="size-3" />
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

function DiffRow({ line }: { line: DiffLine }) {
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
