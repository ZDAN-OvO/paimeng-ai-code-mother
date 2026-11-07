'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  Database,
  FileDiff,
  History,
  KeyRound,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  Rocket,
  ScrollText,
  SquareCode,
  Terminal,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatTime } from '../mock-data';
import type { Chat, Project, RailPanel } from '../types';
import { ThemeToggle } from './theme-toggle';

export const RAIL_LABEL: Record<RailPanel, string> = {
  preview: '预览',
  code: '代码',
  diff: '版本 diff',
  logs: '日志',
  settings: '设置',
  artifact: '产物',
};

export function WorkspaceHeader({
  project,
  chats,
  chat,
  panel,
  onPanelChange,
  onSelectChat,
  onNewChat,
  onOpenDeploy,
  onRename,
}: {
  project: Project;
  chats: Chat[];
  chat: Chat;
  panel: RailPanel;
  onPanelChange: (panel: RailPanel) => void;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onOpenDeploy: () => void;
  onRename: (name: string) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const deployed = project.deploys[0];
  const extra = panel === 'preview' || panel === 'code' ? null : panel;

  function commit() {
    const next = name.trim();
    if (next) onRename(next);
    setEditing(false);
  }

  function unavailable(title: string, body: string) {
    toast.info(`${title}面板未接通`, { description: body });
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
          className="group flex items-center gap-1.5 rounded px-1 py-1 text-[13px] font-medium hover:bg-muted"
          title="重命名项目"
        >
          {project.name}
          <Pencil className="size-3 text-muted-foreground/50 group-hover:text-muted-foreground" />
        </button>
      )}

      <span className="text-muted-foreground/40">/</span>

      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="chat-switcher"
          className="flex max-w-56 items-center gap-1.5 rounded px-1.5 py-1 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <span className="truncate">{chat.title}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            这个项目下的对话（{chats.length}）
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
                {item.messages.length} 条消息 · {item.versions.length} 个版本 ·{' '}
                {formatTime(item.updatedAt)}
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
            label="代码"
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
              label="代码"
              active={panel === 'code'}
              onClick={() => onPanelChange('code')}
            />
            <PanelMenuItem
              testId="menu-diff"
              icon={FileDiff}
              label="版本 diff"
              active={panel === 'diff'}
              onClick={() => onPanelChange('diff')}
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
              label="设置与环境变量"
              active={panel === 'settings'}
              onClick={() => onPanelChange('settings')}
            />
            <PanelMenuItem
              testId="menu-artifact"
              icon={History}
              label="产物与发布记录"
              active={panel === 'artifact'}
              onClick={() => onPanelChange('artifact')}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="menu-database"
              onClick={() =>
                unavailable('数据库', '真实实现里这里连沙箱里的 Postgres；原型不渲染假数据。')
              }
              className="gap-2 text-[12.5px] text-muted-foreground"
            >
              <Database className="size-3.5" />
              数据库
              <span className="ml-auto rounded border border-border px-1 text-[9px]">未接通</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="menu-terminal"
              onClick={() =>
                unavailable('终端', '真实实现里这里复用沙箱的 shell 会话；原型不执行命令。')
              }
              className="gap-2 text-[12.5px] text-muted-foreground"
            >
              <Terminal className="size-3.5" />
              终端
              <span className="ml-auto rounded border border-border px-1 text-[9px]">未接通</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ThemeToggle />

        {deployed && project.deployKey ? (
          <Link
            href={`/prototype/p/${project.deployKey}`}
            target="_blank"
            className="mr-1 hidden items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10.5px] text-emerald-800 hover:bg-emerald-100 lg:flex dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            title="打开已发布地址"
          >
            <span className="size-1.5 rounded-full bg-emerald-500" />
            已发布 v{deployed.versionSeq}
          </Link>
        ) : null}

        <Button
          size="sm"
          data-testid="open-deploy"
          className="h-7 gap-1 px-2.5 text-[11.5px]"
          onClick={onOpenDeploy}
        >
          <Rocket className="size-3.5" />
          发布
        </Button>
        <button
          type="button"
          onClick={() => router.push('/prototype')}
          className="ml-0.5 flex size-6 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground"
          title="回到首页"
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
