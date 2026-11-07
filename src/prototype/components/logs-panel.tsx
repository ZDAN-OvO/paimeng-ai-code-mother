'use client';

import { useEffect, useRef, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTime } from '../mock-data';
import type { Chat, Version } from '../types';

type Line = { at: string; kind: 'cmd' | 'out' | 'ok' | 'warn'; text: string };

function stamp(iso: string, offsetMs: number): string {
  const base = new Date(iso).getTime();
  if (Number.isNaN(base)) return '--:--:--';
  return new Date(base + offsetMs + 8 * 3600_000).toISOString().slice(11, 19);
}

/** 由版本快照推导出来的构建与运行日志，不连真实沙箱。 */
function buildLines(version: Version | undefined, streaming: boolean): Line[] {
  if (!version) {
    return streaming
      ? [{ at: '--:--:--', kind: 'out', text: '沙箱启动中，等待第一个文件写入…' }]
      : [{ at: '--:--:--', kind: 'warn', text: '这个对话还没有构建记录。' }];
  }
  const files = Object.keys(version.files).length;
  const changed = version.changedFiles.length;
  const at = (offset: number) => stamp(version.createdAt, offset);
  return [
    { at: at(0), kind: 'cmd', text: '$ npm run build' },
    { at: at(240), kind: 'out', text: '▲ Next.js 16.4.5' },
    { at: at(420), kind: 'out', text: `  正在编译 ${files} 个文件…` },
    {
      at: at(900),
      kind: 'ok',
      text: `✓ Compiled successfully in ${(0.8 + files * 0.05).toFixed(1)}s`,
    },
    { at: at(1240), kind: 'out', text: '  Route (app)                     Size' },
    { at: at(1320), kind: 'out', text: '  ○ /                            1.2 kB' },
    { at: at(1500), kind: 'ok', text: '✓ Generating static pages (3/3)' },
    {
      at: at(1820),
      kind: 'ok',
      text: `✓ 构建完成 · ${changed} 个文件有变化 · 产物 ${(files * 1.7).toFixed(1)} kB`,
    },
    { at: at(1900), kind: 'cmd', text: '$ next start -p 3000' },
    { at: at(2100), kind: 'ok', text: `✓ Ready in 620ms · ${formatTime(version.createdAt)}` },
  ];
}

export function LogsPanel({ chat, version }: { chat: Chat; version?: Version }) {
  const lines = buildLines(version, chat.streaming);
  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (!follow) return;
    const node = boxRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [follow, lines.length]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ScrollText className="size-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium">构建与运行日志</span>
        <span className="text-[10.5px] text-muted-foreground">脚本生成 · 不连真实沙箱</span>
        <label className="ml-auto flex items-center gap-1 text-[10.5px] text-muted-foreground">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
            className="size-3 accent-foreground"
          />
          跟随最新
        </label>
      </div>
      <div
        ref={boxRef}
        data-testid="logs-panel"
        className="min-h-0 flex-1 overflow-auto bg-muted/30 p-3 font-mono text-[11.5px] leading-5"
      >
        {lines.map((line, index) => (
          <div key={index} className="flex gap-2 whitespace-pre-wrap">
            <span className="shrink-0 text-muted-foreground/50">{line.at}</span>
            <span
              className={cn(
                line.kind === 'cmd' && 'font-medium text-foreground',
                line.kind === 'out' && 'text-muted-foreground',
                line.kind === 'ok' && 'text-emerald-700 dark:text-emerald-400',
                line.kind === 'warn' && 'text-amber-700 dark:text-amber-400',
              )}
            >
              {line.text}
            </span>
          </div>
        ))}
        {chat.streaming ? (
          <div className="flex gap-2 text-amber-700 dark:text-amber-400">
            <span className="text-muted-foreground/50">--:--:--</span>
            <span>
              正在写入文件
              <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle" />
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-[10.5px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        next dev · :3000
        <span className="ml-auto">{version ? `对应 ${version.label}` : '暂无版本'}</span>
      </div>
    </div>
  );
}
