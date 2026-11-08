'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CornerUpLeft, History, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { RailPanel, WorkspaceView } from './types';
import { useWorkspace } from './workspace-store';
import { useStoredValue, writeStored } from '@/lib/storage';
import { AppSidebar } from './app-sidebar';
import { ChatHistoryPanel } from './chat-history-panel';
import { ArtifactPanel } from './artifact-panel';
import { ChatPanel, type Attachment, type DesignSelection } from '@/features/chat/chat-panel';
import { CodePanel } from './code-panel';
import { DeployDialog } from './deploy-dialog';
import { LogsPanel } from './logs-panel';
import { PreviewPanel } from './preview-panel';
import { ProjectOverviewPanel } from './project-overview-panel';
import { ProjectsPanel } from './projects-panel';
import { SettingsPanel } from './settings-panel';
import { VersionsPanel } from './versions-panel';
import { TemplatesPanel } from './templates-panel';
import { WorkspaceHeader } from './workspace-header';
import { SkillsView } from '@/features/skills/skills-view';

function DraftNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      <p className="max-w-xs text-[11.5px] leading-5 text-muted-foreground">{body}</p>
    </div>
  );
}

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
    createChat,
    setViewVersion,
    rollbackTo,
    renameProject,
    promoteDraft,
    renameChat,
    archiveChat,
    restoreChat,
    refresh,
  } = useWorkspace();

  const chat = state.chats.find((item) => item.id === chatId);
  // 草稿没有项目：project 为 null 时走「草稿」形态，创建项目后才变成正常项目视图。
  const project = state.projects.find((item) => item.id === chat?.projectId) ?? null;
  const chats = chat?.projectId
    ? state.chats.filter((item) => item.projectId === chat.projectId)
    : [];

  const [view, setView] = useState<WorkspaceView>('chat');
  // 项目视图里：null 是项目列表，有值是某个项目的概览。
  const [projectView, setProjectView] = useState<string | null>(null);
  // 对话视图按项目过滤（从项目概览的「查看全部」进来）。
  const [chatFilter, setChatFilter] = useState<{ id: string; name: string } | null>(null);
  const [panel, setPanel] = useState<RailPanel>('preview');
  const [designMode, setDesignMode] = useState(false);
  const [selection, setSelection] = useState<DesignSelection | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [path, setPath] = useState('app/page.tsx');

  const collapsed = useStoredValue('paimeng.sidebar', 'open') === 'closed';
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

  const handleDeployed = useCallback(() => {
    void refresh();
  }, [refresh]);

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

  function openProject(projectId: string) {
    setView('projects');
    setProjectView(projectId);
  }

  const promote = useCallback(
    async (target: string) => {
      try {
        await promoteDraft(target);
        toast.success('已创建项目', {
          description: '这个会话和它的版本都在原地；现在可以用「发布」把它部署出去。',
        });
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : '创建项目失败，请重试');
      }
    },
    [promoteDraft],
  );

  // 侧栏切换视图不换路由；只有真正进某个会话才 push。
  function openChat(next: string) {
    setView('chat');
    router.push(`/chat/${next}`);
  }

  const active = chat?.versions[chat.versions.length - 1];
  const viewed = chat?.versions.find((version) => version.id === chat.viewVersionId) ?? active;
  const viewingOld = Boolean(active && viewed && active.id !== viewed.id);

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

  if (!chat) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background">
        <p className="text-sm">这个对话不存在，可能已经被删除。</p>
        <Button variant="outline" size="sm" asChild>
          <Link href="/">返回项目列表</Link>
        </Button>
      </div>
    );
  }

  return (
    <div ref={shellRef} className="flex h-dvh overflow-hidden bg-background text-foreground">
      <AppSidebar
        collapsed={collapsed}
        width={sidebarWidth ?? undefined}
        onToggleCollapsed={() => writeStored('paimeng.sidebar', collapsed ? 'open' : 'closed')}
        project={project}
        chat={chat}
        projects={state.projects}
        chats={state.chats}
        view={view}
        onViewChange={(next) => {
          setView(next);
          // 侧栏四个入口都回到各自的顶层：项目 → 项目列表，对话 → 全部会话。
          setProjectView(null);
          if (next !== 'chats') setChatFilter(null);
        }}
        drafts={state.drafts}
        onSelectChat={openChat}
        onNewChat={() => project && createChat(project.id)}
        onNewDraft={() => router.push('/')}
        onPromoteDraft={() => void promote(chat.id)}
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
          className="group relative w-1 shrink-0 cursor-col-resize bg-border/70 transition-colors hover:bg-foreground/25"
          title="拖动调整侧栏宽度，双击复位"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {view === 'chat' ? (
          <>
            <WorkspaceHeader
              project={project}
              chats={chats}
              chat={chat}
              panel={panel}
              onPanelChange={setPanel}
              onSelectChat={openChat}
              onNewChat={() => project && createChat(project.id)}
              onOpenDeploy={() => {
                if (chat.pendingPlan || chat.streaming) {
                  toast.info('请先结束当前生成或处理计划审批。');
                  return;
                }
                if (project) setDeployOpen(true);
              }}
              onPromote={() => void promote(chat.id)}
              onRename={(name) => {
                if (!project) return;
                renameProject(project.id, name);
                toast.success('项目已重命名');
              }}
            />

            {viewingOld && viewed ? (
              <div className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-3 py-1.5 text-[11px] text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
                <History className="size-3.5" />
                正在查看历史版本 {viewed.label}，预览与代码都是当时的样子。
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-2 text-[11px] text-sky-900 hover:bg-sky-100 dark:text-sky-200 dark:hover:bg-sky-900/40"
                    onClick={() => setViewVersion(chat.id, active?.id ?? viewed.id)}
                  >
                    <CornerUpLeft className="size-3" />
                    回到最新
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 gap-1 bg-sky-900 px-2 text-[11px] text-white hover:bg-sky-800 dark:bg-sky-200 dark:text-sky-950 dark:hover:bg-sky-100"
                    onClick={() => {
                      rollbackTo(chat.id, viewed.id);
                      toast.success(`已回滚到 ${viewed.label}`, {
                        description: '工作区换成旧源码树，并追加了一个新版本。',
                      });
                    }}
                  >
                    <RotateCcw className="size-3" />
                    回滚到此版本
                  </Button>
                </div>
              </div>
            ) : null}

            <div ref={splitRef} className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
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
                  onOpenVersion={(versionId) => {
                    setPanel('diff');
                    setViewVersion(chat.id, versionId);
                  }}
                />
              </div>

              <div
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startDrag}
                onDoubleClick={() => writeStored('paimeng.railPx', String(DEFAULT_RAIL))}
                className="group relative w-1 shrink-0 cursor-col-resize bg-border/70 transition-colors hover:bg-foreground/25"
                title="拖动调整右栏宽度，双击复位"
              >
                <span className="absolute inset-y-0 -left-1 -right-1" />
              </div>

              <div
                style={railWidth ? { width: railWidth } : undefined}
                className={
                  railWidth
                    ? 'flex min-h-0 shrink-0 flex-col border-l border-border/40'
                    : 'flex min-h-0 w-[58%] min-w-[380px] shrink-0 flex-col border-l border-border/40'
                }
              >
                {panel === 'preview' ? (
                  <PreviewPanel
                    version={viewed && Object.keys(viewed.files).length ? viewed : undefined}
                    liveSite={chat.streaming ? chat.liveSite : undefined}
                    chatId={chat.id}
                    sandboxState={chat.versions.length ? 'running' : 'starting'}
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
                  <CodePanel chat={chat} selectedPath={path} onSelectPath={setPath} />
                ) : panel === 'diff' ? (
                  <VersionsPanel
                    chat={chat}
                    onViewVersion={(versionId) => {
                      setViewVersion(chat.id, versionId);
                      setPanel('preview');
                      toast.info('预览已切到该版本');
                    }}
                    onRollback={(versionId) => rollbackTo(chat.id, versionId)}
                    onShowDiffFile={(next) => {
                      setPath(next);
                      setPanel('code');
                    }}
                  />
                ) : panel === 'logs' ? (
                  <LogsPanel chat={chat} version={viewed} />
                ) : panel === 'settings' ? (
                  project ? (
                    <SettingsPanel project={project} />
                  ) : (
                    <DraftNotice
                      title="环境变量属于项目"
                      body="草稿还没有项目。先点右上角「创建项目」，之后就能在这里配置环境变量与发布地址。"
                    />
                  )
                ) : project ? (
                  <ArtifactPanel
                    project={project}
                    version={active}
                    onDeploy={() => setDeployOpen(true)}
                  />
                ) : (
                  <DraftNotice
                    title="产物属于项目"
                    body="草稿还没创建项目，所以没有发布记录。创建项目后，「发布」会把当前版本部署到固定地址。"
                  />
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
                <ProjectsPanel currentProjectId={project?.id ?? ''} onOpenProject={openProject} />
              )
            ) : view === 'skills' ? (
              <SkillsView mode="panel" onOpenChat={openChat} />
            ) : (
              <TemplatesPanel onOpenChat={openChat} />
            )}
          </div>
        )}
      </div>

      {project ? (
        <DeployDialog
          project={project}
          version={viewed}
          open={deployOpen}
          onOpenChange={setDeployOpen}
          onDeployed={handleDeployed}
        />
      ) : null}
    </div>
  );
}
