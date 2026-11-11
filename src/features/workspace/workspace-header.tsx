'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Check,
  ChevronDown,
  CircleAlert,
  FolderGit2,
  Home,
  Menu,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ChatSummary, Project } from '@/shared/api/schemas';

export type RailPanel = 'changes' | 'files' | 'preview';

export const RAIL_LABEL: Record<RailPanel, string> = {
  changes: '改动',
  files: '文件',
  preview: '预览',
};

export function WorkspaceHeader({
  project,
  chat,
  chats,
  panel,
  onPanelChange,
  onMenu,
  onNewChat,
  onRenameProject,
  onSelectChat,
  onRefresh,
  connection,
}: {
  project: Project;
  chat: ChatSummary;
  chats: ChatSummary[];
  panel: RailPanel;
  onPanelChange: (panel: RailPanel) => void;
  onMenu: () => void;
  onNewChat: () => void;
  onRenameProject: (name: string) => Promise<void>;
  onSelectChat: (chatId: string) => void;
  onRefresh: () => void;
  connection: 'idle' | 'connecting' | 'live' | 'reconnecting';
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);

  async function saveName() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onRenameProject(name);
      setRenameOpen(false);
    } finally {
      setSaving(false);
    }
  }

  const connectionLabel = {
    idle: null,
    connecting: '正在连接事件流',
    live: '事件流已连接',
    reconnecting: '事件流重连中',
  }[connection];

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-background px-2.5 py-1.5 sm:flex-nowrap sm:px-3">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 lg:hidden"
        onClick={onMenu}
        title="导航"
      >
        <Menu className="size-4" />
      </Button>
      <Button variant="ghost" size="icon" className="size-8" asChild title="首页">
        <Link href="/">
          <Home className="size-4" />
        </Link>
      </Button>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setName(project.name);
              setRenameOpen(true);
            }}
            className="group flex min-w-0 items-center gap-1 rounded px-0.5 text-sm font-semibold hover:text-foreground"
            title="重命名项目"
          >
            <span className="truncate">{project.name}</span>
            <Pencil className="size-3 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" />
          </button>
          <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">
            {project.chatCount} 对话
          </Badge>
          <Badge variant="outline" className="hidden text-[10px] md:inline-flex">
            {project.changeCount} 处改动
          </Badge>
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
          <FolderGit2 className="size-3 shrink-0" />
          <span className="truncate font-mono">{project.workspacePath}</span>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex max-w-[42vw] items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-xs hover:border-foreground/30 sm:max-w-56">
            <span className="truncate">{chat.title}</span>
            {chat.pendingApproval ? (
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="等待命令批准" />
            ) : chat.streaming ? (
              <span
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                title="正在执行"
              />
            ) : null}
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">
              切换对话
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {chats.map((item) => (
              <DropdownMenuItem
                key={item.id}
                onClick={() => onSelectChat(item.id)}
                className="flex items-center gap-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.id === chat.id ? <Check className="size-3.5 text-emerald-600" /> : null}
                {item.pendingApproval ? (
                  <span className="text-[10px] text-amber-600">待批准</span>
                ) : item.streaming ? (
                  <span className="text-[10px] text-emerald-600">执行中</span>
                ) : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onNewChat} className="gap-2 text-xs">
              <MessageSquarePlus className="size-3.5" />
              新建对话
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onRefresh}
          title="刷新项目与变更"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      <div className="flex w-full items-center gap-1 border-t border-border/60 pt-1 sm:w-auto sm:border-0 sm:pt-0">
        <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
          {(Object.keys(RAIL_LABEL) as RailPanel[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onPanelChange(item)}
              className={cn(
                'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
                panel === item
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {RAIL_LABEL[item]}
            </button>
          ))}
        </div>
        {connectionLabel ? (
          <span
            className={cn(
              'ml-auto flex items-center gap-1 text-[10px] text-muted-foreground sm:ml-1',
              connection === 'reconnecting' && 'text-amber-600',
            )}
            title={connectionLabel}
          >
            {connection === 'reconnecting' ? (
              <CircleAlert className="size-3" />
            ) : (
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            )}
            <span className="hidden md:inline">{connectionLabel}</span>
          </span>
        ) : null}
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名项目</DialogTitle>
            <DialogDescription>只改变显示名称，不会重命名磁盘目录。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void saveName();
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void saveName()} disabled={!name.trim() || saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
