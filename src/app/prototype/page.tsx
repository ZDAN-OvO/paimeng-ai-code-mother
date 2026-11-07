'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { cn } from '@/lib/utils';
import { ModelSelect } from '@/prototype/components/model-select';
import { SiteThumb } from '@/prototype/components/site-thumb';
import { TemplateGallery } from '@/prototype/components/template-gallery';
import { ThemeToggle } from '@/prototype/components/theme-toggle';
import { MODELS, PROMPT_SUGGESTIONS, TEMPLATES, formatTime } from '@/prototype/mock-data';
import { usePrototype } from '@/prototype/store';
import type { DemoIntent, Project } from '@/prototype/types';
import { useVoiceInput } from '@/prototype/use-voice';

const SUGGESTION_ICONS = [Coffee, Terminal, Palette, Table2];
const SUGGESTION_LABELS = ['咖啡馆官网', '开发者工具落地页', '设计师作品集', '团队周报面板'];

export default function PrototypeHome() {
  const { intent, intentAt } = usePrototype();
  // 每条 HUD 演示意图都换一个实例，初始状态直接由意图决定，不用 effect 回填。
  return <HomeView key={intentAt} intent={intent} />;
}

function HomeView({ intent }: { intent: DemoIntent }) {
  const router = useRouter();
  const { state, createProject, clearIntent, deleteProject, pendingPrompt, setPendingPrompt } =
    usePrototype();
  const [prompt, setPrompt] = useState(() => {
    if (intent === 'prefill-prompt') return PROMPT_SUGGESTIONS[0];
    if (pendingPrompt) return pendingPrompt;
    return '';
  });
  const [templateId, setTemplateId] = useState('auto');
  const [modelId, setModelId] = useState(MODELS[0].id);
  const [offset, setOffset] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const templatesRef = useRef<HTMLDivElement>(null);

  const { listening, toggle: toggleVoice } = useVoiceInput((text) => {
    setPrompt((current) => (current.trim() ? `${current.replace(/\s+$/, '')} ${text}` : text));
    textareaRef.current?.focus();
  });

  useEffect(() => {
    if (pendingPrompt) setPendingPrompt(null);
  }, [pendingPrompt, setPendingPrompt]);

  useEffect(() => {
    if (intent === 'prefill-prompt') {
      textareaRef.current?.focus();
      toast.info('示例描述已填入', { description: '按 Enter 开始生成。' });
      clearIntent();
    }
    if (intent === 'open-template') {
      templatesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast.info('模板画廊在下面', { description: '点一张卡看整页，再决定要不要用它开始。' });
      clearIntent();
    }
  }, [clearIntent, intent]);

  const templateName = TEMPLATES.find((item) => item.id === templateId)?.name;
  const suggestions = PROMPT_SUGGESTIONS.map((_, index) => {
    const source = (index + offset) % PROMPT_SUGGESTIONS.length;
    return {
      text: PROMPT_SUGGESTIONS[source],
      label: SUGGESTION_LABELS[source],
      icon: SUGGESTION_ICONS[source],
    };
  });

  function submit() {
    const text = prompt.trim();
    if (!text) {
      textareaRef.current?.focus();
      return;
    }
    const { chatId } = createProject({ prompt: text, templateId, modelId });
    router.push(`/prototype/c/${chatId}`);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/80 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-5">
          <Link href="/prototype" className="flex items-center gap-2">
            <PaimengMark size={26} className="shrink-0" />
            <span className="text-[13.5px] font-semibold tracking-tight">Paimeng</span>
            <span className="rounded border border-border px-1 py-0.5 text-[9.5px] text-muted-foreground">
              前端原型
            </span>
          </Link>
          <nav className="ml-4 hidden items-center gap-4 text-[12.5px] text-muted-foreground sm:flex">
            <span className="text-foreground">项目</span>
            <Link href="/prototype/skills" className="transition-colors hover:text-foreground">
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
                    submit();
                  }
                }}
                placeholder="例如：做一个山间咖啡馆的官网，要有菜单、招牌豆子和门店信息，风格温暖一点。"
                className="min-h-28 resize-none border-0 bg-transparent px-3 py-3 text-[13.5px] leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
              <div className="mt-1 flex items-center gap-1.5 px-1 pb-1">
                <div className="rounded-md">
                  <ModelSelect value={modelId} onChange={setModelId} compact />
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
                    onClick={submit}
                    disabled={!prompt.trim()}
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
          </div>
        </section>

        <div ref={templatesRef}>
          <TemplateGallery
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
              {state.projects.length} 个 · 一个项目一个发布地址
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
            {state.projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => {
                  const chat =
                    state.chats
                      .filter((item) => item.projectId === project.id)
                      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
                  if (chat) router.push(`/prototype/c/${chat.id}`);
                }}
                onDelete={() => {
                  deleteProject(project.id);
                  toast.success(`已删除项目「${project.name}」`);
                }}
              />
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-4 text-[10.5px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <PaimengMark size={14} />
            Paimeng v0 · 前端原型
          </span>
          <span>·</span>
          <span>模拟数据，存在浏览器里</span>
          <Link href="/prototype/skills" className="ml-auto hover:text-foreground">
            技能面板
          </Link>
          <span>·</span>
          <span>接口契约见 src/prototype/README.md</span>
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
  project: Project;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { state } = usePrototype();
  const chats = state.chats.filter((chat) => chat.projectId === project.id);
  const versions = chats.reduce((total, chat) => total + chat.versions.length, 0);
  const version = chats
    .flatMap((chat) => chat.versions)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const deploy = project.deploys[0];

  return (
    <div className="group relative flex h-[92px] overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-sm">
      <button
        type="button"
        onClick={onOpen}
        className="block h-full w-32 shrink-0 overflow-hidden border-r border-border bg-[#faf7f2]"
      >
        {version ? (
          <SiteThumb site={version.site} className="h-full w-full" designWidth={460} />
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
          <span>{chats.length} 个对话</span>
          <span>·</span>
          <span>{versions} 个版本</span>
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
              onClick={() => window.open(`/prototype/p/${project.deployKey}`, '_blank')}
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
