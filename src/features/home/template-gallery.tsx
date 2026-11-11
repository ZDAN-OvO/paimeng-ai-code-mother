'use client';

import { useState } from 'react';
import { ArrowUpRight, Copy, LayoutTemplate } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { GalleryTemplate } from '@/shared/api/schemas';
import { SiteThumb } from '@/features/preview/site-thumb';

const LOOKS: { id: 'all' | GalleryTemplate['look']; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'landing', label: '落地页' },
  { id: 'app', label: '应用' },
  { id: 'dashboard', label: '数据面板' },
];

const LOOK_LABEL: Record<GalleryTemplate['look'], string> = {
  landing: '落地页',
  app: '应用',
  dashboard: '数据面板',
};

export function TemplateGallery({ entries }: { entries: GalleryTemplate[] }) {
  const [look, setLook] = useState<'all' | GalleryTemplate['look']>('all');
  const [preview, setPreview] = useState<GalleryTemplate | null>(null);
  const [copied, setCopied] = useState(false);

  const visible = look === 'all' ? entries : entries.filter((entry) => entry.look === look);

  async function copyPrompt() {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section id="templates" className="scroll-mt-20 pt-10">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight">
            <LayoutTemplate className="size-4 text-muted-foreground" />
            模板参考
          </h2>
          <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
            查看页面方向与对应提示词。打开本地目录后，可以把提示词发给助手参考。
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          {LOOKS.map((item) => (
            <button
              key={item.id}
              type="button"
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
            onClick={() => {
              setCopied(false);
              setPreview(entry);
            }}
            className="group overflow-hidden rounded-xl border border-border bg-card text-left transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md"
          >
            <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-[#faf7f2]">
              <SiteThumb site={entry.site} className="absolute inset-0" designWidth={860} />
              <span className="absolute top-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[9.5px] text-white backdrop-blur-sm">
                {LOOK_LABEL[entry.look]}
              </span>
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/10 group-hover:opacity-100">
                <span className="flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-stone-900 shadow">
                  查看提示词
                  <ArrowUpRight className="size-3" />
                </span>
              </span>
            </div>
            <div className="px-3 py-2.5">
              <div className="truncate text-[12.5px] font-medium">{entry.name}</div>
              <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{entry.blurb}</p>
            </div>
          </button>
        ))}
      </div>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => (open ? null : setPreview(null))}>
        <DialogContent className="flex max-h-[90vh] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <div className="flex flex-wrap items-center gap-3 border-b border-border py-3 pr-14 pl-5">
            <div className="min-w-0">
              <DialogTitle className="truncate text-sm font-medium">{preview?.name}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                {preview?.blurb}
              </DialogDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto shrink-0 gap-1.5 text-[11px]"
              onClick={() => void copyPrompt()}
            >
              <Copy className="size-3" />
              {copied ? '已复制提示词' : '复制提示词'}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-muted/40 p-3 sm:p-5">
            {preview ? (
              <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
                <div className="relative h-[46vh] overflow-hidden">
                  <SiteThumb site={preview.site} className="absolute inset-0" designWidth={1200} />
                </div>
                <div className="border-t border-border p-3">
                  <p className="mb-1 text-[10px] font-medium text-muted-foreground">提示词</p>
                  <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5">
                    {preview.prompt}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
