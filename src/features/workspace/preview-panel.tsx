'use client';

import { MonitorPlay } from 'lucide-react';

export function PreviewPanel({ projectName }: { projectName: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2">
        <p className="text-xs font-semibold">预览</p>
        <p className="truncate text-[10px] text-muted-foreground">{projectName}</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <MonitorPlay className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">预览尚未启动</p>
        <p className="max-w-xs text-[11px] leading-5 text-muted-foreground">
          当前没有可查看的运行中应用。可以先在文件和改动面板查看项目内容。
        </p>
      </div>
    </div>
  );
}
