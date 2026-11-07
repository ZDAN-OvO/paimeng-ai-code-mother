'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Loader2,
  Lock,
  Monitor,
  MousePointerSquareDashed,
  RefreshCw,
  Smartphone,
  Tablet,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { MockSite } from '../site';
import type { SiteState, Version } from '../types';
import type { DesignSelection } from './chat-panel';

type Device = 'desktop' | 'tablet' | 'mobile';

const DEVICE_WIDTH: Record<Device, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
};

const DEVICE_ICON = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };

export function PreviewPanel({
  version,
  liveSite,
  chatId,
  sandboxState,
  designMode,
  onToggleDesign,
  onSelectElement,
  selection,
}: {
  version?: Version;
  liveSite?: SiteState;
  chatId: string;
  sandboxState: 'running' | 'starting' | 'stopped';
  designMode: boolean;
  onToggleDesign: () => void;
  onSelectElement: (selection: DesignSelection) => void;
  selection: DesignSelection | null;
}) {
  const [device, setDevice] = useState<Device>('desktop');
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [hover, setHover] = useState<{ rect: DOMRect; label: string; src: string } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  function relativeRect(el: HTMLElement): DOMRect {
    const stage = stageRef.current?.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    if (!stage) return rect;
    return new DOMRect(rect.left - stage.left, rect.top - stage.top, rect.width, rect.height);
  }

  function findTarget(event: React.MouseEvent<HTMLElement>): HTMLElement | null {
    return (event.target as HTMLElement).closest('[data-src]');
  }

  const [selectedRect, setSelectedRect] = useState<DOMRect | null>(null);
  const site = liveSite ?? version?.site;
  const isLive = Boolean(liveSite);

  useEffect(() => {
    if (!selection || !stageRef.current) {
      setSelectedRect(null);
      return;
    }
    const selector = `[data-component="${selection.component}"][data-label="${CSS.escape(selection.label)}"]`;
    const el = stageRef.current.querySelector<HTMLElement>(selector);
    setSelectedRect(el ? relativeRect(el) : null);
  }, [selection, version?.id, device, refreshKey, liveSite?.iteration]);

  function reload() {
    setRefreshing(true);
    setRefreshKey((key) => key + 1);
    window.setTimeout(() => setRefreshing(false), 600);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/40">
      <div className="flex items-center gap-1.5 border-b border-border bg-card px-2.5 py-1.5">
        <div className="hidden items-center gap-1 sm:flex">
          {(Object.keys(DEVICE_ICON) as Device[]).map((item) => {
            const Icon = DEVICE_ICON[item];
            return (
              <button
                key={item}
                type="button"
                onClick={() => setDevice(item)}
                className={cn(
                  'rounded p-1.5 transition-colors',
                  device === item
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                title={item === 'desktop' ? '桌面' : item === 'tablet' ? '平板' : '手机'}
              >
                <Icon className="size-3.5" />
              </button>
            );
          })}
        </div>

        <div className="mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1">
          <Lock className="size-3 shrink-0 text-muted-foreground/70" />
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            preview.local/preview/{chatId}
          </span>
          <button
            type="button"
            onClick={reload}
            className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="刷新预览"
          >
            {refreshing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleDesign}
          data-testid="toggle-design"
          className={cn(
            'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
            designMode
              ? 'border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200'
              : 'border-border bg-card text-muted-foreground hover:bg-muted/60',
          )}
          title="点选预览元素，生成指向该组件的对话输入"
        >
          <MousePointerSquareDashed className="size-3.5" />
          Design
        </button>
        <Popover>
          <PopoverTrigger className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <ExternalLink className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 text-xs leading-5">
            <p className="font-medium">预览地址</p>
            <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">
              127.0.0.1:3000/preview/{chatId}
            </p>
            <p className="mt-2 text-muted-foreground">
              原型里不打开新窗口：真实实现中这里会在新标签打开沙箱的 next dev，并代理 HMR
              WebSocket。
            </p>
          </PopoverContent>
        </Popover>
      </div>

      {designMode ? (
        <div className="flex items-center gap-1.5 border-b border-sky-200 bg-sky-50 px-3 py-1.5 text-[11px] text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
          <MousePointerSquareDashed className="size-3.5" />
          点选页面元素，把它填进对话框
          <span className="ml-auto text-[10px] text-sky-700/70 dark:text-sky-300/70">
            只做定位与填词，不做样式面板
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full justify-center p-3">
          <div
            className={cn(
              'relative min-h-full w-full overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-[max-width] duration-200',
              device !== 'desktop' && 'shadow-lg',
            )}
            style={{ maxWidth: DEVICE_WIDTH[device] }}
          >
            {site ? (
              <div ref={stageRef} className="relative min-h-full">
                <div
                  key={refreshKey}
                  onClickCapture={(event) => {
                    if (!designMode) return;
                    const el = findTarget(event);
                    if (!el) return;
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectElement({
                      component: el.dataset.component ?? 'Component',
                      src: el.dataset.src ?? '',
                      label: el.dataset.label ?? el.dataset.component ?? '元素',
                    });
                  }}
                  onMouseMove={(event) => {
                    if (!designMode) return;
                    const el = findTarget(event);
                    if (!el) {
                      setHover(null);
                      return;
                    }
                    setHover({
                      rect: relativeRect(el),
                      label: el.dataset.label ?? el.dataset.component ?? '元素',
                      src: el.dataset.src ?? '',
                    });
                  }}
                  onMouseLeave={() => setHover(null)}
                  className={cn(designMode && 'cursor-crosshair [&_*]:cursor-crosshair')}
                >
                  <MockSite site={site} />
                </div>

                {designMode && hover ? (
                  <div
                    className="pointer-events-none absolute rounded-sm border-2 border-dashed border-sky-500 bg-sky-500/5"
                    style={{
                      left: hover.rect.x,
                      top: hover.rect.y,
                      width: hover.rect.width,
                      height: hover.rect.height,
                    }}
                  >
                    <span className="absolute top-0 left-0 rounded-sm bg-sky-600 px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-white">
                      {hover.label} · {hover.src}
                    </span>
                  </div>
                ) : null}

                {designMode && selectedRect && selection ? (
                  <div
                    className="pointer-events-none absolute rounded-sm border-2 border-solid border-sky-600"
                    style={{
                      left: selectedRect.x,
                      top: selectedRect.y,
                      width: selectedRect.width,
                      height: selectedRect.height,
                    }}
                  >
                    <span className="absolute top-0 right-0 rounded-sm bg-sky-600 px-1.5 py-0.5 text-[10px] text-white">
                      已选中 {selection.component}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex h-full min-h-72 flex-col items-center justify-center gap-2 p-8 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                  <Loader2 className="size-4 text-muted-foreground" />
                </div>
                <p className="text-sm">这个对话还没有可预览的版本</p>
                <p className="max-w-xs text-xs leading-5 text-muted-foreground">
                  发送第一条消息后，沙箱会写入文件并启动 next dev，预览会出现在这里。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border bg-card px-3 py-1.5 text-[10.5px] text-muted-foreground">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5',
            sandboxState === 'running'
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
              : 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              sandboxState === 'running' ? 'bg-emerald-500' : 'bg-amber-500',
            )}
          />
          沙箱{' '}
          {sandboxState === 'running'
            ? '运行中'
            : sandboxState === 'starting'
              ? '启动中'
              : '已停止'}
        </span>
        <span>next dev · :3000</span>
        <span className="ml-auto">
          {isLive ? '生成中 · 预览随写入刷新' : version ? `正在查看 ${version.label}` : '无版本'}
          {selection && designMode ? ' · 已选中元素' : ''}
        </span>
      </div>
    </div>
  );
}
