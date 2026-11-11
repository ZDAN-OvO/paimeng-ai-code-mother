'use client';

import { useState } from 'react';
import { Check, Copy, FolderClosed, Settings2 } from 'lucide-react';
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

  function copyPath() {
    void navigator.clipboard.writeText(project.workspacePath).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Settings2 className="size-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium">项目设置</span>
        <span className="text-[10.5px] text-muted-foreground">名称、目录与环境变量</span>
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
          <p className="text-[10.5px] text-muted-foreground">改名只影响侧栏与标题。</p>
        </section>

        <section className="space-y-2">
          <div className="text-[11px] font-medium">项目目录</div>
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5">
            <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
              {project.workspacePath}
            </span>
            <button
              type="button"
              onClick={copyPath}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="复制目录"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>
          <p className="text-[10.5px] leading-5 text-muted-foreground">
            {project.workspaceState === 'sample'
              ? '示例项目：路径只做记录，尚未连接真实目录。连接后会直接读写这里。'
              : '助手读写这个目录里的项目文件；外部编辑器改动会体现在下次读取中。'}
          </p>
        </section>

        <section className="border-t border-border pt-4">
          <EnvEditor key={project.env.length} project={project} />
        </section>
      </div>
    </div>
  );
}
