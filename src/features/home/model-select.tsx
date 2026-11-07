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

import type { Model } from '@/shared/api/schemas';

export function ModelSelect({
  models,
  value,
  onChange,
  compact = false,
}: {
  models: Model[];
  value: string;
  onChange: (modelId: string) => void;
  compact?: boolean;
}) {
  const current = models.find((model) => model.id === value) ?? models[0];
  if (!current) {
    return <span className="px-2 py-1 text-xs text-muted-foreground">模型加载中…</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={
          compact
            ? 'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
            : 'flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs transition-colors hover:border-foreground/30'
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Cpu className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="truncate">{current.name}</span>
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          模型决定生成质量与成本
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => onChange(model.id)}
            className="flex items-start gap-2 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm">
                <span className="truncate">{model.name}</span>
                {model.id === value ? <Check className="size-3.5 text-emerald-600" /> : null}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {model.provider} · {model.note}
              </div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
