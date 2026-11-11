'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronRight,
  FolderClosed,
  KeyRound,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
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
import type { ChatSummary, ProjectsResponse } from '@/shared/api/schemas';

type ProjectRow = ProjectsResponse['projects'][number];
const RECENT_LIMIT = 5;

/** 项目概览：目录、最近改动与对话、项目级操作，不换路由。 */
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
          {project.workspaceState === 'sample' ? (
            <span className="rounded border border-amber-300 bg-amber-50 px-1 py-px text-[9.5px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              示例项目
            </span>
          ) : null}
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
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-5">
        <section>
          <h2 className="text-[12.5px] font-medium">项目目录</h2>
          <div
            data-testid="project-workspace-card"
            className="mt-2 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-center gap-2">
              <FolderClosed className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                {project.workspacePath}
              </span>
            </div>
            <p className="mt-2 text-[11.5px] leading-5 text-muted-foreground">
              {project.workspaceState === 'sample'
                ? '示例项目：路径只做记录，尚未连接真实目录。连接后助手会直接读写这个目录。'
                : '助手读写这个目录里的项目文件；外部编辑器的改动会在下次读取时体现。'}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border/70 pt-2 text-[11px] text-muted-foreground">
              <span>{project.chatCount} 个对话</span>
              <span>·</span>
              <span>{project.changeCount} 条改动记录</span>
              <span>·</span>
              <span>{formatTime(project.updatedAt)}</span>
            </div>
          </div>
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
          归档的对话不会出现在这里；在「对话 →
          归档」里可以找回。改动记录与撤销在对话右侧的「改动记录」面板里。
        </section>
      </div>
    </div>
  );
}
