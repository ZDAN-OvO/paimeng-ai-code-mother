'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api/client';
import { formatTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { SiteThumb } from '@/features/preview/site-thumb';
import type { ProjectsResponse } from '@/shared/api/schemas';

type ProjectRow = ProjectsResponse['projects'][number];

/** 「项目」入口：不跳页，直接在中栏列项目。 */
export function ProjectsPanel({
  currentProjectId,
  onOpenProject,
}: {
  currentProjectId: string;
  onOpenProject: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<ProjectsResponse>('/api/projects');
      setProjects(data.projects);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : '项目列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 挂载时取一次项目列表；之后由新建/删除操作各自刷新。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30">
      <div className="flex items-center gap-3 border-b border-border bg-card px-5 py-3">
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-semibold tracking-tight">项目</h2>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {loading ? '正在读取项目…' : `${projects.length} 个项目，一个项目一个发布地址。`}
          </p>
        </div>
        <Button size="sm" className="ml-auto h-7 gap-1 px-2.5 text-[11.5px]" asChild>
          <Link href="/">
            <Plus className="size-3.5" />
            新建项目
          </Link>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在读取项目…
          </p>
        ) : error ? (
          <p className="text-[12px] text-red-600">{error}</p>
        ) : (
          <div className="mx-auto grid max-w-4xl gap-3 sm:grid-cols-2">
            {projects.map((project) => {
              const deployed = project.deploys.find((deploy) => deploy.state === 'ready');
              return (
                <button
                  key={project.id}
                  type="button"
                  data-testid={`project-${project.id}`}
                  onClick={() => onOpenProject(project.id)}
                  className={cn(
                    'group overflow-hidden rounded-xl border bg-card text-left transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md',
                    project.id === currentProjectId ? 'border-foreground/25' : 'border-border',
                  )}
                >
                  <div className="relative aspect-[16/9] overflow-hidden border-b border-border bg-[#faf7f2]">
                    {project.thumb ? (
                      <SiteThumb
                        site={project.thumb}
                        className="absolute inset-0"
                        designWidth={900}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
                        还没有版本
                      </div>
                    )}
                  </div>
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                        {project.name}
                      </span>
                      {deployed ? (
                        <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9.5px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                          <Rocket className="size-2.5" />
                          {deployed.deployKey}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                      {project.prompt}
                    </p>
                    <p className="mt-1 text-[10.5px] text-muted-foreground/80">
                      {project.chatCount} 个会话 · {project.versionCount} 个版本 ·{' '}
                      {formatTime(project.updatedAt)}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
