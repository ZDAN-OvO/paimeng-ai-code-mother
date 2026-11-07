'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, CircleAlert, Copy, Loader2, PackageOpen, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatTime } from '../mock-data';
import { usePrototype } from '../store';
import type { Project, Version } from '../types';

const STEPS = [
  '导出源码树',
  '在沙箱里执行 next build',
  '复制 .next/standalone 产物',
  '启动只读 runner 容器',
  '把 /p/<deployKey> 指到新容器',
];

export function DeployDialog({
  project,
  version,
  open,
  onOpenChange,
}: {
  project: Project;
  version?: Version;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { recordDeploy } = usePrototype();
  const [step, setStep] = useState(-1);
  const [deployKey, setDeployKey] = useState<string | null>(null);
  const recorded = useRef<string | null>(null);
  const timers = useRef<number[]>([]);

  function start() {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    if (!version) return;
    setStep(0);
    setDeployKey(null);
    recorded.current = null;
    STEPS.forEach((_, index) => {
      const timer = window.setTimeout(
        () => {
          setStep(index + 1);
          if (index + 1 === STEPS.length) {
            if (recorded.current !== version.id) {
              const deploy = recordDeploy(project.id, version.id);
              recorded.current = version.id;
              setDeployKey(deploy.deployKey);
            }
          }
        },
        420 + index * 520,
      );
      timers.current.push(timer);
    });
  }

  useEffect(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    if (!open) return;
    // 等对话框动画开始后再跑构建步骤，也避免在 effect 里同步级联更新。
    const kickoff = window.setTimeout(start, 80);
    return () => {
      window.clearTimeout(kickoff);
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current = [];
    };
    // 只在打开时启动一次；重新发布走按钮。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const running = step >= 0 && step < STEPS.length;
  const done = step >= STEPS.length && Boolean(deployKey);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Rocket className="size-4" />
            发布到项目地址
          </DialogTitle>
          <DialogDescription className="text-xs">
            发布的是某个版本构建出来的产物，不是正在编辑的工作区。回滚之后重新发布，同一个地址会切到新版本。
          </DialogDescription>
        </DialogHeader>

        {!version ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            这个对话还没有版本。先让模型生成一轮，再发布。
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">发布目标</span>
              <span className="font-medium text-foreground">
                {version.label} · {formatTime(version.createdAt)}
              </span>
            </div>

            <div className="space-y-1.5">
              {STEPS.map((label, index) => {
                const state =
                  index < step ? 'done' : index === step && running ? 'running' : 'todo';
                return (
                  <div key={label} className="flex items-center gap-2 text-xs">
                    <span
                      className={cn(
                        'flex size-4 items-center justify-center rounded-full',
                        state === 'done'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                          : state === 'running'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground/70',
                      )}
                    >
                      {state === 'done' ? (
                        <Check className="size-2.5" />
                      ) : state === 'running' ? (
                        <Loader2 className="size-2.5 animate-spin" />
                      ) : (
                        <span className="text-[9px]">{index + 1}</span>
                      )}
                    </span>
                    <span
                      className={
                        state === 'todo' ? 'text-muted-foreground/70' : 'text-foreground/90'
                      }
                    >
                      {label}
                    </span>
                    {state === 'running' ? (
                      <span className="ml-auto text-[10px] text-muted-foreground/70">进行中</span>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {done && deployKey ? (
              <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
                <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-900 dark:text-emerald-200">
                  <PackageOpen className="size-3.5" />
                  已发布 · {version.label}
                </div>
                <div className="flex items-center gap-1.5 rounded border border-emerald-200 bg-card dark:border-emerald-900 px-2 py-1.5">
                  <span className="truncate font-mono text-[11px] text-foreground/90">
                    127.0.0.1:3000/p/{deployKey}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(`/prototype/p/${deployKey}`);
                      toast.success('已复制发布地址');
                    }}
                    className="ml-auto rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
                  >
                    <Copy className="size-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" className="h-7 gap-1 text-[11px]" asChild>
                    <Link href={`/prototype/p/${deployKey}`} target="_blank">
                      <ArrowUpRight className="size-3" />
                      打开地址
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-[11px]"
                    onClick={start}
                    disabled={running}
                  >
                    重新发布
                  </Button>
                  <span className="text-[10px] text-muted-foreground">
                    原型里链接走 /prototype/p/{deployKey}
                  </span>
                </div>
              </div>
            ) : null}

            {!done && !running && version ? (
              <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <CircleAlert className="size-3.5" />
                构建没有完成
              </div>
            ) : null}

            {project.deploys.length > 0 ? (
              <div className="space-y-1.5 border-t border-border/60 pt-3">
                <div className="text-[10px] tracking-wide text-muted-foreground/70 uppercase">
                  发布历史
                </div>
                {project.deploys.slice(0, 4).map((deploy) => (
                  <div
                    key={deploy.id}
                    className="flex items-center gap-2 text-[11px] text-muted-foreground"
                  >
                    <Check className="size-3 text-emerald-600" />
                    <span>v{deploy.versionSeq}</span>
                    <span className="text-muted-foreground/70">{formatTime(deploy.createdAt)}</span>
                    <span className="ml-auto rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {deploy.deployKey}
                    </span>
                  </div>
                ))}
                <p className="pt-1 text-[10px] leading-4 text-muted-foreground/70">
                  地址按 Project 固定。回滚产生新版本后，重新发布会把同一地址指向新版本。
                </p>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
