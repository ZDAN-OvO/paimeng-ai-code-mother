'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  FileDiff,
  FolderClosed,
  KeyRound,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  ScrollText,
  SquareCode,
  X,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatTime } from '@/lib/time';
import type { RailPanel } from './types';
import type { ChatRecord, Project } from '@/shared/api/schemas';
import { ThemeToggle } from '@/features/theme/theme-toggle';

export const RAIL_LABEL: Record<RailPanel, string> = {
  preview: '预览',
  code: '当前文件',
  changes: '改动记录',
  logs: '日志',
  settings: '设置',
};

export function WorkspaceHeader({
  project,
  chats,
  chat,
  panel,
  onPanelChange,
  onSelectChat,
  onNewChat,
  onRename,
}: {
  project: Project;
  chats: ChatRecord[];
  chat: ChatRecord;
  panel: RailPanel;
  onPanelChange: (panel: RailPanel) => void;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onRename: (name: string) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const extra = panel === 'preview' || panel === 'code' ? null : panel;

  function commit() {
    const next = name.trim();
    if (next) onRename(next);
    setEditing(false);
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              setName(project.name);
              setEditing(false);
            }
          }}
          className="w-40 rounded border border-border px-2 py-1 text-[13px] outline-none focus:border-foreground/40"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setName(project.name);
            setEditing(true);
          }}
          className="group flex min-w-0 items-center gap-1.5 rounded px-1 py-1 text-[13px] font-medium hover:bg-muted"
          title="重命名项目"
        >
          <span className="max-w-36 truncate">{project.name}</span>
          <Pencil className="size-3 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" />
        </button>
      )}
      <span
        data-testid="workspace-path"
        title={`目录：${project.workspacePath}${
          project.workspaceState === 'sample' ? '（示例项目，未连接真实目录）' : ''
        }`}
        className="hidden max-w-52 items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:flex"
      >
        <FolderClosed className="size-3 shrink-0" />
        <span className="truncate">{project.workspacePath}</span>
      </span>
      {project.workspaceState === 'sample' ? (
        <span
          data-testid="sample-project-badge"
          className="hidden rounded border border-amber-300 bg-amber-50 px-1 py-px text-[9.5px] text-amber-800 sm:inline dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          示例项目
        </span>
      ) : null}

      <span className="text-muted-foreground/40">/</span>

      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="chat-switcher"
          className="hidden max-w-48 items-center gap-1.5 rounded px-1.5 py-1 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground sm:flex"
        >
          <span className="truncate">{chat.title}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            这个项目的对话（{chats.length}）
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {chats.map((item) => (
            <DropdownMenuItem
              key={item.id}
              onClick={() => onSelectChat(item.id)}
              className="flex flex-col items-start gap-0.5 py-2"
            >
              <span className="text-[13px]">{item.title}</span>
              <span className="text-[10.5px] text-muted-foreground">
                {item.messages.length} 条消息 · {formatTime(item.updatedAt)}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onNewChat} className="gap-2 text-[13px]">
            <Plus className="size-3.5" />
            新建对话
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {chat.streaming ? (
        <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <Loader2 className="size-2.5 animate-spin" />
          生成中
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
          <RailTab
            testId="rail-preview"
            active={panel === 'preview'}
            icon={Monitor}
            label="预览"
            onClick={() => onPanelChange('preview')}
          />
          <RailTab
            testId="rail-code"
            active={panel === 'code'}
            icon={SquareCode}
            label="当前文件"
            onClick={() => onPanelChange('code')}
          />
          {extra ? (
            <span className="flex items-center gap-1 rounded-md bg-foreground px-2 py-1 text-[11px] text-background">
              {RAIL_LABEL[extra]}
              <button
                type="button"
                onClick={() => onPanelChange('preview')}
                className="rounded p-0.5 hover:bg-background/20"
                title="回到预览"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ) : null}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="rail-menu"
            className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="更多面板"
          >
            <Plus className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-[10.5px] text-muted-foreground">
              右栏一次只显示一个面板
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <PanelMenuItem
              testId="menu-preview"
              icon={Monitor}
              label="预览"
              active={panel === 'preview'}
              onClick={() => onPanelChange('preview')}
            />
            <PanelMenuItem
              testId="menu-code"
              icon={SquareCode}
              label="当前文件"
              active={panel === 'code'}
              onClick={() => onPanelChange('code')}
            />
            <PanelMenuItem
              testId="menu-changes"
              icon={FileDiff}
              label="改动记录"
              active={panel === 'changes'}
              onClick={() => onPanelChange('changes')}
            />
            <PanelMenuItem
              testId="menu-logs"
              icon={ScrollText}
              label="日志"
              active={panel === 'logs'}
              onClick={() => onPanelChange('logs')}
            />
            <PanelMenuItem
              testId="menu-settings"
              icon={KeyRound}
              label="项目设置与环境变量"
              active={panel === 'settings'}
              onClick={() => onPanelChange('settings')}
            />
          </DropdownMenuContent>
        </DropdownMenu>

        <ThemeToggle />

        <button
          type="button"
          onClick={() => router.push('/')}
          className="ml-0.5 flex size-6 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground"
          title="回到工作区"
        >
          本
        </button>
      </div>
    </header>
  );
}

function RailTab({
  active,
  icon: Icon,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  icon: typeof Monitor;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors',
        active
          ? 'bg-card font-medium text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
}

function PanelMenuItem({
  icon: Icon,
  label,
  active,
  onClick,
  testId,
}: {
  icon: typeof Monitor;
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <DropdownMenuItem
      data-testid={testId}
      onClick={onClick}
      className={cn('gap-2 text-[12.5px]', active && 'bg-muted')}
    >
      <Icon className="size-3.5 text-muted-foreground" />
      {label}
      {active ? <span className="ml-auto text-[10px] text-muted-foreground">当前</span> : null}
    </DropdownMenuItem>
  );
}
