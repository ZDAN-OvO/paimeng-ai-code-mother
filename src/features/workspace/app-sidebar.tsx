'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  ArrowUpRight,
  ChevronDown,
  FolderOpen,
  MessageSquarePlus,
  Pencil,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatTime } from '@/lib/time';
import type { ChatSummary, ProjectSummary } from '@/shared/api/schemas';

export function AppSidebar({
  currentProjectId,
  currentChatId,
  projects,
  chats,
  archived,
  onHome,
  onNewChat,
  onNewProject,
  onOpenProject,
  onRenameChat,
  onArchiveChat,
  onRestoreChat,
  onOpenSkills,
}: {
  currentProjectId: string | null;
  currentChatId: string | null;
  projects: ProjectSummary[];
  chats: ChatSummary[];
  archived: ChatSummary[];
  onHome: () => void;
  onNewChat: () => void;
  onNewProject: () => void;
  onOpenProject: (project: ProjectSummary) => void;
  onRenameChat: (chatId: string, title: string) => Promise<void>;
  onArchiveChat: (chatId: string) => void;
  onRestoreChat: (chatId: string) => void;
  onOpenSkills: () => void;
}) {
  const [query, setQuery] = useState('');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const filteredChats = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return chats;
    return chats.filter((chat) => chat.title.toLowerCase().includes(keyword));
  }, [chats, query]);

  const filteredProjects = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(keyword) ||
        project.workspacePath.toLowerCase().includes(keyword),
    );
  }, [projects, query]);

  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;

  async function submitRename(chatId: string) {
    if (!draft.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onRenameChat(chatId, draft);
      setEditingId(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-muted/20">
      <div className="flex h-14 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          onClick={onHome}
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-xs font-semibold text-background">
            PM
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">派蒙</span>
            <span className="block truncate text-[10px] text-muted-foreground">本地开发助手</span>
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          title="技能"
          onClick={onOpenSkills}
        >
          <Sparkles className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-2 border-b border-border p-2.5">
        <Button className="w-full justify-start gap-2" size="sm" onClick={onNewChat}>
          <MessageSquarePlus className="size-4" />
          {currentProjectId ? '新建对话' : '打开本地目录'}
        </Button>
        {currentProjectId ? (
          <Button
            variant="outline"
            className="w-full justify-start gap-2"
            size="sm"
            onClick={onNewProject}
          >
            <FolderOpen className="size-4" />
            打开其他目录
          </Button>
        ) : null}
      </div>

      <div className="border-b border-border p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索对话或项目"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {currentProject ? (
          <section className="mb-3">
            <div className="px-2 pb-1.5">
              <p className="truncate text-[11px] font-medium tracking-wide text-muted-foreground">
                当前项目
              </p>
              <p className="truncate text-xs font-semibold">{currentProject.name}</p>
              <p className="truncate font-mono text-[10px] text-muted-foreground">
                {currentProject.workspacePath}
              </p>
            </div>
            <div className="space-y-0.5">
              {filteredChats.length === 0 ? (
                <p className="px-2 py-2 text-[11px] text-muted-foreground">还没有对话。</p>
              ) : (
                filteredChats.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    active={chat.id === currentChatId}
                    editing={editingId === chat.id}
                    draft={draft}
                    submitting={submitting}
                    onDraftChange={setDraft}
                    onStartRename={() => {
                      setEditingId(chat.id);
                      setDraft(chat.title);
                    }}
                    onCancelRename={() => setEditingId(null)}
                    onSubmitRename={() => void submitRename(chat.id)}
                    onArchive={() => onArchiveChat(chat.id)}
                  />
                ))
              )}
            </div>
          </section>
        ) : null}

        <section className="mb-3">
          <p className="px-2 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground">
            {currentProject ? '最近项目' : '本地项目'}
          </p>
          <div className="space-y-0.5">
            {filteredProjects.length === 0 ? (
              <p className="px-2 py-2 text-[11px] leading-5 text-muted-foreground">
                还没有项目。打开一个本地目录开始。
              </p>
            ) : (
              filteredProjects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => onOpenProject(project)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    project.id === currentProjectId
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-card text-[10px] font-semibold">
                    {project.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{project.name}</span>
                    <span className="block truncate font-mono text-[9.5px] text-muted-foreground/80">
                      {project.workspacePath}
                    </span>
                  </span>
                  <span className="shrink-0 text-[9.5px] text-muted-foreground/70">
                    {project.chatCount} 对话
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        <section>
          <button
            type="button"
            onClick={() => setArchivedOpen((value) => !value)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground hover:bg-muted/60"
          >
            <Archive className="size-3.5" />
            已归档
            <span className="ml-auto text-[10px]">{archived.length}</span>
            <ChevronDown
              className={cn('size-3 transition-transform', archivedOpen && 'rotate-180')}
            />
          </button>
          {archivedOpen ? (
            <div className="mt-0.5 space-y-0.5">
              {archived.length === 0 ? (
                <p className="px-2 py-1.5 text-[11px] text-muted-foreground">没有归档的对话。</p>
              ) : (
                archived.map((chat) => (
                  <div
                    key={chat.id}
                    className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/60"
                  >
                    <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                    <button
                      type="button"
                      title="恢复对话"
                      onClick={() => onRestoreChat(chat.id)}
                      className="rounded p-1 hover:bg-muted hover:text-foreground"
                    >
                      <RotateCcw className="size-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </section>
      </div>

      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={onOpenSkills}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Sparkles className="size-3.5" />
          技能
          <ArrowUpRight className="ml-auto size-3" />
        </button>
        <button
          type="button"
          onClick={onHome}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <SquareArrowOutUpRight className="size-3.5" />
          首页 / 打开目录
        </button>
        <div className="flex items-center gap-1.5 px-2 pt-1 text-[10px] text-muted-foreground/70">
          <Settings2 className="size-3" />
          模型配置在 .env
        </div>
      </div>
    </aside>
  );
}

function ChatRow({
  chat,
  active,
  editing,
  draft,
  submitting,
  onDraftChange,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onArchive,
}: {
  chat: ChatSummary;
  active: boolean;
  editing: boolean;
  draft: string;
  submitting: boolean;
  onDraftChange: (value: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: () => void;
  onArchive: () => void;
}) {
  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-1">
        <Input
          autoFocus
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmitRename();
            }
            if (event.key === 'Escape') onCancelRename();
          }}
          className="h-6 min-w-0 flex-1 border-0 px-1 text-xs shadow-none focus-visible:ring-0"
        />
        <button
          type="button"
          disabled={submitting || !draft.trim()}
          onClick={onSubmitRename}
          className="rounded px-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          保存
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60',
      )}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        {chat.pendingApproval ? (
          <span className="size-2 rounded-full bg-amber-500" title="等待命令批准" />
        ) : chat.streaming ? (
          <span className="size-2 animate-pulse rounded-full bg-emerald-500" title="正在执行" />
        ) : (
          <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        )}
      </span>
      <Link
        href={`/chat/${chat.id}`}
        className="min-w-0 flex-1 truncate py-0.5 text-xs"
        title={chat.title}
      >
        {chat.title}
      </Link>
      {chat.pendingApproval ? (
        <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-700 dark:text-amber-400">
          待批准
        </span>
      ) : chat.streaming ? (
        <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] text-emerald-700 dark:text-emerald-400">
          执行中
        </span>
      ) : (
        <span className="hidden shrink-0 text-[9px] text-muted-foreground/60 group-hover:inline">
          {formatTime(chat.updatedAt)}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
          title="对话操作"
        >
          <Settings2 className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={onStartRename} className="gap-2 text-xs">
            <Pencil className="size-3.5" />
            重命名
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onArchive} className="gap-2 text-xs">
            <Archive className="size-3.5" />
            归档
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
