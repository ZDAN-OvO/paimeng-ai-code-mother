'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, FlaskConical, ListChecks, RotateCcw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { usePrototype } from '../store';
import type { DemoIntent } from '../types';

type Capability = {
  id: number;
  title: string;
  summary: string;
  status: 'full' | 'mock';
  intent?: DemoIntent;
  route: 'home' | 'chat';
  skills?: string[];
};

const CAPABILITIES: Capability[] = [
  {
    id: 1,
    title: '一句话建项目',
    summary: '首页输入描述 → 创建 Project 与首个 Chat，并立刻开始生成。',
    status: 'mock',
    intent: 'prefill-prompt',
    route: 'home',
  },
  {
    id: 2,
    title: '流式对话',
    summary: '发送后逐字出现，工具调用有 running/done 状态与可展开的输入输出。',
    status: 'mock',
    intent: 'send-iteration',
    route: 'chat',
    skills: ['frontend-design'],
  },
  {
    id: 3,
    title: '生成完整 Next.js + Tailwind + shadcn 项目',
    summary: '工具卡片写入多个文件，构建输出成功，文件树里能看到完整项目。',
    status: 'mock',
    route: 'chat',
  },
  {
    id: 4,
    title: '代码面板',
    summary: '文件树、语法着色、只读查看、复制，切换版本时看的是那一版的源码。',
    status: 'full',
    route: 'chat',
  },
  {
    id: 5,
    title: '沙箱内实时预览',
    summary: '预览跟着版本变化，设备宽度切换、刷新、元素定位都在同一块面板里。',
    status: 'mock',
    route: 'chat',
  },
  {
    id: 6,
    title: '多轮迭代',
    summary: '同一 Chat 连续修改，新版本建立在上一次的源码树上。',
    status: 'mock',
    intent: 'send-iteration',
    route: 'chat',
  },
  {
    id: 7,
    title: '版本、diff、回滚',
    summary: '每条助手消息一个版本，可看逐文件 diff，回滚追加新版本而不是改写历史。',
    status: 'full',
    intent: 'open-versions',
    route: 'chat',
  },
  {
    id: 8,
    title: '发布',
    summary: '构建 → 产物 → runner → 地址，同一个 deployKey 重新发布即切换版本。',
    status: 'mock',
    intent: 'open-deploy',
    route: 'chat',
  },
  {
    id: 9,
    title: 'Design mode 元素选择',
    summary: '点选预览元素，读出组件与源码位置，生成一句指向它的对话输入。',
    status: 'full',
    intent: 'design-mode',
    route: 'chat',
  },
  {
    id: 10,
    title: '截图导入',
    summary: '上传或使用示例截图，作为本轮生成的视觉参考附在用户消息里。',
    status: 'full',
    intent: 'attach-screenshot',
    route: 'chat',
  },
  {
    id: 11,
    title: '模板',
    summary: '新建时可选内置起始模板；自动判断会按描述挑选结构。',
    status: 'full',
    intent: 'open-template',
    route: 'home',
  },
  {
    id: 12,
    title: '浏览器与联网搜索',
    summary: '搜索与抓取在工具卡片里呈现，结果进入本轮上下文。',
    status: 'mock',
    intent: 'send-search',
    route: 'chat',
  },
  {
    id: 13,
    title: '环境变量面板',
    summary: 'Project 级键值对，标注密钥，保存后沙箱重启、发布时注入。',
    status: 'full',
    intent: 'open-env',
    route: 'chat',
  },
];

const EXTRAS = [
  {
    title: '技能面板',
    body: '内置技能与用户技能同一套加载机制：描述常驻系统提示，正文按需加载；导入需要显式信任。',
  },
  {
    title: '模型选择器',
    body: '按 Chat 保存，本地网关与线上 provider 在同一张清单里，聊到一半可以换。',
  },
  {
    title: '项目 / 对话结构',
    body: 'Project 下可以开多个 Chat，发布地址挂在 Project 上，一个项目只有一个地址。',
  },
];

export function PrototypeHud() {
  const router = useRouter();
  const { state, setIntent, resetDemo } = usePrototype();
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(true);

  // 原型工具不上生产。
  if (process.env.NODE_ENV === 'production') return null;

  const demoChat =
    state.chats.find((chat) => chat.projectId === 'proj_cafe') ?? state.chats[0] ?? null;

  function go(capability: Capability) {
    if (capability.intent) setIntent(capability.intent);
    if (capability.route === 'home') {
      router.push('/prototype');
    } else if (demoChat) {
      router.push(`/prototype/c/${demoChat.id}`);
    }
    setOpen(false);
  }

  return (
    <>
      <div data-testid="prototype-hud" className="fixed right-4 bottom-4 z-50">
        <div className="flex items-center gap-1 rounded-full border border-stone-700/20 bg-stone-900 px-2 py-1.5 text-white shadow-lg">
          {!minimized ? (
            <>
              <span className="flex items-center gap-1.5 px-1.5 text-[11px] text-stone-300">
                <FlaskConical className="size-3.5 text-amber-300" />
                前端原型
                <span className="text-muted-foreground">·</span>
                模拟数据
              </span>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] transition-colors hover:bg-muted/20"
              >
                <ListChecks className="size-3.5" />
                MVP 清单
                <span className="rounded-full bg-emerald-500/20 px-1.5 text-[10px] text-emerald-300">
                  13
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  resetDemo();
                  toast.success('演示数据已重置');
                }}
                className="rounded-full p-1.5 text-muted-foreground/70 transition-colors hover:bg-muted/10 hover:text-white"
                title="重置演示数据"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </>
          ) : null}
          <button
            type="button"
            aria-label={minimized ? '展开原型工具' : '收起原型工具'}
            onClick={() => setMinimized((value) => !value)}
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] text-stone-300 hover:bg-white/10"
          >
            <FlaskConical className="size-3.5" />
            {minimized ? '原型' : '收起'}
          </button>
        </div>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-xl">
          <SheetHeader className="border-b border-border">
            <SheetTitle className="flex items-center gap-2 text-sm">
              <ListChecks className="size-4" />
              MVP 覆盖清单
            </SheetTitle>
            <SheetDescription className="text-xs leading-5">
              逐条点开走一遍，判断这 13
              条是否覆盖你要的东西。标「模拟」的环节说明原型只演示交互与信息结构，真实能力要等后端。
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
            {CAPABILITIES.map((capability) => (
              <div
                key={capability.id}
                className="group flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-muted/40"
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground">
                  {capability.id}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12.5px] font-medium text-foreground">
                      {capability.title}
                    </span>
                    <span
                      className={cn(
                        'rounded px-1 py-0.5 text-[9.5px]',
                        capability.status === 'full'
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300'
                          : 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 dark:bg-amber-950/50 dark:text-amber-300',
                      )}
                    >
                      {capability.status === 'full' ? '交互完整' : '模拟'}
                    </span>
                    {capability.skills?.map((skill) => (
                      <span
                        key={skill}
                        className="rounded bg-muted px-1 py-0.5 font-mono text-[9.5px] text-muted-foreground"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    {capability.summary}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid={`demo-${capability.id}`}
                  onClick={() => go(capability)}
                  className="mt-0.5 shrink-0 rounded border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground"
                >
                  去演示
                </button>
              </div>
            ))}

            <div className="mt-3 border-t border-border pt-3">
              <div className="flex items-center gap-1.5 px-2 text-[11px] font-medium text-muted-foreground">
                <Sparkles className="size-3.5" />
                13 条之外，原型里已经做出来的部分
              </div>
              <div className="mt-1.5 space-y-1.5">
                {EXTRAS.map((extra) => (
                  <div key={extra.title} className="rounded-md bg-muted/40 px-2.5 py-2">
                    <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-foreground">
                      <CheckCircle2 className="size-3 text-emerald-600" />
                      {extra.title}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                      {extra.body}
                    </p>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push('/prototype/skills');
                }}
                className="mt-2 w-full rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] text-muted-foreground hover:bg-muted/40"
              >
                打开技能面板
              </button>
            </div>

            <div className="mt-3 rounded-md border border-border p-2.5 text-[10.5px] leading-5 text-muted-foreground">
              <p className="font-medium text-foreground/90">原型的边界</p>
              <p>预览与「生成的站点」由本地组件渲染，不跑真实沙箱；流式与工具状态由脚本驱动。</p>
              <p>发布不构建真实产物，只切换发布记录与地址。</p>
              <p>文件内容、diff 与版本快照是真的：改文案、回滚后能看到行级变化。</p>
              <p>演示数据存在 localStorage，重置按钮会清掉。</p>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border p-3">
            <span className="text-[10px] text-muted-foreground/70">
              接口契约见 src/prototype/README.md
            </span>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              继续看
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
