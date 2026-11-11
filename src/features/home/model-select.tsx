'use client';

import { Check, ChevronDown, Cpu } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Model } from '@/shared/api/schemas';

export function ModelSelect({
  models,
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  models: Model[];
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const current =
    models.find((model) => model.id === value) ?? models.find((model) => model.configured);
  if (!current) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'flex items-center gap-1.5 rounded-md text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60',
          compact
            ? 'px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground'
            : 'border border-border bg-card px-2.5 py-1.5 hover:border-foreground/30',
        )}
        title="选择本轮使用的模型"
      >
        <Cpu className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="max-w-40 truncate">{current.name}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">
          选择模型
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.map((model) => {
          const selected = model.id === current.id;
          return (
            <DropdownMenuItem
              key={model.id}
              disabled={!model.configured}
              onClick={() => onChange(model.id)}
              className="flex items-start gap-2 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="truncate">{model.name}</span>
                  {selected ? <Check className="size-3.5 shrink-0 text-emerald-600" /> : null}
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {model.provider}
                  {model.configured ? '' : ' · 未配置'}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
