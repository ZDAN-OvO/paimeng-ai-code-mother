'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowUp,
  Coffee,
  Layers,
  Mic,
  MoreHorizontal,
  Palette,
  RefreshCw,
  Rocket,
  Sparkles,
  Table2,
  Terminal,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { PaimengMark } from '@/components/brand/paimeng-mark';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiRequestError } from '@/lib/api/client';
import { formatTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import type {
  CreateProjectResponse,
  GalleryTemplate,
  Model,
  ModelsResponse,
  ProjectsResponse,
  Template,
  TemplatesResponse,
} from '@/shared/api/schemas';
import { useVoiceInput } from '@/features/chat/use-voice';
import { ModelSelect } from '@/features/home/model-select';
import { TemplateGallery } from '@/features/home/template-gallery';
import { SiteThumb } from '@/features/preview/site-thumb';
import { ThemeToggle } from '@/features/theme/theme-toggle';

type ProjectRow = ProjectsResponse['projects'][number];

const SUGGESTION_ICONS = [Coffee, Terminal, Palette, Table2];
const SUGGESTION_LABELS = ['咖啡馆官网', '开发者工具落地页', '设计师作品集', '团队周报面板'];
const PROMPT_SUGGESTIONS = [
  '做一个山间咖啡馆的官网，要有菜单、豆子介绍和门店信息',
  '做一个开发者工具的落地页，讲清三个核心能力和定价',
  '做一个设计师作品集，只放四个精选项目',
  '做一个团队周报面板，能按成员筛选',
];

export default function HomeView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [prompt, setPrompt] = useState(() => searchParams.get('draft') ?? '');
  const [templateId, setTemplateId] = useState('auto');
  const [modelId, setModelId] = useState('');
  const [offset, setOffset] = useState(0);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [gallery, setGallery] = useState<GalleryTemplate[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const templatesRef = useRef<HTMLDivElement>(null);

  const { listening, toggle: toggleVoice } = useVoiceInput((text) => {
    setPrompt((current) => (current.trim() ? `${current.replace(/\s+$/, '')} ${text}` : text));
    textareaRef.current?.focus();
  });

  const loadProjects = useCallback(async () => {
    const data = await api.get<ProjectsResponse>('/api/projects');
    setProjects(data.projects);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [projectList, catalog, modelList] = await Promise.all([
          api.get<ProjectsResponse>('/api/projects'),
          api.get<TemplatesResponse>('/api/templates'),
          api.get<ModelsResponse>('/api/models'),
        ]);
        if (cancelled) return;
        setProjects(projectList.projects);
        setTemplates(catalog.templates);
        setGallery(catalog.gallery);
        setModels(modelList.models);
        setModelId((current) => current || modelList.models[0]?.id || '');
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof ApiRequestError ? cause.message : '目录加载失败，请刷新重试');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const templateName = templates.find((item) => item.id === templateId)?.name;
  const suggestions = PROMPT_SUGGESTIONS.map((_, index) => {
    const source = (index + offset) % PROMPT_SUGGESTIONS.length;
    return {
      text: PROMPT_SUGGESTIONS[source],
      label: SUGGESTION_LABELS[source],
      icon: SUGGESTION_ICONS[source],
    };
  });

  async function submit() {
    const text = prompt.trim();
    if (!text || creating || !modelId) {
      textareaRef.current?.focus();
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await api.post<CreateProjectResponse>('/api/projects', {
        prompt: text,
        templateId,
        modelId,
      });
      router.push(`/chat/${created.chat.id}`);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : '创建项目失败，请重试');
      setCreating(false);
    }
  }

  async function removeProject(project: ProjectRow) {
    try {
      await api.delete(`/api/projects/${project.id}`);
      await loadProjects();
      toast.success(`已删除项目「${project.name}」`);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : '删除项目失败');
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/80 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-5">
          <Link href="/" className="flex items-center gap-2">
            <PaimengMark size={26} className="shrink-0" />
            <span className="text-[13.5px] font-semibold tracking-tight">Paimeng</span>
          </Link>
          <nav className="ml-4 hidden items-center gap-4 text-[12.5px] text-muted-foreground sm:flex">
            <span className="text-foreground">项目</span>
            <Link href="/skills" className="transition-colors hover:text-foreground">
              技能
            </Link>
            <button
              type="button"
              onClick={() =>
                document.getElementById('templates')?.scrollIntoView({ behavior: 'smooth' })
              }
              className="transition-colors hover:text-foreground"
            >
              模板
            </button>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-[11px] text-muted-foreground md:inline">
              本地 · 单用户
            </span>
            <ThemeToggle />
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
              本
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-24">
        <section className="flex flex-col items-center pt-16 pb-4 text-center sm:pt-24">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground">
            <Sparkles className="size-3 text-amber-600" />
            生成完整 Next.js 项目 · 沙箱预览 · 版本回滚
          </span>
          <h1 className="mt-6 text-[34px] leading-tight font-semibold tracking-tight sm:text-[44px]">
            想做点什么？
          </h1>
          <p className="mt-3 max-w-md text-[13px] leading-6 text-muted-foreground">
            一句话描述你要的应用，拿到一个能跑、能改、能发布的版本。
          </p>

          <div className="mt-8 w-full max-w-2xl text-left">
            <div className="rounded-2xl border border-border bg-card p-2 shadow-sm transition-colors focus-within:border-foreground/30">
              <Textarea
                ref={textareaRef}
                data-testid="prompt-input"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                placeholder="例如：做一个山间咖啡馆的官网，要有菜单、招牌豆子和门店信息，风格温暖一点。"
                className="min-h-28 resize-none border-0 bg-transparent px-3 py-3 text-[13.5px] leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
              <div className="mt-1 flex items-center gap-1.5 px-1 pb-1">
                <div className="rounded-md">
                  <ModelSelect models={models} value={modelId} onChange={setModelId} compact />
                </div>
                {templateId !== 'auto' && templateName ? (
                  <button
                    type="button"
                    onClick={() => setTemplateId('auto')}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10.5px] text-muted-foreground hover:text-foreground"
                    title="清除已选模板"
                  >
                    <Layers className="size-3" />
                    {templateName}
                  </button>
                ) : null}
                <span className="ml-1 hidden text-[10.5px] text-muted-foreground/70 sm:inline">
                  Enter 生成 · Shift + Enter 换行
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="voice-input"
                    onClick={toggleVoice}
                    title="语音输入"
                    className={cn(
                      'flex size-8 items-center justify-center rounded-full transition-colors',
                      listening
                        ? 'bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Mic className={cn('size-4', listening && 'animate-pulse')} />
                  </button>
                  <Button
                    data-testid="prompt-submit"
                    size="icon"
                    className="size-8 rounded-full"
                    onClick={() => void submit()}
                    disabled={!prompt.trim() || creating}
                    title="生成"
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {suggestions.map((suggestion) => {
                const Icon = suggestion.icon;
                return (
                  <button
                    key={suggestion.text}
                    type="button"
                    onClick={() => {
                      setPrompt(suggestion.text);
                      textareaRef.current?.focus();
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  >
                    <Icon className="size-3" />
                    {suggestion.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setOffset((value) => value + 1)}
                title="换一组提示"
                className="flex size-6 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:text-foreground"
              >
                <RefreshCw className="size-3" />
              </button>
            </div>
            {error ? <p className="mt-2 text-[11.5px] text-red-600">{error}</p> : null}
          </div>
        </section>

        <div ref={templatesRef}>
          <TemplateGallery
            entries={gallery}
            onUse={(entry) => {
              setPrompt(entry.prompt);
              setTemplateId(entry.templateId);
              textareaRef.current?.focus();
              toast.success(`已选模板：${entry.name}`, {
                description: '描述已经填好，可以直接生成，也可以接着改。',
              });
            }}
          />
        </div>

        <section className="pt-14">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight">最近项目</h2>
            <span className="text-[11px] text-muted-foreground">
              {projects.length} 个 · 一个项目一个发布地址
            </span>
            <button
              type="button"
              onClick={() => {
                textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                window.setTimeout(() => textareaRef.current?.focus(), 300);
              }}
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
            >
              从一句话开始 ↑
            </button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => {
                  if (project.lastChatId) router.push(`/chat/${project.lastChatId}`);
                }}
                onDelete={() => void removeProject(project)}
              />
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-4 text-[10.5px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <PaimengMark size={14} />
            Paimeng v0
          </span>
          <span>·</span>
          <span>开源 · 自托管 · 单用户</span>
          <Link href="/skills" className="ml-auto hover:text-foreground">
            技能
          </Link>
        </div>
      </footer>
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
  onDelete,
}: {
  project: ProjectRow;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const deploy = project.deploys[0];

  return (
    <div className="group relative flex h-[92px] overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-sm">
      <button
        type="button"
        onClick={onOpen}
        className="block h-full w-32 shrink-0 overflow-hidden border-r border-border bg-[#faf7f2]"
      >
        {project.thumb ? (
          <SiteThumb site={project.thumb} className="h-full w-full" designWidth={460} />
        ) : (
          <span className="flex h-full items-center justify-center text-[10px] text-stone-400">
            无预览
          </span>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col justify-center px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid={`project-${project.id}`}
            onClick={onOpen}
            className="truncate text-[12.5px] font-medium hover:underline"
          >
            {project.name}
          </button>
          {deploy ? (
            <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
              v{deploy.versionSeq} 已发布
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{project.chatCount} 个对话</span>
          <span>·</span>
          <span>{project.versionCount} 个版本</span>
          <span>·</span>
          <span>{formatTime(project.updatedAt)}</span>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger className="mr-1 self-start rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted">
          <MoreHorizontal className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={onOpen} className="text-[12.5px]">
            打开项目
          </DropdownMenuItem>
          {project.deployKey ? (
            <DropdownMenuItem
              onClick={() => window.open(`/deploys/${project.deployKey}`, '_blank')}
              className="gap-1.5 text-[12.5px]"
            >
              <Rocket className="size-3.5" />
              打开发布地址
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onDelete} className="gap-1.5 text-[12.5px] text-red-600">
            <Trash2 className="size-3.5" />
            删除项目
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
