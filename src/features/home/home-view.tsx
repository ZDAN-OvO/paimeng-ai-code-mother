'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, ArrowRight, ChevronRight, FolderOpen, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TemplateGallery } from '@/features/home/template-gallery';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/time';
import type {
  ChatSummary,
  GalleryTemplate,
  Model,
  OpenProjectResponse,
  ProjectSummary,
  ProjectsResponse,
  TemplatesResponse,
} from '@/shared/api/schemas';
import {
  modelsResponseSchema,
  openProjectResponseSchema,
  projectsResponseSchema,
  templatesResponseSchema,
} from '@/shared/api/schemas';

export function HomeView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [workspacePath, setWorkspacePath] = useState('');
  const [opening, setOpening] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [gallery, setGallery] = useState<GalleryTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get('open') !== '1') return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<ProjectsResponse>('/api/projects', projectsResponseSchema)
      .then((data) => {
        if (!cancelled) setProjects(data.projects);
      })
      .catch((cause) => {
        if (!cancelled) setProjectsError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setProjectsLoading(false);
      });
    void api
      .get<{ models: Model[] }>('/api/models', modelsResponseSchema)
      .then((data) => {
        if (!cancelled) setModels(data.models);
      })
      .catch((cause) => {
        if (!cancelled) setModelsError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    void api
      .get<TemplatesResponse>('/api/templates', templatesResponseSchema)
      .then((data) => {
        if (!cancelled) setGallery(data.gallery);
      })
      .catch((cause) => {
        if (!cancelled) setTemplatesError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function openDirectory() {
    const path = workspacePath.trim();
    if (!path || opening) {
      if (!path) setError('请输入本地目录的绝对路径。');
      return;
    }
    setOpening(true);
    setError(null);
    try {
      const result = await api.post<OpenProjectResponse>(
        '/api/projects/open',
        { workspacePath: path },
        openProjectResponseSchema,
      );
      let chatId = result.chats[0]?.id;
      if (!chatId) {
        const chat = await api.post<ChatSummary>(`/api/projects/${result.project.id}/chats`, {});
        chatId = chat.id;
      }
      router.push(`/chat/${chatId}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOpening(false);
    }
  }

  async function openProject(project: ProjectSummary) {
    if (openingProjectId) return;
    setOpeningProjectId(project.id);
    setError(null);
    try {
      let chatId = project.lastChatId;
      if (!chatId) {
        const chat = await api.post<ChatSummary>(`/api/projects/${project.id}/chats`, {});
        chatId = chat.id;
      }
      router.push(`/chat/${chatId}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOpeningProjectId(null);
    }
  }

  const noConfiguredModel =
    !modelsLoading && !modelsError && !models.some((model) => model.configured);

  return (
    <div className="min-h-dvh overflow-x-hidden bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-foreground text-xs font-semibold text-background">
              PM
            </span>
            <span className="text-sm font-semibold">派蒙</span>
          </Link>
          <span className="text-[11px] text-muted-foreground">本地开发助手</span>
          <Button variant="ghost" size="sm" className="ml-auto gap-1.5 text-xs" asChild>
            <Link href="/skills">
              <Sparkles className="size-3.5" />
              技能
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 pb-20 sm:px-6">
        <section className="pt-12 sm:pt-16">
          <p className="text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
            本地目录 · 真实文件
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            打开目录，让助手直接改代码
          </h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-6 text-muted-foreground">
            助手会读取这个目录里的文件，按你的要求修改，并把每一轮改动记下来。你可以在工作区查看文件、比较改动，并按文件恢复。
          </p>

          {modelsError ? (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[11px] leading-5 text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <p className="break-words">读取模型配置失败：{modelsError}</p>
            </div>
          ) : noConfiguredModel ? (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-5 text-amber-800 dark:text-amber-300">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <p>
                尚未配置模型。请在没有提交到版本库的 <span className="font-mono">.env</span> 中设置{' '}
                <span className="font-mono">AI_BASE_URL</span>、
                <span className="font-mono">AI_MODEL</span> 和{' '}
                <span className="font-mono">AI_API_KEY</span>，然后重启服务。
              </p>
            </div>
          ) : null}

          <div className="mt-6 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
            <label htmlFor="workspace-path" className="text-xs font-medium">
              本地目录路径
            </label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <FolderOpen className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="workspace-path"
                  ref={inputRef}
                  value={workspacePath}
                  onChange={(event) => {
                    setWorkspacePath(event.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void openDirectory();
                    }
                  }}
                  placeholder="输入已存在的目录绝对路径"
                  className="h-10 pl-9 font-mono text-xs"
                  disabled={opening}
                  spellCheck={false}
                />
              </div>
              <Button
                className="h-10 shrink-0 gap-1.5 px-4"
                disabled={opening || !workspacePath.trim()}
                onClick={() => void openDirectory()}
              >
                {opening ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FolderOpen className="size-4" />
                )}
                {opening ? '正在打开…' : '打开目录'}
              </Button>
            </div>
            <p className="mt-2 text-[10.5px] leading-5 text-muted-foreground">
              目录必须已经存在于本机。助手只会在该目录内读取和修改文件；需要确认的命令会暂停等待你批准。
            </p>
            {error ? (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] leading-5 text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <p className="break-words">{error}</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="pt-10">
          <div className="flex items-end gap-2">
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight">最近打开</h2>
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                继续已有对话，或为项目新建一轮。
              </p>
            </div>
          </div>

          <div className="mt-3 overflow-hidden rounded-xl border border-border">
            {projectsLoading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-[11px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在读取项目…
              </div>
            ) : projectsError ? (
              <div className="flex items-start gap-2 px-3 py-4 text-[11px] leading-5 text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <p className="break-words">读取项目失败：{projectsError}</p>
              </div>
            ) : projects.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-xs font-medium">还没有打开过目录</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  在上面的输入框填写本地目录路径，打开后会出现在这里。
                </p>
              </div>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => void openProject(project)}
                  disabled={openingProjectId !== null}
                  className="flex w-full items-center gap-2.5 border-t border-border px-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-muted/50 disabled:opacity-60"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-[11px] font-semibold">
                    {project.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{project.name}</span>
                      {openingProjectId === project.id ? (
                        <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                      {project.workspacePath}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-right text-[10px] text-muted-foreground sm:block">
                    {project.chatCount} 对话 · {project.changeCount} 处改动
                    <span className="mt-0.5 block">{formatTime(project.updatedAt)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                    {project.lastChatId ? '继续对话' : '新建对话'}
                    <ChevronRight className="size-3.5" />
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        {templatesError ? (
          <p className="pt-8 text-[11px] text-muted-foreground">
            模板暂时无法加载：{templatesError}
          </p>
        ) : gallery.length > 0 ? (
          <TemplateGallery entries={gallery} />
        ) : null}

        <section className="mt-12 rounded-xl border border-border bg-muted/20 px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <p className="text-xs font-medium">技能</p>
            <Button variant="ghost" size="sm" className="ml-auto gap-1 text-[11px]" asChild>
              <Link href="/skills">
                查看磁盘技能
                <ArrowRight className="size-3" />
              </Link>
            </Button>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
            技能页展示用户目录与项目目录中的技能文件和正文；当前对话不会自动注入技能。
          </p>
        </section>
      </main>
    </div>
  );
}

export default HomeView;
