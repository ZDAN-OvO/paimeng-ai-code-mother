'use client';

import { useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import type { LocalSkill, SkillCatalog } from '@/shared/api/schemas';
import { api } from '@/lib/api/client';

export function LocalSkills({ catalog, projectId }: { catalog: SkillCatalog; projectId?: string }) {
  return (
    <section className="mt-6 space-y-3" data-testid="local-skills">
      <div>
        <h2 className="text-[13px] font-semibold">本地技能</h2>
        <p className="mt-1 break-all text-[11px] leading-5 text-muted-foreground">
          用户级：{catalog.directories.user}
          <br />
          项目级：{catalog.directories.project ?? '打开真实本地项目后读取'}
        </p>
      </div>
      {catalog.diagnostics.map((diagnostic, index) => (
        <p
          key={`${diagnostic.path}-${index}`}
          role="status"
          className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 break-all text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          {diagnostic.message}
          <br />
          {diagnostic.path}
        </p>
      ))}
      {catalog.skills.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-5 text-xs text-muted-foreground">
          还没有发现本地技能。把技能目录放到上方位置后刷新即可。
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {catalog.skills.map((skill) => (
            <LocalSkillRow
              key={`${skill.source}:${skill.filePath}`}
              skill={skill}
              projectId={projectId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function LocalSkillRow({ skill, projectId }: { skill: LocalSkill; projectId?: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || loading) return;
    setLoading(true);
    setError(null);
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const result = await api.get<{ content: string }>(
        `/api/skills/${encodeURIComponent(skill.name)}/files${query}`,
      );
      setContent(result.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取技能失败');
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-3 text-left"
        data-testid={`local-skill-${skill.name}`}
      >
        <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-xs font-medium">
            {skill.name}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
              {skill.source === 'user' ? '用户级' : '项目级'}
            </span>
            {skill.disableModelInvocation ? (
              <span className="text-[10px] font-normal text-muted-foreground">仅显式调用</span>
            ) : null}
          </span>
          <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
            {skill.description}
          </span>
        </span>
      </button>
      {open ? (
        <div className="space-y-2 px-3 pb-3">
          <p className="flex items-start gap-1 text-[10px] break-all text-muted-foreground">
            <FolderOpen className="mt-0.5 size-3 shrink-0" />
            {skill.filePath}
          </p>
          {loading ? (
            <p className="text-xs text-muted-foreground">正在读取…</p>
          ) : error ? (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          ) : (
            <pre
              className="max-h-72 overflow-auto rounded bg-muted p-3 text-[11px] leading-5 whitespace-pre-wrap break-words"
              data-testid="local-skill-content"
            >
              {content}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}
