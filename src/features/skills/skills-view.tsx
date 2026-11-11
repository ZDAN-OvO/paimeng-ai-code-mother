'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import type {
  ProjectsResponse,
  ProjectSummary,
  Skill,
  SkillCatalog,
  SkillDetail,
} from '@/shared/api/schemas';
import {
  projectsResponseSchema,
  skillCatalogSchema,
  skillDetailSchema,
} from '@/shared/api/schemas';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileContent(item: unknown): item is { path: string; content: string } {
  return isRecord(item) && typeof item.path === 'string' && typeof item.content === 'string';
}

function pickCatalog(payload: unknown): SkillCatalog | null {
  const direct = skillCatalogSchema.safeParse(payload);
  if (direct.success) return direct.data;
  if (isRecord(payload)) {
    const wrapped = skillCatalogSchema.safeParse(payload.catalog);
    if (wrapped.success) return wrapped.data;
  }
  return null;
}

function pickFileContent(payload: unknown, path: string): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.content === 'string') return payload.content;
  if (isRecord(payload.file) && typeof payload.file.content === 'string') {
    return payload.file.content;
  }
  if (Array.isArray(payload.files)) {
    const files = payload.files.filter(isFileContent);
    const matched =
      files.find((item) => item.path === path || path.endsWith(`/${item.path}`)) ??
      files.find((item) => item.path === 'SKILL.md');
    if (matched) return matched.content;
  }
  return null;
}

async function fetchSkillText(
  skill: Skill,
  projectId: string | null,
  signal: AbortSignal,
): Promise<string | null> {
  const name = encodeURIComponent(skill.name);
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const detail = await api.get<SkillDetail>(`/api/skills/${name}${query}`, skillDetailSchema, {
    signal,
  });
  return pickFileContent(detail, skill.filePath);
}

function SkillRow({
  skill,
  projectId,
  open,
  onToggle,
}: {
  skill: Skill;
  projectId: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    // 打开技能时开始读取正文；这里同步进入加载态，避免先显示上一份正文。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    void fetchSkillText(skill, projectId, controller.signal)
      .then((text) => {
        if (controller.signal.aborted) return;
        if (text === null) {
          setError('暂时无法读取这个技能正文。');
          setContent(null);
        } else {
          setContent(text);
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, projectId, skill]);

  return (
    <div className="border-t border-border first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      >
        <span className="mt-0.5 text-muted-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
        <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium">{skill.name}</span>
            {skill.disableModelInvocation ? (
              <Badge variant="outline" className="h-4 px-1 text-[9px]">
                仅显式调用
              </Badge>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">
            {skill.description || '没有说明'}
          </span>
        </span>
      </button>
      {open ? (
        <div className="px-3 pb-3 pl-10">
          <p className="flex items-start gap-1 break-all font-mono text-[10px] text-muted-foreground">
            <FolderOpen className="mt-0.5 size-3 shrink-0" />
            {skill.filePath}
          </p>
          {loading ? (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              正在读取正文…
            </div>
          ) : error ? (
            <p className="mt-2 flex items-start gap-1.5 break-words text-[11px] text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : content !== null ? (
            <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-5 whitespace-pre-wrap break-words">
              {content}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SkillSection({
  title,
  directory,
  skills,
  projectId,
  emptyText,
  openKey,
  onToggle,
}: {
  title: string;
  directory: string | null;
  skills: Skill[];
  projectId: string | null;
  emptyText: string;
  openKey: string | null;
  onToggle: (key: string) => void;
}) {
  return (
    <section>
      <div className="mb-2">
        <h2 className="text-xs font-semibold">{title}</h2>
        <p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">
          {directory ?? '没有可用的项目目录'}
        </p>
      </div>
      {skills.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-[11px] text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {skills.map((skill) => {
            const key = `${skill.source}:${skill.filePath}`;
            return (
              <SkillRow
                key={key}
                skill={skill}
                projectId={projectId}
                open={openKey === key}
                onToggle={() => onToggle(key)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

export function SkillsView() {
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(searchParams.get('projectId'));
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    void api
      .get<ProjectsResponse>('/api/projects', projectsResponseSchema)
      .then((data) => setProjects(data.projects))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const result = await api.get<unknown>(`/api/skills${query}`);
      if (requestRef.current !== requestId) return;
      const next = pickCatalog(result);
      if (!next) throw new Error('技能目录格式不正确。');
      setCatalog(next);
    } catch (cause) {
      if (requestRef.current !== requestId) return;
      setError(errorMessage(cause));
      setCatalog(null);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const userSkills = catalog?.skills.filter((skill) => skill.source === 'user') ?? [];
  const projectSkills = catalog?.skills.filter((skill) => skill.source === 'project') ?? [];
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;

  return (
    <div className="min-h-dvh overflow-x-hidden bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-2 px-4 sm:px-6">
          <Button variant="ghost" size="icon" className="size-8" asChild title="返回首页">
            <Link href="/">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <Sparkles className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">技能</span>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            磁盘上的技能文件
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
        <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0">
              <h1 className="text-sm font-semibold">磁盘技能</h1>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                技能不会自动注入当前对话。这里只展示用户目录和项目目录中发现的技能及其正文。
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Select
                value={projectId ?? 'none'}
                onValueChange={(value) => {
                  setProjectId(value === 'none' ? null : value);
                  setOpenKey(null);
                }}
              >
                <SelectTrigger size="sm" className="max-w-52 text-[11px]">
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不选择项目</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[11px]"
                onClick={() => void load()}
              >
                刷新
              </Button>
            </div>
          </div>
          {selectedProject ? (
            <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
              项目目录：{selectedProject.workspacePath}
            </p>
          ) : null}
        </div>

        {loading ? (
          <div className="mt-6 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在读取技能…
          </div>
        ) : error ? (
          <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[11px] text-destructive">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="size-3.5" />
              读取技能失败
            </div>
            <p className="mt-1 break-words">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-[11px]"
              onClick={() => void load()}
            >
              重试
            </Button>
          </div>
        ) : catalog ? (
          <div className="mt-6 space-y-6">
            {catalog.diagnostics.length > 0 ? (
              <div className="space-y-1.5">
                {catalog.diagnostics.map((diagnostic, index) => (
                  <div
                    key={`${diagnostic.path}-${index}`}
                    className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[10px] leading-4 text-amber-800 dark:text-amber-300"
                  >
                    <p className="break-words">{diagnostic.message}</p>
                    <p className="mt-0.5 break-all font-mono opacity-80">{diagnostic.path}</p>
                  </div>
                ))}
              </div>
            ) : null}

            <SkillSection
              title="用户技能"
              directory={catalog.directories.user}
              skills={userSkills}
              projectId={projectId}
              emptyText="用户目录里还没有发现技能。"
              openKey={openKey}
              onToggle={(key) => setOpenKey((current) => (current === key ? null : key))}
            />
            <SkillSection
              title="项目技能"
              directory={catalog.directories.project}
              skills={projectSkills}
              projectId={projectId}
              emptyText={
                projectId ? '这个项目里还没有发现技能。' : '选择一个项目后可以查看项目级技能。'
              }
              openKey={openKey}
              onToggle={(key) => setOpenKey((current) => (current === key ? null : key))}
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
