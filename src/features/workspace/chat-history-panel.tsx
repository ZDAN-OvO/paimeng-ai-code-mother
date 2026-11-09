'use client';

import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, ChevronRight, Loader2, MessageSquare, Radio } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api/client';
import { formatTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { ChatSummary, ProjectsResponse } from '@/shared/api/schemas';

type Group = {
  projectId: string;
  name: string;
  chats: ChatSummary[];
};

/** 「对话」入口：不跳页，直接把全部会话按项目列在这里。 */
export function ChatHistoryPanel({
  currentChatId,
  archived,
  projectFilter,
  onOpenChat,
  onRestore,
  onClearFilter,
}: {
  currentChatId: string;
  archived: ChatSummary[];
  projectFilter?: { id: string; name: string } | null;
  onOpenChat: (chatId: string) => void;
  onRestore: (chatId: string) => void;
  onClearFilter?: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { projects } = await api.get<ProjectsResponse>('/api/projects');
        const lists = await Promise.all(
          projects.map((project) =>
            api
              .get<{ chats: ChatSummary[] }>(`/api/projects/${project.id}/chats`)
              .then((data) => ({ projectId: project.id, name: project.name, chats: data.chats })),
          ),
        );
        if (cancelled) return;
        setGroups(lists.filter((group) => group.chats.length > 0));
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof ApiRequestError ? cause.message : '会话列表加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = projectFilter
    ? groups.filter((group) => group.projectId === projectFilter.id)
    : groups;
  const total = visible.reduce((sum, group) => sum + group.chats.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30">
      <div className="flex items-start gap-3 border-b border-border bg-card px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-[13.5px] font-semibold tracking-tight">
              {showArchived ? '归档' : projectFilter ? `${projectFilter.name} 的对话` : '全部对话'}
            </h2>
            {projectFilter && !showArchived && onClearFilter ? (
              <button
                type="button"
                onClick={onClearFilter}
                className="text-[10.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                看全部项目
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {loading
              ? '正在读取会话…'
              : showArchived
                ? `${archived.length} 条归档会话；归档不是删除，恢复后回到原来的位置。`
                : `${total} 个会话，按项目分组；点一条进去继续改。`}
          </p>
        </div>
        <button
          type="button"
          data-testid="toggle-archived"
          onClick={() => setShowArchived((value) => !value)}
          className={cn(
            'ml-auto flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
            showArchived
              ? 'border-foreground bg-foreground text-background'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {showArchived ? <ChevronRight className="size-3" /> : <Archive className="size-3" />}
          {showArchived ? '回到列表' : `归档 ${archived.length}`}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在读取会话…
          </p>
        ) : error ? (
          <p className="text-[12px] text-red-600">{error}</p>
        ) : showArchived ? (
          <div className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-border bg-card">
            {archived.length === 0 ? (
              <p className="px-4 py-6 text-center text-[11.5px] text-muted-foreground">
                还没有归档会话。把不想留在列表里的会话归档后，会出现在这里。
              </p>
            ) : (
              archived.map((chat) => (
                <div
                  key={chat.id}
                  data-testid={`archived-${chat.id}`}
                  className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-[12px] text-muted-foreground last:border-b-0"
                >
                  <MessageSquare className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground/80">
                    {chat.archivedAt ? `归档于 ${formatTime(chat.archivedAt)}` : ''}
                  </span>
                  <button
                    type="button"
                    data-testid={`restore-${chat.id}`}
                    onClick={() => onRestore(chat.id)}
                    className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] hover:bg-muted hover:text-foreground"
                  >
                    <ArchiveRestore className="size-3" />
                    恢复
                  </button>
                </div>
              ))
            )}
          </div>
        ) : total === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {projectFilter ? '这个项目还没有会话。' : '还没有会话，先在首页描述你要做什么。'}
          </p>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5">
            {visible.map((group) => (
              <section key={group.projectId}>
                <div className="flex items-baseline gap-2 px-1">
                  <h3 className="text-[11.5px] font-medium text-foreground">{group.name}</h3>
                  <span className="text-[10.5px] text-muted-foreground">
                    {group.chats.length} 个会话
                  </span>
                </div>
                <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-card">
                  {group.chats
                    .slice()
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map((chat) => (
                      <button
                        key={chat.id}
                        type="button"
                        data-testid={`history-${chat.id}`}
                        onClick={() => onOpenChat(chat.id)}
                        className={cn(
                          'flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left last:border-b-0',
                          chat.id === currentChatId
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                        )}
                      >
                        <MessageSquare className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-[12px]">{chat.title}</span>
                        {chat.streaming ? (
                          <span className="flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400">
                            <Radio className="size-3" />
                            生成中
                          </span>
                        ) : null}
                        {chat.pendingPlan ? (
                          <span className="rounded bg-sky-50 px-1 py-0.5 text-[10px] text-sky-800 dark:bg-sky-950/50 dark:text-sky-300">
                            待审批
                          </span>
                        ) : null}
                        <span className="shrink-0 text-[10.5px] text-muted-foreground/80">
                          {formatTime(chat.updatedAt)}
                        </span>
                      </button>
                    ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
