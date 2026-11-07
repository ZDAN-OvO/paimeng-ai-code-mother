'use client';

import Link from 'next/link';
import { ArrowUpRight, Check, History, PackageOpen, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { bytesOf, formatTime } from '../mock-data';
import type { Project, Version } from '../types';

export function ArtifactPanel({
  project,
  version,
  onDeploy,
}: {
  project: Project;
  version?: Version;
  onDeploy: () => void;
}) {
  const bytes = version
    ? Object.values(version.files).reduce((total, code) => total + bytesOf(code), 0)
    : 0;
  const files = version ? Object.keys(version.files).length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <History className="size-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium">产物与发布记录</span>
        <Button
          size="sm"
          data-testid="artifact-deploy"
          className="ml-auto h-7 gap-1 text-[11px]"
          onClick={onDeploy}
          disabled={!version}
        >
          <Rocket className="size-3" />
          发布当前版本
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <section className="space-y-2">
          <div className="text-[10px] font-medium tracking-wide text-muted-foreground/80 uppercase">
            当前产物
          </div>
          {version ? (
            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center gap-1.5">
                <PackageOpen className="size-3.5 text-muted-foreground" />
                <span className="text-[12px] font-medium">{version.label}</span>
                <span className="rounded border border-border px-1 py-0.5 text-[9.5px] text-muted-foreground">
                  ready
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {formatTime(version.createdAt)}
                </span>
              </div>
              <p className="text-[11px] leading-5 text-muted-foreground">{version.summary}</p>
              <div className="grid grid-cols-3 gap-2 border-t border-border/70 pt-2 text-center">
                <div>
                  <div className="font-mono text-[12px]">{files}</div>
                  <div className="text-[9.5px] text-muted-foreground">文件</div>
                </div>
                <div>
                  <div className="font-mono text-[12px]">{(bytes / 1024).toFixed(1)} kB</div>
                  <div className="text-[9.5px] text-muted-foreground">源码体积</div>
                </div>
                <div>
                  <div className="font-mono text-[12px]">{version.changedFiles.length}</div>
                  <div className="text-[9.5px] text-muted-foreground">本轮改动</div>
                </div>
              </div>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border p-3 text-[11px] text-muted-foreground">
              还没有可发布的产物。先让模型生成一轮。
            </p>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground/80 uppercase">
              发布历史
            </span>
            <span className="text-[10px] text-muted-foreground">{project.deploys.length} 条</span>
          </div>
          {project.deploys.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-[11px] leading-5 text-muted-foreground">
              同一个项目只用一个地址。每次发布把地址指向新的版本，旧版本仍然留在版本列表里。
            </p>
          ) : (
            <div className="divide-y divide-border/70 rounded-lg border border-border">
              {project.deploys.map((deploy) => (
                <div key={deploy.id} className="flex items-center gap-2 px-2.5 py-2">
                  <span
                    className={cn(
                      'flex size-4 items-center justify-center rounded-full',
                      deploy.state === 'ready'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400'
                        : 'bg-amber-100 text-amber-700',
                    )}
                  >
                    <Check className="size-2.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] font-medium">v{deploy.versionSeq}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {formatTime(deploy.createdAt)} · {deploy.state}
                    </div>
                  </div>
                  <Link
                    href={`/prototype/p/${deploy.deployKey}`}
                    target="_blank"
                    className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    打开
                    <ArrowUpRight className="size-2.5" />
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>

        <p className="text-[10px] leading-5 text-muted-foreground/80">
          原型不构建真实产物：文件、体积与 diff 来自版本快照，发布只切换地址与记录。
        </p>
      </div>
    </div>
  );
}
