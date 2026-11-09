'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  ChevronRight,
  ExternalLink,
  KeyRound,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Rocket,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, ApiRequestError } from '@/lib/api/client';
import { formatTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { ChatSummary, ProjectsResponse } from '@/shared/api/schemas';

type ProjectRow = ProjectsResponse['projects'][number];
const RECENT_LIMIT = 5;

/** 项目概览：部署现状 + 最近对话 + 项目级操作，不换路由。 */
export function ProjectOverviewPanel({
  projectId,
  onOpenChat,
  onOpenChatList,
  onRename,
  onOpenSettings,
  onNewChat,
}: {
  projectId: string;
  onOpenChat: (chatId: string) => void;
  onOpenChatList: () => void;
  onRename: (name: string) => void;
  onOpenSettings: (chatId: string) => void;
  onNewChat: () => void;
}) {
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    try {
      const [projects, chatList] = await Promise.all([
        api.get<ProjectsResponse>('/api/projects'),
        api.get<{ chats: ChatSummary[] }>(`/api/projects/${projectId}/chats`),
      ]);
      const found = projects.projects.find((item) => item.id === projectId) ?? null;
      setProject(found);
      setName(found?.name ?? '');
      setChats(chatList.chats);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : '项目加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // 项目切换或归档后重新拉一次。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function commit() {
    const next = name.trim();
    if (next && project && next !== project.name) onRename(next);
    setRenaming(false);
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        正在读取项目…
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-red-600">
        {error ?? '找不到这个项目'}
      </div>
    );
  }

  const deploy = [...project.deploys].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-muted/30">
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
          <span className="text-[12px] text-muted-foreground">项目</span>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
          {renaming ? (
            <input
              autoFocus
              value={name}
              data-testid="project-rename-input"
              onChange={(event) => setName(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit();
                if (event.key === 'Escape') {
                  setName(project.name);
                  setRenaming(false);
                }
              }}
              className="w-56 rounded border border-border px-2 py-1 text-[15px] font-semibold outline-none focus:border-foreground/40"
            />
          ) : (
            <h1 className="text-[15px] font-semibold tracking-tight">{project.name}</h1>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11.5px]"
              onClick={onNewChat}
            >
              <Plus className="size-3.5" />
              新对话
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                data-testid="project-menu"
                className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                title="项目操作"
              >
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-[10.5px] text-muted-foreground">
                  这个项目
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2 text-[12.5px]" onClick={() => setRenaming(true)}>
                  <Pencil className="size-3.5" />
                  重命名项目
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2 text-[12.5px]"
                  disabled={chats.length === 0}
                  onClick={() => {
                    const latest = chats[0];
                    if (latest) onOpenSettings(latest.id);
                  }}
                >
                  <KeyRound className="size-3.5" />
                  环境变量
                </DropdownMenuItem>
                {project.deployKey ? (
                  <DropdownMenuItem className="gap-2 text-[12.5px]" asChild>
                    <a href={`/deploys/${project.deployKey}`} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-3.5" />
                      打开已发布地址
                    </a>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem className="gap-2 text-[12.5px]" disabled>
                    <ExternalLink className="size-3.5" />
                    还没有发布地址
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-5">
        <section>
          <h2 className="text-[12.5px] font-medium">部署</h2>
          {deploy ? (
            <div
              data-testid="deploy-card"
              className="mt-2 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    deploy.state === 'ready'
                      ? 'bg-emerald-500'
                      : deploy.state === 'building'
                        ? 'bg-amber-500'
                        : 'bg-red-500',
                  )}
                />
                <span className="text-[13px] font-medium">
                  {deploy.state === 'ready'
                    ? '已上线'
                    : deploy.state === 'building'
                      ? '构建中'
                      : '构建失败'}
                </span>
                <span className="rounded border border-border px-1.5 py-px font-mono text-[11px] text-muted-foreground">
                  {deploy.deployKey}
                </span>
                <span className="text-[11.5px] text-muted-foreground">
                  v{deploy.versionSeq} · {formatTime(deploy.createdAt)}
                </span>
                {project.deployKey ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 gap-1 px-2 text-[11.5px]"
                    asChild
                  >
                    <a href={`/deploys/${project.deployKey}`} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-3" />
                      打开地址
                    </a>
                  </Button>
                ) : null}
              </div>
              <p className="mt-2 text-[11.5px] leading-5 text-muted-foreground">
                地址按项目固定：回滚产生新版本后重新发布，同一个地址会切到新版本。
              </p>
            </div>
          ) : (
            <div
              data-testid="deploy-card-empty"
              className="mt-2 rounded-xl border border-dashed border-border bg-card/60 px-4 py-6 text-center"
            >
              <p className="text-[12.5px] font-medium">还没有发布过</p>
              <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
                进任意一条对话点右上「发布」，这里会显示地址、版本与状态。
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 h-7 gap-1 px-2 text-[11.5px]"
                disabled={chats.length === 0}
                onClick={() => {
                  const latest = chats[0];
                  if (latest) onOpenChat(latest.id);
                }}
              >
                <Rocket className="size-3" />
                去对话里发布
              </Button>
            </div>
          )}
        </section>

        <section>
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12.5px] font-medium">最近对话</h2>
            <span className="text-[10.5px] text-muted-foreground">{project.chatCount} 条</span>
            <button
              type="button"
              data-testid="view-all-chats"
              onClick={onOpenChatList}
              className="ml-auto flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              查看全部
              <ChevronRight className="size-3" />
            </button>
          </div>
          {chats.length === 0 ? (
            <p className="mt-2 rounded-lg border border-dashed border-border px-4 py-5 text-center text-[11.5px] text-muted-foreground">
              这个项目还没有对话；点「新对话」或在侧栏「新建对话」开始。
            </p>
          ) : (
            <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
              {chats.slice(0, RECENT_LIMIT).map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  data-testid={`overview-chat-${chat.id}`}
                  onClick={() => onOpenChat(chat.id)}
                  className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-[12px] text-muted-foreground last:border-b-0 hover:bg-muted/60 hover:text-foreground"
                >
                  <MessageSquare className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                  {chat.streaming ? (
                    <span className="text-[10px] text-amber-700 dark:text-amber-400">生成中</span>
                  ) : null}
                  <span className="shrink-0 text-[10.5px] text-muted-foreground/80">
                    {formatTime(chat.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {chats.length > RECENT_LIMIT ? (
            <p className="mt-1.5 text-[10.5px] text-muted-foreground">
              还有 {chats.length - RECENT_LIMIT} 条，点「查看全部」。
            </p>
          ) : null}
        </section>

        <section className="rounded-lg border border-dashed border-border px-4 py-3 text-[11px] leading-5 text-muted-foreground">
          <Archive className="mr-1 inline size-3 align-[-2px]" />
          归档的对话不会出现在这里；在「对话 → 归档」里可以找回。
        </section>
      </div>
    </div>
  );
}
