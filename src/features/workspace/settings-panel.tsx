'use client';

import { useState } from 'react';
import { Check, Copy, Link2, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorkspace } from './workspace-store';
import type { Project } from '@/shared/api/schemas';
import { EnvEditor } from './env-editor';

export function SettingsPanel({ project }: { project: Project }) {
  const { renameProject } = useWorkspace();
  const [name, setName] = useState(project.name);
  const [copied, setCopied] = useState(false);
  const dirty = name.trim() !== project.name && name.trim().length > 0;

  function copyKey() {
    if (!project.deployKey) return;
    void navigator.clipboard.writeText(project.deployKey).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Settings2 className="size-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium">项目设置</span>
        <span className="text-[10.5px] text-muted-foreground">名称、地址与环境变量</span>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        <section className="space-y-2">
          <div className="text-[11px] font-medium">项目名称</div>
          <div className="flex gap-1.5">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-8 text-[12.5px]"
            />
            <Button
              size="sm"
              className="h-8"
              disabled={!dirty}
              onClick={() => {
                const next = name.trim();
                if (!next) return;
                renameProject(project.id, next);
                toast.success('项目已重命名');
              }}
            >
              保存
            </Button>
          </div>
          <p className="text-[10.5px] text-muted-foreground">
            改名只影响侧栏与标题，发布地址不变。
          </p>
        </section>

        <section className="space-y-2">
          <div className="text-[11px] font-medium">发布地址</div>
          {project.deployKey ? (
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5">
              <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                /deploys/{project.deployKey}
              </span>
              <button
                type="button"
                onClick={copyKey}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="复制地址"
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-600" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border px-2 py-2 text-[10.5px] text-muted-foreground">
              还没有发布过。发一次之后，这里会出现固定地址。
            </p>
          )}
        </section>

        <section className="border-t border-border pt-4">
          <EnvEditor key={project.env.length} project={project} />
        </section>
      </div>
    </div>
  );
}
