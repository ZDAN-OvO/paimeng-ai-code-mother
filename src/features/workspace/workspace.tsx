'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { RailPanel, WorkspaceView } from './types';
import { useWorkspace } from './workspace-store';
import { useStoredValue, writeStored } from '@/lib/storage';
import { useIsMobile } from '@/lib/media';
import { AppSidebar } from './app-sidebar';
import { ChatHistoryPanel } from './chat-history-panel';
import { ChangeSetsPanel } from './change-sets-panel';
import { ChatPanel, type Attachment, type DesignSelection } from '@/features/chat/chat-panel';
import { CodePanel } from './code-panel';
import { LogsPanel } from './logs-panel';
import { PreviewPanel } from './preview-panel';
import { ProjectOverviewPanel } from './project-overview-panel';
import { ProjectsPanel } from './projects-panel';
import { SettingsPanel } from './settings-panel';
import { TemplatesPanel } from './templates-panel';
import { WorkspaceHeader } from './workspace-header';
import { SkillsView } from '@/features/skills/skills-view';

const DEFAULT_RAIL = 620;
const MIN_RAIL = 380;
const DEFAULT_SIDEBAR = 264;
const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 420;

export function Workspace({ chatId }: { chatId: string }) {
  const router = useRouter();
  const {
    state,
    hydrated,
    error,
    clearError,
    createChat,
    renameProject,
    renameChat,
    archiveChat,
    restoreChat,
    undoChangeSet,
  } = useWorkspace();

  const chat = state.chats.find((item) => item.id === chatId) ?? null;
  const project = state.project;
  const chats = project ? state.chats.filter((item) => item.projectId === project.id) : [];

  const [view, setView] = useState<WorkspaceView>('chat');
  // 项目视图里：null 是项目列表，有值是某个项目的概览。
  const [projectView, setProjectView] = useState<string | null>(null);
  // 对话视图按项目过滤（从项目概览的「查看全部」进来）。
  const [chatFilter, setChatFilter] = useState<{ id: string; name: string } | null>(null);
  const [panel, setPanel] = useState<RailPanel>('preview');
  const [focusChangeSet, setFocusChangeSet] = useState<string | null>(null);
  const [designMode, setDesignMode] = useState(false);
  const [selection, setSelection] = useState<DesignSelection | null>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [path, setPath] = useState('app/page.tsx');

  const storedCollapsed = useStoredValue('paimeng.sidebar', 'open') === 'closed';
  const isMobile = useIsMobile();
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const collapsed = isMobile ? !mobileExpanded : storedCollapsed;
  const storedSidebar = Number(useStoredValue('paimeng.sidebarPx', ''));
  const [dragSidebar, setDragSidebar] = useState<number | null>(null);
  const sidebarWidth =
    dragSidebar ??
    (Number.isFinite(storedSidebar) && storedSidebar >= MIN_SIDEBAR ? storedSidebar : null);
  const storedRail = Number(useStoredValue('paimeng.railPx', ''));
  const [dragRail, setDragRail] = useState<number | null>(null);
  const railWidth =
    dragRail ?? (Number.isFinite(storedRail) && storedRail >= MIN_RAIL ? storedRail : null);
  const splitRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const handleArchive = useCallback(
    async (target: string) => {
      try {
        await archiveChat(target);
        toast.success('已归档', {
          description: '在「对话 → 归档」里可以找回它。',
        });
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : '归档失败，请重试');
      }
    },
    [archiveChat],
  );

  const handleRestore = useCallback(
    async (target: string) => {
      try {
        await restoreChat(target);
        toast.success('已恢复到列表');
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : '恢复失败，请重试');
      }
    },
    [restoreChat],
  );

  const handleRenameChat = useCallback(
    async (target: string, title: string) => {
      try {
        await renameChat(target, title);
        toast.success('会话已重命名');
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : '重命名失败，请重试');
      }
    },
    [renameChat],
  );

  const handleUndo = useCallback(
    async (changeSetId: string) => {
      if (!project) return;
      await undoChangeSet(project.id, changeSetId);
      toast.success('已撤销这次改动', {
        description: '项目文件回到这一轮之前；预览与当前文件一起更新。',
      });
    },
    [project, undoChangeSet],
  );

  function openProject(projectId: string) {
    setView('projects');
    setProjectView(projectId);
  }

  // 侧栏切换视图不换路由；只有真正进某个会话才 push。
  function openChat(next: string) {
    setView('chat');
    router.push(`/chat/${next}`);
  }

  function startSidebarDrag(event: React.PointerEvent<HTMLDivElement>) {
    const shell = shellRef.current;
    if (!shell) return;
    event.preventDefault();
    const node: HTMLElement = shell;
    const left = node.getBoundingClientRect().left;
    let latest = Math.max(MIN_SIDEBAR, event.clientX - left);

    function move(moveEvent: PointerEvent) {
      const next = Math.min(
        Math.max(moveEvent.clientX - left, MIN_SIDEBAR),
        Math.min(MAX_SIDEBAR, node.getBoundingClientRect().width - 320),
      );
      latest = next;
      setDragSidebar(next);
    }

    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragSidebar(null);
      writeStored('paimeng.sidebarPx', String(Math.round(latest)));
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    const container = splitRef.current;
    if (!container) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth =
      container.getBoundingClientRect().right - event.currentTarget.getBoundingClientRect().left;
    const bounds = container.getBoundingClientRect();
    let latest = startWidth;

    function move(moveEvent: PointerEvent) {
      const next = Math.min(
        Math.max(startWidth + (startX - moveEvent.clientX), MIN_RAIL),
        Math.max(bounds.width - 360, MIN_RAIL),
      );
      latest = next;
      setDragRail(next);
    }

    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragRail(null);
      writeStored('paimeng.railPx', String(Math.round(latest)));
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  if (!hydrated) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-[13px] text-muted-foreground">
        正在打开对话…
      </div>
    );
  }

  if (!chat || !project) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background">
        <p className="text-sm">这个对话不存在，可能已经被删除。</p>
        <Button variant="outline" size="sm" asChild>
          <Link href="/">返回工作区</Link>
        </Button>
      </div>
    );
  }

  return (
    <div ref={shellRef} className="flex h-dvh overflow-hidden bg-background text-foreground">
      <AppSidebar
        collapsed={collapsed}
        width={sidebarWidth ?? undefined}
        onToggleCollapsed={() =>
          isMobile
            ? setMobileExpanded((value) => !value)
            : writeStored('paimeng.sidebar', storedCollapsed ? 'open' : 'closed')
        }
        overlay={isMobile}
        onHome={() => router.push('/')}
        project={project}
        chat={chat}
        projects={state.projects}
        chats={state.chats}
        view={view}
        onViewChange={(next) => {
          setView(next);
          setMobileExpanded(false);
          setProjectView(null);
          if (next !== 'chats') setChatFilter(null);
        }}
        onSelectChat={openChat}
        onNewChat={() => createChat(project.id)}
        onNewProject={() => router.push('/?new=1')}
        onOpenProject={openProject}
        onRenameChat={(target, title) => void handleRenameChat(target, title)}
        onArchiveChat={(target) => void handleArchive(target)}
      />

      {collapsed ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startSidebarDrag}
          onDoubleClick={() => writeStored('paimeng.sidebarPx', String(DEFAULT_SIDEBAR))}
          className="group relative hidden w-1 shrink-0 cursor-col-resize bg-border/70 transition-colors hover:bg-foreground/25 lg:block"
          title="拖动调整侧栏宽度，双击复位"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {error ? (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          >
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" onClick={clearError} className="shrink-0 underline">
              关闭
            </button>
          </div>
        ) : null}
        {view === 'chat' ? (
          <>
            <WorkspaceHeader
              project={project}
              chats={chats}
              chat={chat}
              panel={panel}
              onPanelChange={setPanel}
              onSelectChat={openChat}
              onNewChat={() => createChat(project.id)}
              onRename={(name) => {
                renameProject(project.id, name);
                toast.success('项目已重命名');
              }}
            />

            <div ref={splitRef} className="flex min-h-0 flex-1 flex-col lg:flex-row">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <ChatPanel
                  chat={chat}
                  project={project}
                  models={state.models}
                  templates={state.templates}
                  selection={selection}
                  onClearSelection={() => setSelection(null)}
                  draft={draft}
                  onDraftChange={setDraft}
                  attachments={attachments}
                  onAttachmentsChange={setAttachments}
                  onOpenChangeSet={(changeSetId) => {
                    setFocusChangeSet(changeSetId);
                    setPanel('changes');
                  }}
                />
              </div>

              <div
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startDrag}
                onDoubleClick={() => writeStored('paimeng.railPx', String(DEFAULT_RAIL))}
                className="group relative hidden w-1 shrink-0 cursor-col-resize bg-border/70 transition-colors hover:bg-foreground/25 lg:block"
                title="拖动调整右栏宽度，双击复位"
              >
                <span className="absolute inset-y-0 -right-1 -left-1" />
              </div>

              <div
                style={
                  railWidth ? ({ '--rail': `${railWidth}px` } as React.CSSProperties) : undefined
                }
                className={cn(
                  'flex min-h-0 shrink-0 flex-col border-t border-border/40 bg-background max-lg:max-h-[48%] lg:border-t-0 lg:border-l',
                  railWidth ? 'lg:w-[var(--rail)]' : 'lg:w-[58%] lg:min-w-[380px]',
                )}
              >
                {panel === 'preview' ? (
                  <PreviewPanel
                    site={project.site}
                    workspacePath={project.workspacePath}
                    runtime={project.runtime}
                    streaming={chat.streaming}
                    designMode={designMode}
                    onToggleDesign={() => {
                      setDesignMode((value) => !value);
                      setSelection(null);
                    }}
                    onSelectElement={(next) => {
                      setSelection(next);
                      setDesignMode(false);
                      setDraft(`调整「${next.label}」这个区块：`);
                      toast.success(`已选中 ${next.component}`, {
                        description: '一句话已经填进对话框，补充你想改的内容再发送。',
                      });
                    }}
                    selection={selection}
                  />
                ) : panel === 'code' ? (
                  <CodePanel
                    files={project.files}
                    workspacePath={project.workspacePath}
                    streaming={chat.streaming}
                    selectedPath={path}
                    onSelectPath={setPath}
                  />
                ) : panel === 'changes' ? (
                  <ChangeSetsPanel
                    key={focusChangeSet ?? 'latest'}
                    project={project}
                    focusChangeSetId={focusChangeSet}
                    onShowFile={(next) => {
                      setPath(next);
                      setPanel('code');
                    }}
                    onUndo={handleUndo}
                  />
                ) : panel === 'logs' ? (
                  <LogsPanel project={project} streaming={chat.streaming} />
                ) : (
                  <SettingsPanel project={project} />
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {view === 'chats' ? (
              <ChatHistoryPanel
                currentChatId={chat.id}
                archived={state.archived}
                projectFilter={chatFilter}
                onOpenChat={openChat}
                onRestore={(target) => void handleRestore(target)}
                onClearFilter={() => setChatFilter(null)}
              />
            ) : view === 'projects' ? (
              projectView ? (
                <ProjectOverviewPanel
                  projectId={projectView}
                  onOpenChat={openChat}
                  onOpenChatList={() => {
                    const overview = state.projects.find((item) => item.id === projectView);
                    setChatFilter(overview ? { id: overview.id, name: overview.name } : null);
                    setView('chats');
                  }}
                  onRename={(name) => {
                    void renameProject(projectView, name);
                    toast.success('项目已重命名');
                  }}
                  onOpenSettings={(target) => {
                    setPanel('settings');
                    openChat(target);
                  }}
                  onNewChat={() => {
                    createChat(projectView);
                    setView('chat');
                  }}
                />
              ) : (
                <ProjectsPanel currentProjectId={project.id} onOpenProject={openProject} />
              )
            ) : view === 'skills' ? (
              <SkillsView mode="panel" onOpenChat={openChat} projectId={project.id} />
            ) : (
              <TemplatesPanel
                onOpenChat={openChat}
                onCreated={() => {
                  setView('chat');
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
