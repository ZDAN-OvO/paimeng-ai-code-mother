'use client';

import { useState } from 'react';
import { ArrowUpRight, LayoutTemplate, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { GalleryTemplate } from '@/shared/api/schemas';
import { MockSite } from '@/features/preview/mock-site';
import { SiteThumb } from '@/features/preview/site-thumb';

type Entry = GalleryTemplate;

const LOOKS: { id: 'all' | Entry['look']; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'landing', label: '落地页' },
  { id: 'app', label: '应用' },
  { id: 'dashboard', label: '数据面板' },
];

const LOOK_LABEL: Record<Entry['look'], string> = {
  landing: '落地页',
  app: '应用',
  dashboard: '数据面板',
};

export function TemplateGallery({
  entries,
  onUse,
  busy = false,
}: {
  entries: Entry[];
  onUse: (entry: Entry) => void;
  busy?: boolean;
}) {
  const [look, setLook] = useState<'all' | Entry['look']>('all');
  const [preview, setPreview] = useState<Entry | null>(null);

  const visible = look === 'all' ? entries : entries.filter((entry) => entry.look === look);

  return (
    <section id="templates" className="scroll-mt-20 pt-14">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight">
            <LayoutTemplate className="size-4 text-muted-foreground" />
            从模板开始
          </h2>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            每个模板都是一个完整的示例应用。点开看整页，再决定要不要用它开始。
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          {LOOKS.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`template-tab-${item.id}`}
              onClick={() => setLook(item.id)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                look === item.id
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-testid={`template-${entry.id}`}
            onClick={() => setPreview(entry)}
            className="group overflow-hidden rounded-xl border border-border bg-card text-left transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md"
          >
            <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-[#faf7f2]">
              <SiteThumb site={entry.site} className="absolute inset-0" designWidth={860} />
              <span className="absolute top-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[9.5px] text-white backdrop-blur-sm">
                {LOOK_LABEL[entry.look]}
              </span>
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/10 group-hover:opacity-100">
                <span className="flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-stone-900 shadow">
                  预览整页
                  <ArrowUpRight className="size-3" />
                </span>
              </span>
            </div>
            <div className="flex items-start gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium">{entry.name}</div>
                <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                  {entry.blurb}
                </p>
              </div>
              <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                <Users className="size-2.5" />
                {entry.uses.toLocaleString('en-US')}
              </span>
            </div>
          </button>
        ))}
      </div>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => (open ? null : setPreview(null))}>
        <DialogContent className="flex h-[88vh] w-full max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
          <div className="flex items-center gap-3 border-b border-border py-3 pr-14 pl-5">
            <div className="min-w-0">
              <DialogTitle className="truncate text-sm font-medium">{preview?.name}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                {preview?.blurb}
              </DialogDescription>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-3">
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                {preview?.uses.toLocaleString('en-US')} 次使用
              </span>
              <Button
                size="sm"
                data-testid="template-use"
                disabled={busy}
                onClick={() => {
                  if (!preview) return;
                  onUse(preview);
                  setPreview(null);
                }}
              >
                {busy ? '正在创建…' : '用这个模板开始'}
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-5">
            <div className="mx-auto w-[1200px] origin-top-left overflow-hidden rounded-lg border border-border bg-white shadow-sm [zoom:0.85]">
              {preview ? <MockSite site={preview.site} /> : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
