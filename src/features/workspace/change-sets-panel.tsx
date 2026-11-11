'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Loader2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import { collapseUnchanged, diffLines, type DiffLine } from '@/lib/diff';
import { formatTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import type {
  ChangeFile,
  ChangeFileVersion,
  ChangeSet,
  ChangeSetFileResponse,
  ChangesetsResponse,
} from '@/shared/api/schemas';
import {
  changeSetFileResponseSchema,
  changesetsResponseSchema,
  undoChangeFileResponseSchema,
} from '@/shared/api/schemas';

const PAGE_SIZE = 10;

const CHANGE_LABEL: Record<ChangeFile['change'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
};

const SOURCE_LABEL: Record<ChangeFile['source'], string> = {
  tool: '工具',
  bash: 'Bash',
  user_undo: '撤销',
  mixed: '混合',
};

const STATUS_LABEL: Record<ChangeSet['status'], string> = {
  applied: '已应用',
  partially_undone: '部分已撤销',
  undone: '已全部撤销',
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function DiffText({ before, after }: { before: ChangeFileVersion; after: ChangeFileVersion }) {
  const beforeText = before.content ?? '';
  const afterText = after.content ?? '';
  const lines = collapseUnchanged(diffLines(beforeText, afterText), 3);
  const empty =
    (before.content === null || !before.exists) && (after.content === null || !after.exists);

  if (empty) {
    return (
      <p className="rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
        改动前后都没有可显示的内容。
      </p>
    );
  }

  return (
    <div className="max-h-80 overflow-auto rounded-md border border-border bg-muted/20 font-mono text-[11px] leading-5">
      {lines.map((line, index) => {
        if (line.type === 'gap') {
          return (
            <div
              key={index}
              className="border-y border-border/60 bg-muted/40 px-3 py-0.5 text-[10px] text-muted-foreground"
            >
              {line.text}
            </div>
          );
        }
        const diffLine = line as DiffLine;
        return (
          <div
            key={index}
            className={cn(
              'flex min-w-0',
              diffLine.type === 'add' && 'bg-emerald-500/10',
              diffLine.type === 'del' && 'bg-rose-500/10',
            )}
          >
            <span className="w-10 shrink-0 select-none border-r border-border/60 px-1 text-right text-muted-foreground/70">
              {diffLine.oldNo ?? ''}
            </span>
            <span className="w-10 shrink-0 select-none border-r border-border/60 px-1 text-right text-muted-foreground/70">
              {diffLine.newNo ?? ''}
            </span>
            <span className="w-4 shrink-0 select-none text-center text-muted-foreground">
              {diffLine.type === 'add' ? '+' : diffLine.type === 'del' ? '-' : ' '}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-all pr-3">
              {diffLine.text || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FileVersion({ version, label }: { version: ChangeFileVersion; label: string }) {
  if (!version.exists) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
        {label}：文件不存在
      </div>
    );
  }
  if (version.binary) {
    return (
      <div className="rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground">
        {label}：二进制文件，大小 {formatBytes(version.size)}
      </div>
    );
  }
  if (version.content === null) {
    return (
      <div className="rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground">
        {label}：内容过大或无法读取，大小 {formatBytes(version.size)}
      </div>
    );
  }
  return null;
}

function FileRow({
  projectId,
  changeSetId,
  file,
  expanded,
  onToggle,
  onUndo,
  refreshToken,
}: {
  projectId: string;
  changeSetId: string;
  file: ChangeFile;
  expanded: boolean;
  onToggle: () => void;
  onUndo: (path: string) => Promise<void>;
  refreshToken: number;
}) {
  const [detail, setDetail] = useState<ChangeSetFileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!expanded) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const url = `/api/projects/${projectId}/changesets/${changeSetId}/file?path=${encodeURIComponent(file.path)}`;
        const next = await api.get<ChangeSetFileResponse>(url, changeSetFileResponseSchema, {
          signal: controller.signal,
        });
        if (requestRef.current === requestId) setDetail(next);
      } catch (cause) {
        if (controller.signal.aborted || requestRef.current !== requestId) return;
        setError(errorMessage(cause));
        setDetail(null);
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    })();
  }, [expanded, projectId, changeSetId, file.path, refreshToken]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function confirmUndo() {
    if (undoing) return;
    setUndoing(true);
    setUndoError(null);
    try {
      await onUndo(file.path);
      setConfirming(false);
      setDetail(null);
    } catch (cause) {
      setUndoError(errorMessage(cause));
    } finally {
      setUndoing(false);
    }
  }

  const canUndo = file.undoState === 'applied';

  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={expanded ? '收起文件改动' : '查看文件改动'}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 text-left"
          title={expanded ? '收起文件改动' : '查看文件改动'}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-[11px]" title={file.path}>
              {file.path}
            </span>
            <Badge
              variant="outline"
              className={cn(
                'h-4 shrink-0 px-1 text-[9px]',
                file.change === 'added' && 'border-emerald-500/40 text-emerald-600',
                file.change === 'deleted' && 'border-rose-500/40 text-rose-600',
              )}
            >
              {CHANGE_LABEL[file.change]}
            </Badge>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {SOURCE_LABEL[file.source]}
            </span>
            <span
              className={cn(
                'shrink-0 text-[10px]',
                file.attribution === 'uncertain' ? 'text-amber-600' : 'text-muted-foreground/70',
              )}
            >
              {file.attribution === 'uncertain' ? '归属不确定' : '归属明确'}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-emerald-600">+{file.added}</span>
            <span className="shrink-0 font-mono text-[10px] text-rose-600">-{file.removed}</span>
          </div>
          {file.attribution === 'uncertain' ? (
            <span className="mt-0.5 flex items-center gap-1 text-[10px] text-amber-600">
              <AlertTriangle className="size-3" />
              改动来源可能与其他运行重叠
            </span>
          ) : null}
          {undoError ? (
            <span className="mt-1 block break-words text-[10px] text-destructive">{undoError}</span>
          ) : null}
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 px-1.5 text-[10px]"
          disabled={!canUndo || undoing}
          onClick={() => setConfirming((value) => !value)}
          title={canUndo ? '撤销这个文件的改动' : '这个文件已经撤销'}
        >
          <RotateCcw className="size-3" />
          {canUndo ? '撤销此文件' : '已撤销'}
        </Button>
      </div>

      {confirming ? (
        <div className="mx-2 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
          <p className="text-[10px] leading-4 text-amber-800 dark:text-amber-300">
            撤销会把该文件恢复到此轮改动前，即使它之后又被改过；会覆盖当前内容。
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <Button
              size="sm"
              className="h-6 bg-red-600 text-[10px] text-white hover:bg-red-700"
              disabled={undoing}
              onClick={() => void confirmUndo()}
            >
              {undoing ? '撤销中…' : '确认撤销'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10px]"
              disabled={undoing}
              onClick={() => setConfirming(false)}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {expanded ? (
        <div className="px-2 pb-2 pl-7">
          {loading ? (
            <div className="flex items-center gap-1.5 py-2 text-[10px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              正在读取这个文件的改动…
            </div>
          ) : error ? (
            <p className="py-1 text-[10px] text-destructive">{error}</p>
          ) : detail ? (
            detail.file.binary ||
            detail.before.binary ||
            detail.after.binary ||
            (detail.before.exists && detail.before.content === null) ||
            (detail.after.exists && detail.after.content === null) ? (
              <div className="space-y-1">
                <FileVersion version={detail.before} label="改前" />
                <FileVersion version={detail.after} label="改后" />
              </div>
            ) : (
              <DiffText before={detail.before} after={detail.after} />
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ChangeSetsPanel({
  projectId,
  filesVersion,
  onFilesChanged,
}: {
  projectId: string;
  filesVersion: number;
  onFilesChanged: () => void;
}) {
  const [changeSets, setChangeSets] = useState<ChangeSet[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSets, setOpenSets] = useState<Record<string, boolean>>({});
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (cursor) params.set('cursor', cursor);
        const data = await api.get<ChangesetsResponse>(
          `/api/projects/${projectId}/changesets?${params.toString()}`,
          changesetsResponseSchema,
        );
        setChangeSets((current) => (append ? [...current, ...data.changeSets] : data.changeSets));
        if (!append) {
          const first = data.changeSets[0];
          setOpenSets(first ? { [first.id]: true } : {});
        }
        setNextCursor(data.nextCursor);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(null, false);
  }, [load, filesVersion]);

  async function undoFile(changeSetId: string, path: string) {
    const data = await api.post(
      `/api/projects/${projectId}/changesets/${changeSetId}/undo`,
      { path },
      undoChangeFileResponseSchema,
    );
    setChangeSets((current) =>
      current.map((item) => (item.id === data.changeSet.id ? data.changeSet : item)),
    );
    setOpenSets((current) => ({ ...current, [data.changeSet.id]: true }));
    setRefreshToken((value) => value + 1);
    onFilesChanged();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <p className="text-xs font-semibold">改动记录</p>
          <p className="text-[10px] text-muted-foreground">按运行回合分组，可按文件恢复</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="刷新改动"
          disabled={loading}
          onClick={() => void load(null, false)}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在读取改动…
          </div>
        ) : error ? (
          <div className="m-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[11px] text-destructive">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="size-3.5" />
              读取改动失败
            </div>
            <p className="mt-1 break-words">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-[11px]"
              onClick={() => void load(null, false)}
            >
              重试
            </Button>
          </div>
        ) : changeSets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <FileDiff className="size-5 text-muted-foreground/70" />
            <p className="text-xs font-medium">还没有改动</p>
            <p className="text-[11px] leading-5 text-muted-foreground">
              助手写入文件或运行命令后，改动会按回合记录在这里。
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {changeSets.map((changeSet) => {
              const open = openSets[changeSet.id] ?? false;
              return (
                <section key={changeSet.id} className="px-2 py-1.5">
                  <button
                    type="button"
                    className="flex w-full items-start gap-1.5 rounded px-1 py-1 text-left hover:bg-muted/50"
                    onClick={() =>
                      setOpenSets((current) => ({ ...current, [changeSet.id]: !open }))
                    }
                  >
                    <span className="mt-0.5 shrink-0 text-muted-foreground">
                      {open ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-semibold">第 {changeSet.seq} 轮</span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatTime(changeSet.createdAt)}
                        </span>
                        <Badge variant="outline" className="h-4 px-1 text-[9px]">
                          {STATUS_LABEL[changeSet.status]}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {changeSet.files.length} 个文件
                        </span>
                      </span>
                      {changeSet.summary ? (
                        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                          {changeSet.summary}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {open ? (
                    <div className="mt-1 rounded-md border border-border/70">
                      {changeSet.files.map((file) => {
                        const key = `${changeSet.id}:${file.path}`;
                        return (
                          <FileRow
                            key={key}
                            projectId={projectId}
                            changeSetId={changeSet.id}
                            file={file}
                            expanded={expandedFile === key}
                            onToggle={() =>
                              setExpandedFile((current) => (current === key ? null : key))
                            }
                            onUndo={(path) => undoFile(changeSet.id, path)}
                            refreshToken={refreshToken}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {nextCursor ? (
              <div className="p-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-full text-[11px]"
                  disabled={loadingMore}
                  onClick={() => void load(nextCursor, true)}
                >
                  {loadingMore ? '加载中…' : '加载更多改动'}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
