'use client';

import { Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { TEMPLATES } from '../mock-data';

export function TemplateDialog({
  open,
  onOpenChange,
  value,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (templateId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">选一个起始模板</DialogTitle>
          <DialogDescription className="text-xs">
            模板决定初始文件与页面结构。选自动判断时，模型按你的描述决定，生成后仍然可以继续改。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {TEMPLATES.map((template) => {
            const selected = template.id === value;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => {
                  onChange(template.id);
                  onOpenChange(false);
                }}
                className={cn(
                  'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                  selected
                    ? 'border-stone-900 bg-stone-50'
                    : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50/60',
                )}
              >
                <span className={cn('size-9 shrink-0 rounded-md', template.accent)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-stone-900">
                    {template.name}
                    {selected ? <Check className="size-3.5 text-stone-700" /> : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-stone-500">
                    {template.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
