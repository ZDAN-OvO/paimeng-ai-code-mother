'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  ChevronRight,
  FileText,
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
  Star,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Chat, Project } from '../types';

const DRAFTS = [
  '指针 AI 落地页：一句话讲清它替谁省了什么时间',
  '咖啡订阅定价页，三档月付，把运费写清楚',
  '周报面板的筛选交互说明，先只做静态',
  '作品集：只放四个项目，每个配一句结果',
];

export function AppSidebar({
  collapsed,
  onToggleCollapsed,
  project,
  chat,
  projects,
  chats,
  onSelectChat,
  onNewChat,
  onDraft,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  project: Project;
  chat: Chat;
  projects: Project[];
  chats: Chat[];
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onDraft: (text: string) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    [project.id]: true,
  });
  const [showAllDrafts, setShowAllDrafts] = useState(false);

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
            node.project.id === project.id,
        ),
    // match 只依赖 needle；projects/chats 已是当前快照。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chats, needle, project.id, projects],
  );

  const favorites = chats
    .filter((entry) => entry.id === 'chat_cafe' || entry.id === 'chat_portfolio')
    .slice(0, 2);
  const drafts = DRAFTS.filter(match).slice(0, showAllDrafts ? DRAFTS.length : 3);

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
          onClick={onNewChat}
          className="mt-1 flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground"
          title="新建对话"
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
        <Link
          href="/prototype"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title="项目"
        >
          <LayoutGrid className="size-4" />
        </Link>
        <Link
          href="/prototype/skills"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title="技能"
        >
          <Sparkles className="size-4" />
        </Link>
        <Link
          href="/prototype#templates"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          title="模板"
        >
          <LayoutTemplate className="size-4" />
        </Link>
        <span className="mt-auto flex size-7 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
          本
        </span>
      </aside>
    );
  }

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-1 px-2.5 pt-2.5 pb-1.5">
        <button
          type="button"
          onClick={() => router.push('/prototype')}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-muted"
          title="回到项目首页"
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
          onClick={onNewChat}
          data-testid="sidebar-new-chat"
          className="flex w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[12px] font-medium transition-colors hover:bg-muted"
        >
          <Plus className="size-3.5" />
          新建对话
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
        <SidebarLink icon={LayoutGrid} label="项目" onClick={() => router.push('/prototype')} />
        <SidebarLink
          active
          icon={MessageSquare}
          label="对话"
          onClick={() => {
            const latest = chats
              .filter((entry) => entry.projectId === project.id)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            if (latest) onSelectChat(latest.id);
          }}
        />
        <SidebarLink
          icon={Sparkles}
          label="技能"
          onClick={() => router.push('/prototype/skills')}
        />
        <SidebarLink
          icon={LayoutTemplate}
          label="模板"
          onClick={() => router.push('/prototype#templates')}
        />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {favorites.length ? (
          <div className="mt-3">
            <SidebarHeading>收藏</SidebarHeading>
            {favorites.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSelectChat(entry.id)}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Star className="size-3 shrink-0 text-amber-500" />
                <span className="truncate">{entry.title}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-3">
          <SidebarHeading>草稿</SidebarHeading>
          {drafts.map((draft) => (
            <button
              key={draft}
              type="button"
              onClick={() => onDraft(draft)}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FileText className="size-3 shrink-0" />
              <span className="truncate">{draft}</span>
            </button>
          ))}
          {DRAFTS.length > 3 ? (
            <button
              type="button"
              onClick={() => setShowAllDrafts((value) => !value)}
              className="px-1.5 py-1 text-[10.5px] text-muted-foreground/80 hover:text-foreground"
            >
              {showAllDrafts ? '收起' : '显示更多'}
            </button>
          ) : null}
        </div>

        <div className="mt-3">
          <SidebarHeading>项目</SidebarHeading>
          {tree.map((node) => {
            const open = expanded[node.project.id] ?? false;
            const deployed = node.project.deploys[0];
            return (
              <div key={node.project.id}>
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((current) => ({
                      ...current,
                      [node.project.id]: !open,
                    }))
                  }
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] transition-colors',
                    node.project.id === project.id
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
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
                  {deployed ? (
                    <span className="ml-auto size-1.5 shrink-0 rounded-full bg-emerald-500" />
                  ) : null}
                </button>
                {open
                  ? node.chats.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => onSelectChat(entry.id)}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded-md py-1 pr-1.5 pl-6 text-left text-[11.5px] transition-colors',
                          entry.id === chat.id
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                        )}
                      >
                        <MessageSquare className="size-3 shrink-0" />
                        <span className="truncate">{entry.title}</span>
                      </button>
                    ))
                  : null}
              </div>
            );
          })}
        </div>

        {needle && tree.length === 0 && drafts.length === 0 ? (
          <p className="px-1.5 py-4 text-[11px] text-muted-foreground">没有匹配的项目或对话</p>
        ) : null}
      </div>

      <div className="border-t border-border px-2.5 py-2">
        <button
          type="button"
          onClick={() => router.push('/prototype')}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
            本
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11.5px] font-medium">本地用户</span>
            <span className="block truncate text-[10px] text-muted-foreground">
              原型 · 数据在浏览器
            </span>
          </span>
          <span className="rounded border border-border px-1 py-0.5 text-[9.5px] text-muted-foreground">
            v0
          </span>
        </button>
      </div>
    </aside>
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
