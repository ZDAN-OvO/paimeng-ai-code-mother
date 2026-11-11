'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  FolderClosed,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api/client';
import { formatTime } from '@/lib/time';
import { useStoredValue, writeStored } from '@/lib/storage';
import { useIsMobile } from '@/lib/media';
import { cn } from '@/lib/utils';
import type {
  ArchivedChatsResponse,
  CreateProjectResponse,
  ProjectsResponse,
} from '@/shared/api/schemas';
import { AppSidebar } from '@/features/workspace/app-sidebar';
import { ChatHistoryPanel } from '@/features/workspace/chat-history-panel';
import { ProjectOverviewPanel } from '@/features/workspace/project-overview-panel';
import { ProjectsPanel } from '@/features/workspace/projects-panel';
import { TemplatesPanel } from '@/features/workspace/templates-panel';
import { SkillsView } from '@/features/skills/skills-view';
import { SiteThumb } from '@/features/preview/site-thumb';
import { ThemeToggle } from '@/features/theme/theme-toggle';
import type { WorkspaceView } from '@/features/workspace/types';

type ProjectRow = ProjectsResponse['projects'][number];

/**
 * 工作区空态：没有打开的对话时，这里负责新建/打开项目与最近项目。
 * 侧栏「项目 / 对话 / 技能 / 模板」在同一外壳里切换，不再有独立的展示首页。
 */
export default function HomeView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<WorkspaceView>('home');
  const [projectView, setProjectView] = useState<string | null>(null);
  const [chatFilter, setChatFilter] = useState<{ id: string; name: string } | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [archived, setArchived] = useState<ArchivedChatsResponse['chats']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'open' | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);

  const storedCollapsed = useStoredValue('paimeng.sidebar', 'open') === 'closed';
  const isMobile = useIsMobile();
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const collapsed = isMobile ? !mobileExpanded : storedCollapsed;

  const load = useCallback(async () => {
    try {
      const [projectList, archivedList] = await Promise.all([
        api.get<ProjectsResponse>('/api/projects'),
        api.get<ArchivedChatsResponse>('/api/chats?archived=1'),
      ]);
      setProjects(projectList.projects);
      setArchived(archivedList.chats);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : '项目列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 挂载时取一次项目列表；新建、删除、恢复后各自刷新。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (searchParams.get('new') === '1') openNewProject();
    // 只在进入带 ?new=1 的地址时打开一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function returnHome() {
    setView('home');
    setProjectView(null);
    setChatFilter(null);
    setMobileExpanded(false);
  }

  function openNewProject() {
    setMobileExpanded(false);
    setDialogError(null);
    setName('');
    setWorkspacePath('');
    setPrompt('');
    setDialog('new');
  }

  function openExisting() {
    setMobileExpanded(false);
    setDialogError(null);
    setWorkspacePath('');
    setDialog('open');
  }

  function openProject(projectId: string) {
    setView('projects');
    setProjectView(projectId);
  }

  function openChat(chatId: string) {
    router.push(`/chat/${chatId}`);
  }

  function resolveWorkspacePath(): string {
    const typed = workspacePath.trim();
    if (typed) return typed;
    const folder = name.trim() || 'example-site';
    return `~/Projects/${folder}`;
  }

  async function submitNew() {
    if (busy) return;
    setBusy(true);
    setDialogError(null);
    try {
      const created = await api.post<CreateProjectResponse>('/api/projects', {
        workspacePath: resolveWorkspacePath(),
        name: name.trim() || undefined,
        prompt: prompt.trim(),
      });
      setDialog(null);
      await load();
      toast.success('已新建示例项目', {
        description: '目录路径先记下来；现在还不能读写真实目录。',
      });
      router.push(`/chat/${created.chat.id}`);
    } catch (cause) {
      setDialogError(cause instanceof ApiRequestError ? cause.message : '新建项目失败，请重试');
      setBusy(false);
    }
  }

  async function submitOpen() {
    if (busy) return;
    const path = workspacePath.trim();
    if (!path) return;
    setBusy(true);
    setDialogError(null);
    try {
      await api.post('/api/projects/open', { workspacePath: path });
    } catch (cause) {
      setDialogError(cause instanceof ApiRequestError ? cause.message : '打开目录失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  async function removeProject(project: ProjectRow) {
    try {
      await api.delete(`/api/projects/${project.id}`);
      await load();
      if (projectView === project.id) setProjectView(null);
      toast.success(`已删除项目「${project.name}」`);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : '删除项目失败');
    }
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <AppSidebar
        collapsed={collapsed}
        onToggleCollapsed={() =>
          isMobile
            ? setMobileExpanded((value) => !value)
            : writeStored('paimeng.sidebar', storedCollapsed ? 'open' : 'closed')
        }
        overlay={isMobile}
        onHome={returnHome}
        project={null}
        chat={null}
        projects={projects}
        chats={[]}
        view={view}
        onViewChange={(next) => {
          setView(next);
          setMobileExpanded(false);
          setProjectView(null);
          if (next !== 'chats') setChatFilter(null);
        }}
        onSelectChat={openChat}
        onNewChat={openNewProject}
        onNewProject={openNewProject}
        onOpenProject={openProject}
        onRenameChat={() => {}}
        onArchiveChat={() => {}}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
          <span className="text-[13px] font-medium">本地工作区</span>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            项目在你的本地目录里，助手负责改代码、装依赖、检查与运行
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <button
              type="button"
              onClick={returnHome}
              className="flex size-6 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground"
              title="回到工作区"
            >
              本
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          {view === 'home' ? (
            <HomeEmptyState
              projects={projects}
              loading={loading}
              error={error}
              onNew={openNewProject}
              onOpen={openExisting}
              onOpenProject={openProject}
              onRemove={removeProject}
              onShowTemplates={() => setView('templates')}
            />
          ) : view === 'projects' ? (
            projectView ? (
              <ProjectOverviewPanel
                projectId={projectView}
                onOpenChat={openChat}
                onOpenChatList={() => {
                  const overview = projects.find((item) => item.id === projectView);
                  setChatFilter(overview ? { id: overview.id, name: overview.name } : null);
                  setView('chats');
                }}
                onRename={async (next) => {
                  try {
                    await api.patch(`/api/projects/${projectView}`, { name: next });
                    await load();
                    toast.success('项目已重命名');
                  } catch (cause) {
                    toast.error(cause instanceof Error ? cause.message : '重命名失败');
                  }
                }}
                onOpenSettings={(chatId) => openChat(chatId)}
                onNewChat={async () => {
                  try {
                    const created = await api.post<{ id: string }>(
                      `/api/projects/${projectView}/chats`,
                      {},
                    );
                    openChat(created.id);
                  } catch (cause) {
                    toast.error(cause instanceof Error ? cause.message : '新建对话失败');
                  }
                }}
              />
            ) : (
              <ProjectsPanel currentProjectId="" onOpenProject={openProject} />
            )
          ) : view === 'chats' ? (
            <ChatHistoryPanel
              currentChatId=""
              archived={archived}
              projectFilter={chatFilter}
              onOpenChat={openChat}
              onClearFilter={() => setChatFilter(null)}
              onRestore={async (chatId) => {
                try {
                  await api.post(`/api/chats/${chatId}/restore`, {});
                  await load();
                  toast.success('已恢复到列表');
                } catch (cause) {
                  toast.error(cause instanceof Error ? cause.message : '恢复失败');
                }
              }}
            />
          ) : view === 'skills' ? (
            <SkillsView mode="panel" onOpenChat={openChat} />
          ) : (
            <TemplatesPanel
              onOpenChat={openChat}
              onCreated={() => {
                void load();
              }}
            />
          )}
        </div>
      </div>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dialog === 'open' ? '打开已有目录' : '新建项目'}</DialogTitle>
            <DialogDescription>
              {dialog === 'open'
                ? '项目对应一个真实的本地目录；现在还不能打开本地目录，可以先体验示例项目。'
                : '项目会对应一个本地目录。这里先建一个示例项目，目录内容不会真的写入磁盘。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {dialog === 'new' ? (
              <>
                <label className="block space-y-1">
                  <span className="text-[11.5px] text-muted-foreground">项目名称（可选）</span>
                  <Input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="山间咖啡馆官网"
                    className="h-9 text-[12.5px]"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11.5px] text-muted-foreground">项目目录</span>
                  <Input
                    value={workspacePath}
                    onChange={(event) => setWorkspacePath(event.target.value)}
                    placeholder={name.trim() ? `~/Projects/${name.trim()}` : '~/Projects/my-site'}
                    className="h-9 font-mono text-[12px]"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11.5px] text-muted-foreground">
                    想做什么（可选，作为第一条对话的起点）
                  </span>
                  <Input
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="做一个山间咖啡馆的官网，风格温暖一点"
                    className="h-9 text-[12.5px]"
                  />
                </label>
              </>
            ) : (
              <label className="block space-y-1">
                <span className="text-[11.5px] text-muted-foreground">目录路径</span>
                <Input
                  autoFocus
                  value={workspacePath}
                  onChange={(event) => setWorkspacePath(event.target.value)}
                  placeholder="~/Projects/existing-site"
                  className="h-9 font-mono text-[12px]"
                />
              </label>
            )}

            {dialogError ? (
              <p
                data-testid="dialog-error"
                className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11.5px] leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
              >
                {dialogError}
              </p>
            ) : null}

            {dialog === 'open' ? (
              <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">
                现在还不能打开本地目录；可以先从模板或「新建项目」体验示例项目。
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialog(null)}>
              取消
            </Button>
            {dialog === 'new' ? (
              <Button size="sm" data-testid="create-project" disabled={busy} onClick={submitNew}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                新建示例项目
              </Button>
            ) : (
              <Button
                size="sm"
                data-testid="open-project"
                disabled={busy || !workspacePath.trim()}
                onClick={submitOpen}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                打开目录
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HomeEmptyState({
  projects,
  loading,
  error,
  onNew,
  onOpen,
  onOpenProject,
  onRemove,
  onShowTemplates,
}: {
  projects: ProjectRow[];
  loading: boolean;
  error: string | null;
  onNew: () => void;
  onOpen: () => void;
  onOpenProject: (projectId: string) => void;
  onRemove: (project: ProjectRow) => void;
  onShowTemplates: () => void;
}) {
  const recent = projects.slice(0, 3);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-14">
        <section className="text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground">
            <Sparkles className="size-3 text-amber-600" />
            本地项目 · 对话改代码 · 改动可撤销
          </span>
          <h1 className="mt-5 text-[26px] leading-tight font-semibold tracking-tight sm:text-[32px]">
            从本地项目开始
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[12.5px] leading-6 text-muted-foreground">
            新建一个项目，或打开已有的本地目录。用一句话说明要改什么，助手直接修改项目文件；每一轮改动都能查看
            diff 并撤销。
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <Button data-testid="new-project" size="sm" className="h-8 gap-1.5" onClick={onNew}>
              <Plus className="size-3.5" />
              新建项目
            </Button>
            <Button
              data-testid="open-folder"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={onOpen}
            >
              <FolderOpen className="size-3.5" />
              打开已有目录
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-muted-foreground"
              onClick={onShowTemplates}
            >
              从模板开始
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
          <p className="mt-3 text-[10.5px] text-muted-foreground/80">
            示例项目不会读写真实目录；尚不能打开本地目录，可以先体验示例项目。
          </p>
        </section>

        <section>
          <div className="flex items-baseline gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">最近项目</h2>
            <span className="text-[11px] text-muted-foreground">
              {loading ? '正在读取…' : `${projects.length} 个`}
            </span>
            <Link
              href="/?new=1"
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.preventDefault();
                onNew();
              }}
            >
              新建项目 ↑
            </Link>
          </div>

          {error ? <p className="mt-3 text-[11.5px] text-red-600">{error}</p> : null}
          {loading ? (
            <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在读取项目…
            </p>
          ) : recent.length === 0 ? (
            <div
              data-testid="empty-projects"
              className="mt-3 rounded-xl border border-dashed border-border bg-card/60 px-4 py-8 text-center"
            >
              <p className="text-[12.5px] font-medium">还没有项目</p>
              <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
                新建一个示例项目，或从模板开始；尚不能打开本地目录。
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {recent.map((project) => (
                <div
                  key={project.id}
                  className="group flex items-center gap-3 rounded-xl border border-border bg-card p-2 transition-shadow hover:shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => onOpenProject(project.id)}
                    className="h-14 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-[#faf7f2]"
                    title="打开项目"
                  >
                    {project.thumb ? (
                      <SiteThumb site={project.thumb} className="h-full w-full" designWidth={320} />
                    ) : (
                      <span className="flex h-full items-center justify-center text-[9.5px] text-stone-400">
                        无预览
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    data-testid={`recent-${project.id}`}
                    onClick={() => onOpenProject(project.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-medium">{project.name}</span>
                      {project.workspaceState === 'sample' ? (
                        <span className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1 py-px text-[9px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                          示例
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
                      <FolderClosed className="size-2.5 shrink-0" />
                      <span className="truncate">{project.workspacePath}</span>
                    </span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground/80">
                      {project.chatCount} 个对话 · {project.changeCount} 条改动记录 ·{' '}
                      {formatTime(project.updatedAt)}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100">
                      <MoreHorizontal className="size-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        className="text-[12.5px]"
                        onClick={() => onOpenProject(project.id)}
                      >
                        打开项目
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={cn('gap-1.5 text-[12.5px] text-red-600')}
                        onClick={() => onRemove(project)}
                      >
                        <Trash2 className="size-3.5" />
                        删除项目
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
