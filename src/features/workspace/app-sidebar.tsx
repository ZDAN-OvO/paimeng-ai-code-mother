'use client';

import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderClosed,
  FolderOpen,
  LayoutGrid,
  LayoutTemplate,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Sparkles,
  MoreHorizontal,
  Pencil,
  Archive,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ChatRecord, Project, ProjectSummary } from '@/shared/api/schemas';
import type { WorkspaceView } from './types';

export function AppSidebar({
  collapsed,
  width,
  onToggleCollapsed,
  onHome,
  overlay = false,
  project,
  chat,
  projects,
  chats,
  view,
  onViewChange,
  onSelectChat,
  onNewChat,
  onNewProject,
  onOpenProject,
  onRenameChat,
  onArchiveChat,
}: {
  collapsed: boolean;
  width?: number;
  onToggleCollapsed: () => void;
  onHome: () => void;
  overlay?: boolean;
  project: Project | null;
  /** 工作区空态没有当前对话。 */
  chat: ChatRecord | null;
  projects: ProjectSummary[];
  chats: ChatRecord[];
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onNewProject: () => void;
  onOpenProject: (projectId: string) => void;
  onRenameChat: (chatId: string, title: string) => void;
  onArchiveChat: (chatId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    project ? { [project.id]: true } : {},
  );

  const needle = query.trim().toLowerCase();
  const match = (text: string) => !needle || text.toLowerCase().includes(needle);

  const tree = useMemo(
    () =>
      projects
        .map((item) => ({
          project: item,
          chats: chats
            .filter((entry) => entry.projectId === item.id)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        }))
        .filter(
          (node) =>
            match(node.project.name) ||
            node.chats.some((entry) => match(entry.title)) ||
            node.project.id === project?.id,
        ),
    // match 只依赖 needle；projects/chats 已是当前快照。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chats, needle, project?.id, projects],
  );

  if (collapsed) {
    return (
      <aside className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2.5">
        <button
          type="button"
          onClick={onToggleCollapsed}
          data-testid="sidebar-expand"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title="展开侧栏"
        >
          <PanelLeftOpen className="size-4" />
        </button>
        <button
          type="button"
          onClick={project ? onNewChat : onNewProject}
          className="mt-1 flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground"
          title={project ? '新建对话' : '新建项目'}
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title="搜索"
        >
          <Search className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => onViewChange('projects')}
          className={cn(
            'flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground',
            view === 'projects' ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          title="项目"
        >
          <LayoutGrid className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => onViewChange('chats')}
          className={cn(
            'flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground',
            view === 'chats' ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          title="对话"
        >
          <MessageSquare className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => onViewChange('skills')}
          className={cn(
            'flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground',
            view === 'skills' ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          title="技能"
        >
          <Sparkles className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => onViewChange('templates')}
          className={cn(
            'flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground',
            view === 'templates' ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          title="模板"
        >
          <LayoutTemplate className="size-4" />
        </button>
        <span className="mt-auto flex size-7 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
          本
        </span>
      </aside>
    );
  }

  return (
    <>
      {overlay ? (
        <button
          type="button"
          aria-label="关闭侧栏"
          onClick={onToggleCollapsed}
          className="fixed inset-0 z-20 bg-black/25"
        />
      ) : null}
      <aside
        style={width ? { width } : undefined}
        className={cn(
          'flex shrink-0 flex-col border-r border-border bg-card',
          width ? null : 'w-[264px]',
          overlay && 'fixed inset-y-0 left-0 z-30 max-w-[85vw] shadow-xl',
        )}
      >
        <div className="flex items-center gap-1 px-2.5 pt-2.5 pb-1.5">
          <button
            type="button"
            onClick={onHome}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-muted"
            title="回到工作区"
          >
            <span className="flex size-5 items-center justify-center rounded bg-primary text-[9px] font-medium text-primary-foreground">
              本
            </span>
            <span className="truncate text-[12.5px] font-medium">本地工作区</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            data-testid="sidebar-collapse"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            title="收起侧栏"
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>

        <div className="px-2.5 pb-2">
          <button
            type="button"
            onClick={project ? onNewChat : onNewProject}
            data-testid={project ? 'sidebar-new-chat' : 'sidebar-new-project'}
            className="flex w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[12px] font-medium transition-colors hover:bg-muted"
            title={project ? '在当前项目里新建一条对话' : '新建本地项目'}
          >
            <Plus className="size-3.5" />
            {project ? '新建对话' : '新建项目'}
          </button>
        </div>

        <div className="px-2.5 pb-2">
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目与对话"
              data-testid="sidebar-search"
              className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        <nav className="px-2 pb-1">
          <SidebarLink
            active={view === 'projects'}
            icon={LayoutGrid}
            label="项目"
            onClick={() => onViewChange('projects')}
          />
          <SidebarLink
            active={view === 'chats'}
            icon={MessageSquare}
            label="对话"
            onClick={() => onViewChange('chats')}
          />
          <SidebarLink
            active={view === 'skills'}
            icon={Sparkles}
            label="技能"
            onClick={() => onViewChange('skills')}
          />
          <SidebarLink
            active={view === 'templates'}
            icon={LayoutTemplate}
            label="模板"
            onClick={() => onViewChange('templates')}
          />
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div className="mt-3">
            <SidebarHeading>项目</SidebarHeading>
            {tree.length === 0 ? (
              <p className="px-1.5 py-1 text-[10.5px] text-muted-foreground/80">
                还没有项目；点上方「新建项目」或从模板开始。
              </p>
            ) : null}
            {tree.map((node) => {
              const open = expanded[node.project.id] ?? node.project.id === project?.id;
              return (
                <div key={node.project.id}>
                  <div
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] transition-colors',
                      node.project.id === project?.id
                        ? 'font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <button
                      type="button"
                      data-testid={`project-open-${node.project.id}`}
                      onClick={() => {
                        setExpanded((current) => ({ ...current, [node.project.id]: true }));
                        onOpenProject(node.project.id);
                      }}
                      onDoubleClick={() =>
                        setExpanded((current) => ({
                          ...current,
                          [node.project.id]: !open,
                        }))
                      }
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      title={`打开项目　${node.project.workspacePath}`}
                    >
                      {open ? (
                        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                      )}
                      {open ? (
                        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{node.project.name}</span>
                    </button>
                  </div>
                  {open
                    ? node.chats.map((entry) => (
                        <ChatRow
                          key={entry.id}
                          chatId={entry.id}
                          title={entry.title}
                          active={view === 'chat' && entry.id === chat?.id}
                          onOpen={() => onSelectChat(entry.id)}
                          onRename={(next) => onRenameChat(entry.id, next)}
                          onArchive={() => onArchiveChat(entry.id)}
                        />
                      ))
                    : null}
                </div>
              );
            })}
          </div>

          {needle && tree.length === 0 ? (
            <p className="px-1.5 py-4 text-[11px] text-muted-foreground">没有匹配的项目或对话</p>
          ) : null}
        </div>

        <div className="border-t border-border px-2.5 py-2">
          <button
            type="button"
            onClick={onHome}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
              本
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11.5px] font-medium">本地用户</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                单用户 · 浏览器工作区
              </span>
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}

function SidebarHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground/80">
      {children}
    </div>
  );
}

function SidebarLink({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof LayoutGrid;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-[12px] transition-colors',
        active
          ? 'bg-muted font-medium text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

/** 项目里的对话：点名字进对话，⋯ 里改名或归档。 */
function ChatRow({
  chatId,
  title,
  active,
  onOpen,
  onRename,
  onArchive,
}: {
  chatId: string;
  title: string;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  function commit() {
    const next = value.trim();
    if (next && next !== title) onRename(next);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        data-testid={`rename-input-${chatId}`}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            setValue(title);
            setEditing(false);
          }
        }}
        className="w-full rounded-md border border-border bg-background py-1 pr-1.5 pl-6 text-[11.5px] outline-none focus:border-foreground/40"
      />
    );
  }

  return (
    <div className="group/row relative">
      <button
        type="button"
        data-testid={`chat-row-${chatId}`}
        onClick={onOpen}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md py-1 pr-7 pl-6 text-left text-[11.5px] transition-colors',
          active
            ? 'bg-muted font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <MessageSquare className="size-3 shrink-0" />
        <span className="truncate">{title}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`chat-menu-${chatId}`}
          title="会话操作"
          className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/row:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem
            className="gap-2 text-[12px]"
            onClick={() => {
              setValue(title);
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2 text-[12px]" onClick={onArchive}>
            <Archive className="size-3.5" />
            归档
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
