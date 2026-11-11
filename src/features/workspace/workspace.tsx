'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, PanelRightClose, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppSidebar } from '@/features/workspace/app-sidebar';
import { WorkspaceHeader, type RailPanel } from '@/features/workspace/workspace-header';
import { ChatPanel } from '@/features/chat/chat-panel';
import { ChangeSetsPanel } from '@/features/workspace/change-sets-panel';
import { CodePanel } from '@/features/workspace/code-panel';
import { PreviewPanel } from '@/features/workspace/preview-panel';
import { useWorkspace } from '@/features/workspace/workspace-store';
import { openProjectChat } from '@/features/workspace/project-actions';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import type { ProjectSummary } from '@/shared/api/schemas';

function openRailOnNarrowScreen() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
}

export function Workspace({ chatId }: { chatId: string }) {
  const router = useRouter();
  const {
    bundle,
    chats,
    projects,
    archived,
    loading,
    error,
    filesVersion,
    connection,
    refresh,
    createChat,
    renameChat,
    archiveChat,
    restoreChat,
    renameProject,
    notifyFilesChanged,
  } = useWorkspace();
  const [panel, setPanel] = useState<RailPanel>('changes');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);

  function go(href: string) {
    setSidebarOpen(false);
    setRailOpen(false);
    router.push(href);
  }

  function selectPanel(next: RailPanel) {
    setPanel(next);
    if (openRailOnNarrowScreen()) setRailOpen(true);
  }

  async function handleNewChat() {
    if (!bundle) {
      go('/?open=1');
      return;
    }
    setNavError(null);
    try {
      const chat = await createChat(bundle.project.id);
      if (chat) go(`/chat/${chat.id}`);
    } catch (cause) {
      setNavError(errorMessage(cause));
    }
  }

  async function handleOpenProject(project: ProjectSummary) {
    setNavError(null);
    try {
      const target = await openProjectChat(project);
      go(`/chat/${target}`);
    } catch (cause) {
      setNavError(errorMessage(cause));
    }
  }

  async function handleArchiveChat(targetId: string) {
    const remaining = chats.filter((chat) => chat.id !== targetId);
    const archived = await archiveChat(targetId);
    if (!archived) return;
    if (targetId === chatId) {
      const next = remaining[0];
      go(next ? `/chat/${next.id}` : '/');
    }
  }

  if (loading && !bundle) {
    return (
      <div className="flex h-dvh items-center justify-center gap-2 bg-background text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在打开对话…
      </div>
    );
  }

  if (!bundle) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <AlertCircle className="size-6 text-destructive" />
        <p className="text-sm font-medium">无法打开这个对话</p>
        <p className="max-w-md break-words text-xs leading-5 text-muted-foreground">
          {error ?? '对话不存在，或已经归档。'}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            重试
          </Button>
          <Button size="sm" onClick={() => go('/')}>
            返回首页
          </Button>
        </div>
      </div>
    );
  }

  const rail = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5 lg:hidden">
        <span className="text-[11px] font-medium">工作区面板</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => setRailOpen(false)}>
          <PanelRightClose className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {panel === 'changes' ? (
          <ChangeSetsPanel
            projectId={bundle.project.id}
            filesVersion={filesVersion}
            onFilesChanged={notifyFilesChanged}
          />
        ) : panel === 'files' ? (
          <CodePanel
            projectId={bundle.project.id}
            fileIndex={bundle.project.fileIndex}
            filesVersion={filesVersion}
          />
        ) : (
          <PreviewPanel projectName={bundle.project.name} />
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background">
      <div className="hidden w-[264px] shrink-0 lg:block">
        <AppSidebar
          currentProjectId={bundle.project.id}
          currentChatId={chatId}
          projects={projects}
          chats={chats}
          archived={archived}
          onHome={() => go('/')}
          onNewChat={() => void handleNewChat()}
          onNewProject={() => go('/?open=1')}
          onOpenProject={(project) => void handleOpenProject(project)}
          onRenameChat={renameChat}
          onArchiveChat={(id) => void handleArchiveChat(id)}
          onRestoreChat={(id) => void restoreChat(id)}
          onOpenSkills={() => go('/skills')}
        />
      </div>

      {sidebarOpen ? (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="关闭导航"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative flex h-full w-[min(86vw,300px)] flex-col bg-background shadow-xl">
            <AppSidebar
              currentProjectId={bundle.project.id}
              currentChatId={chatId}
              projects={projects}
              chats={chats}
              archived={archived}
              onHome={() => go('/')}
              onNewChat={() => void handleNewChat()}
              onNewProject={() => go('/?open=1')}
              onOpenProject={(project) => void handleOpenProject(project)}
              onRenameChat={renameChat}
              onArchiveChat={(id) => void handleArchiveChat(id)}
              onRestoreChat={(id) => void restoreChat(id)}
              onOpenSkills={() => go('/skills')}
            />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader
          project={bundle.project}
          chat={bundle.chat}
          chats={chats}
          panel={panel}
          onPanelChange={selectPanel}
          onMenu={() => setSidebarOpen(true)}
          onNewChat={() => void handleNewChat()}
          onRenameProject={renameProject}
          onSelectChat={(id) => go(`/chat/${id}`)}
          onRefresh={() => void refresh()}
          connection={connection}
        />
        {navError ? (
          <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0 flex-1 break-words">{navError}</p>
            <button
              type="button"
              onClick={() => setNavError(null)}
              className="rounded p-0.5 hover:bg-destructive/10"
              title="关闭"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1">
            <ChatPanel onShowChanges={() => selectPanel('changes')} />
          </main>
          <aside className="hidden w-[min(42vw,560px)] min-w-[340px] shrink-0 border-l border-border lg:block">
            {rail}
          </aside>
        </div>
      </div>

      {railOpen ? (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="关闭面板"
            onClick={() => setRailOpen(false)}
          />
          <div
            className={cn(
              'relative ml-auto flex h-full w-[min(92vw,560px)] flex-col border-l border-border bg-background shadow-xl',
            )}
          >
            {rail}
          </div>
        </div>
      ) : null}
    </div>
  );
}
