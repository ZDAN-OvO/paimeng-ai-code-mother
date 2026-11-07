'use client';

import { useState } from 'react';
import { KeyRound, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { usePrototype } from '../store';
import type { EnvVar, Project } from '../types';

type Draft = EnvVar & { id: string };

/** 环境变量编辑器。打开时重新挂载，草稿从当前 Project 初始化，不用 effect 同步 props。 */
export function EnvEditor({ project }: { project: Project }) {
  const { setEnv } = usePrototype();
  const [rows, setRows] = useState<Draft[]>(() =>
    project.env.map((item, index) => ({ ...item, id: `row-${index}` })),
  );

  const invalid = rows.some(
    (row) => row.key.trim().length > 0 && !/^[A-Z_][A-Z0-9_]*$/.test(row.key.trim()),
  );

  function save() {
    const cleaned = rows
      .filter((row) => row.key.trim())
      .map((row) => ({ key: row.key.trim(), value: row.value, secret: row.secret }));
    setEnv(project.id, cleaned);
    toast.success('环境变量已保存', {
      description: '沙箱会重启一次，发布实例在下次发布时注入。',
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium">
        <KeyRound className="size-3.5 text-muted-foreground" />
        环境变量
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">
          {rows.filter((row) => row.key).length} 个
        </span>
      </div>

      <div className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2 px-1 text-[10px] text-muted-foreground/70">
        <span>键</span>
        <span>值</span>
        <span>密钥</span>
        <span />
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-[11px] leading-5 text-muted-foreground">
          还没有变量。加一个 NEXT_PUBLIC_ 开头的变量试试，预览会立刻读到。
        </p>
      ) : null}

      {rows.map((row) => (
        <div key={row.id} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
          <Input
            value={row.key}
            onChange={(event) =>
              setRows((current) =>
                current.map((item) =>
                  item.id === row.id ? { ...item, key: event.target.value } : item,
                ),
              )
            }
            placeholder="API_KEY"
            className="h-8 font-mono text-[11.5px]"
          />
          <Input
            value={row.value}
            type={row.secret ? 'password' : 'text'}
            onChange={(event) =>
              setRows((current) =>
                current.map((item) =>
                  item.id === row.id ? { ...item, value: event.target.value } : item,
                ),
              )
            }
            placeholder="值"
            className="h-8 font-mono text-[11.5px]"
          />
          <Switch
            checked={row.secret}
            onCheckedChange={(checked) =>
              setRows((current) =>
                current.map((item) => (item.id === row.id ? { ...item, secret: checked } : item)),
              )
            }
          />
          <button
            type="button"
            onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}

      <Button
        variant="outline"
        size="sm"
        className="h-8 w-full gap-1.5 border-dashed text-[11.5px]"
        onClick={() =>
          setRows((current) => [
            ...current,
            { id: `row-${Date.now()}`, key: '', value: '', secret: false },
          ])
        }
      >
        <Plus className="size-3.5" />
        添加变量
      </Button>

      {invalid ? (
        <p className="text-[11px] text-red-600 dark:text-red-400">
          键名只能包含大写字母、数字与下划线，且不以数字开头。
        </p>
      ) : null}

      <div className="space-y-2 rounded-md bg-muted/50 p-3 text-[11px] leading-5 text-muted-foreground">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <RotateCcw className="size-3.5" />
          生效规则
        </div>
        <p>保存后沙箱容器会重启一次，正在生成的任务会中断。</p>
        <p>发布实例在构建时读取同一份变量；改完变量需要重新发布。</p>
        <p>密钥勾选后，界面上只显示掩码，接口返回也不会带明文。</p>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] text-muted-foreground">只存在本地，不写进源码树</span>
        <Button size="sm" data-testid="env-save" onClick={save} disabled={invalid}>
          保存并重启沙箱
        </Button>
      </div>
    </div>
  );
}
