'use client';

import { Check, Monitor, Moon, Sun } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  setThemeMode,
  useResolvedTheme,
  useThemeMode,
  useThemeMounted,
  type ThemeMode,
} from '@/features/theme/theme-provider';

const OPTIONS: { value: ThemeMode; label: string; hint: string; icon: typeof Sun }[] = [
  { value: 'system', label: '跟随系统', hint: '按系统外观自动切换', icon: Monitor },
  { value: 'light', label: '浅色', hint: '始终使用浅色', icon: Sun },
  { value: 'dark', label: '深色', hint: '始终使用深色', icon: Moon },
];

export function ThemeToggle({ className }: { className?: string }) {
  const mode = useThemeMode();
  const resolved = useResolvedTheme();
  const mounted = useThemeMounted();
  const Icon = resolved === 'dark' ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="theme-toggle"
        title="切换明暗主题"
        className={cn(
          'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          className,
        )}
      >
        {mounted ? <Icon className="size-3.5" /> : <span className="size-3.5" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">
          主题 · 只影响产品界面
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {OPTIONS.map((option) => {
          const OptionIcon = option.icon;
          return (
            <DropdownMenuItem
              key={option.value}
              data-testid={`theme-${option.value}`}
              onClick={() => setThemeMode(option.value)}
              className="flex items-start gap-2 py-2"
            >
              <OptionIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[12.5px]">
                  {option.label}
                  {mode === option.value ? <Check className="size-3 text-emerald-600" /> : null}
                </span>
                <span className="mt-0.5 block text-[10.5px] text-muted-foreground">
                  {option.hint}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
