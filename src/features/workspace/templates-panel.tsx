'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api/client';
import { TemplateGallery } from '@/features/home/template-gallery';
import type {
  CreateProjectResponse,
  GalleryTemplate,
  TemplatesResponse,
} from '@/shared/api/schemas';

/** 「模板」入口：模板画廊直接在中栏打开，选一个就建示例项目进对话。 */
export function TemplatesPanel({
  onOpenChat,
  onCreated,
}: {
  onOpenChat: (chatId: string) => void;
  onCreated?: () => void;
}) {
  const [gallery, setGallery] = useState<GalleryTemplate[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const catalog = await api.get<TemplatesResponse>('/api/templates');
        if (cancelled) return;
        setGallery(catalog.gallery);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof ApiRequestError ? cause.message : '模板加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function start(entry: GalleryTemplate) {
    if (busyId) return;
    setError(null);
    setBusyId(entry.id);
    try {
      const created = await api.post<CreateProjectResponse>('/api/projects', {
        prompt: entry.prompt,
        templateId: entry.templateId,
        workspacePath: `~/Projects/${entry.id}`,
      });
      onCreated?.();
      onOpenChat(created.chat.id);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : '创建项目失败，请重试');
      setBusyId(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30">
      <div className="border-b border-border bg-card px-5 py-3">
        <h2 className="text-[13.5px] font-semibold tracking-tight">模板</h2>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          选一个模板就新建一个示例项目，进对话页继续改；模板只是起点，不限制后面怎么改。
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {loading ? (
          <p className="mt-4 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在读取模板…
          </p>
        ) : (
          <div className="mx-auto max-w-4xl [&>section]:pt-4">
            <TemplateGallery
              entries={gallery}
              busy={Boolean(busyId)}
              onUse={(entry) => void start(entry)}
            />
          </div>
        )}
        {error ? <p className="mt-3 text-[11.5px] text-red-600">{error}</p> : null}
      </div>
    </div>
  );
}
