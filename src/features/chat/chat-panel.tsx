'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  FilePlus2,
  FolderTree,
  Globe,
  ImageIcon,
  ImagePlus,
  Loader2,
  Mic,
  MousePointerSquareDashed,
  Paperclip,
  Search,
  Sparkles,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { PaimengMark } from '@/components/brand/paimeng-mark';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { SAMPLE_SCREENSHOT } from '@/mock/seed/screenshot';
import { formatTime } from '@/lib/time';
import { useWorkspace } from '@/features/workspace/workspace-store';
import type {
  ChatRecord,
  DesignContext,
  Message,
  Model,
  Part,
  Project,
} from '@/shared/api/schemas';
import { useVoiceInput } from '@/features/chat/use-voice';
import { ModelSelect } from '@/features/home/model-select';
import { PlanCard, TodosCard } from '@/features/chat/flow-cards';

export type DesignSelection = DesignContext;

export type Attachment = { url: string; name: string };

export function ChatPanel({
  chat,
  project,
  models,
  selection,
  onClearSelection,
  onOpenVersion,
  draft,
  onDraftChange,
  attachments,
  onAttachmentsChange,
}: {
  chat: ChatRecord;
  models: Model[];
  project: Project;
  selection: DesignSelection | null;
  onClearSelection: () => void;
  onOpenVersion: (versionId: string) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  attachments: Attachment[];
  onAttachmentsChange: (next: Attachment[]) => void;
}) {
  const { sendMessage, stopGeneration, setModel } = useWorkspace();
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { listening, toggle: toggleVoice } = useVoiceInput((text) => {
    onDraftChange(draft.trim() ? `${draft.replace(/\s+$/, '')} ${text}` : `${text}`);
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chat.messages]);

  const busy = chat.streaming;
  const awaiting = Boolean(chat.pendingPlan);
  const [planning, setPlanning] = useState(false);

  function submit() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy || awaiting) return;
    sendMessage(chat.id, text, attachments, { selection: selection ?? undefined, plan: planning });
    onDraftChange('');
    onAttachmentsChange([]);
    onClearSelection();
  }

  function onFile(files: FileList | null) {
    if (!files) return;
    Array.from(files)
      .slice(0, 3)
      .forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            onAttachmentsChange([
              ...attachments,
              { url: reader.result as string, name: file.name },
            ]);
          }
        };
        reader.readAsDataURL(file);
      });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5">
        {chat.messages.length === 0 ? (
          <EmptyChat project={project} />
        ) : (
          chat.messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              chatId={chat.id}
              onOpenVersion={onOpenVersion}
              modelName={models.find((model) => model.id === chat.modelId)?.name ?? chat.modelId}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border bg-background px-3 pt-2.5 pb-3">
        {selection ? (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <MousePointerSquareDashed className="size-3.5" />
            <span className="truncate">
              已选中 <span className="font-medium text-foreground">{selection.label}</span>
              <span className="ml-1 font-mono text-[11px]">{selection.src}</span>
            </span>
            <button
              type="button"
              onClick={onClearSelection}
              className="ml-auto rounded p-0.5 hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.name + attachment.url.slice(-12)}
                className="group relative overflow-hidden rounded-md border border-border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={attachment.url}
                  alt={attachment.name}
                  className="h-14 w-20 object-cover"
                />
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[9px] text-white">
                  {attachment.name}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onAttachmentsChange(attachments.filter((item) => item.url !== attachment.url))
                  }
                  className="absolute top-0.5 right-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="rounded-xl border border-border bg-card px-2.5 pt-2 pb-1.5 transition-colors focus-within:border-foreground/30">
          <Textarea
            data-testid="chat-input"
            value={draft}
            disabled={awaiting}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={
              awaiting
                ? '请先审阅上方计划，再继续实施'
                : selection
                  ? '描述这个区块要改成什么样'
                  : '描述你想改的地方，Enter 发送'
            }
            className="min-h-12 resize-none border-0 bg-transparent px-0.5 py-1 text-[13px] leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="mt-1 flex items-center gap-1">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                onFile(event.target.files);
                event.target.value = '';
              }}
            />
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                <Paperclip className="size-3.5" />
                截图
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  截图作为本轮视觉参考
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => fileRef.current?.click()}
                  className="gap-2 text-sm"
                >
                  <ImagePlus className="size-4 text-muted-foreground" />
                  上传截图
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    onAttachmentsChange([
                      ...attachments,
                      { url: SAMPLE_SCREENSHOT, name: '参考截图.svg' },
                    ])
                  }
                  className="gap-2 text-sm"
                >
                  <ImagePlus className="size-4 text-muted-foreground" />
                  用一张示例截图
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <ModelSelect
              models={models}
              value={chat.modelId}
              onChange={(modelId) => setModel(chat.id, modelId)}
              compact
            />

            <button
              type="button"
              aria-pressed={planning}
              disabled={busy || awaiting}
              onClick={() => setPlanning((value) => !value)}
              className={cn(
                'rounded-md px-1.5 py-1 text-[11px] disabled:opacity-40',
                planning ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
              title="先提交计划，批准后再改文件"
            >
              {planning ? '先规划 ✓' : '先规划'}
            </button>
            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={toggleVoice}
                title="语音输入"
                className={cn(
                  'flex size-7 items-center justify-center rounded-md transition-colors',
                  listening
                    ? 'bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Mic className={cn('size-3.5', listening && 'animate-pulse')} />
              </button>
              {busy ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => stopGeneration(chat.id)}
                  className="h-7 gap-1 px-2 text-[11px]"
                >
                  <Square className="size-3 fill-current" />
                  停止
                </Button>
              ) : (
                <Button
                  size="icon"
                  data-testid="chat-send"
                  className="size-7 rounded-full"
                  onClick={submit}
                  disabled={awaiting || (!draft.trim() && attachments.length === 0)}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
              )}
            </span>
          </div>
        </div>
        <p className="mt-1.5 px-1 text-[10px] text-muted-foreground/70">
          Enter 发送 · Shift+Enter 换行 · 每轮回复留下一个版本
        </p>
      </div>
    </div>
  );
}

function EmptyChat({ project }: { project: Project }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Sparkles className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">新的对话</p>
      <p className="max-w-xs text-xs leading-5 text-muted-foreground">
        这个对话还没有消息。描述你要在这个项目里改什么，第一条回复会生成新的版本。
      </p>
      <p className="mt-1 max-w-xs rounded-md bg-muted/50 px-3 py-2 text-left text-[11px] leading-5 text-muted-foreground">
        项目：{project.name}
        <br />
        新对话从项目当前的源码树开始，历史消息不会带过来。
      </p>
    </div>
  );
}

function splitParts(message: Message) {
  const tools: Extract<Part, { type: 'tool' }>[] = [];
  const blocks: { tools: Extract<Part, { type: 'tool' }>[] }[] = [];
  let reasoning = '';
  let text = '';
  for (const part of message.parts) {
    if (part.type === 'tool') {
      if (!tools.length) blocks.push({ tools });
      tools.push(part);
      continue;
    }
    if (part.type === 'reasoning') reasoning += part.text;
    if (part.type === 'text') text += part.text;
  }
  const grouped = blocks.filter((block) => block.tools.length);
  return { groups: grouped, tools: grouped.flatMap((block) => block.tools), reasoning, text };
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function duration(startIso: string, endIso: string | undefined, now: number): string | null {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  const end = endIso ? Date.parse(endIso) : now;
  if (Number.isNaN(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function MessageRow({
  message,
  chatId,
  onOpenVersion,
  modelName,
}: {
  message: Message;
  chatId: string;
  onOpenVersion: (versionId: string) => void;
  modelName: string;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow(Boolean(message.streaming));
  const { groups, tools, reasoning, text } = splitParts(message);
  const streaming = Boolean(message.streaming);
  const status = message.status ?? (streaming ? 'running' : 'succeeded');
  const statusLabel = {
    running: '正在生成',
    awaiting_approval: '等待审阅',
    succeeded: '已完成',
    stopped: '已停止',
    failed: '检查失败',
    budget_exhausted: '达到本轮执行上限',
    rejected: '已拒绝',
  }[status];
  const successful = status === 'succeeded';
  const steps = tools.length + (reasoning ? 1 : 0);
  const took = message.finishedAt
    ? duration(message.createdAt, message.finishedAt, now)
    : streaming
      ? duration(message.createdAt, undefined, now)
      : null;

  if (message.role === 'user') {
    const images = message.parts.filter((part) => part.type === 'image');
    const body = message.parts.find((part) => part.type === 'text');
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] space-y-2">
          {images.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-2">
              {images.map((part, index) =>
                part.type === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={index}
                    src={part.url}
                    alt={part.name}
                    className="h-20 w-28 rounded-md border border-border object-cover"
                  />
                ) : null,
              )}
            </div>
          ) : null}
          {message.parts.map((part, index) =>
            part.type === 'selection' ? (
              <div
                key={index}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground"
              >
                <MousePointerSquareDashed className="size-3" />
                {part.selection.component}
                <span className="font-mono">{part.selection.src}</span>
              </div>
            ) : null,
          )}
          {body && body.type === 'text' ? (
            <div className="rounded-2xl bg-muted px-3.5 py-2.5 text-[13px] leading-6 whitespace-pre-wrap">
              {body.text}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5">
      <PaimengMark size={20} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {steps > 0 || message.status ? (
          <button
            type="button"
            data-testid={streaming ? 'fold-streaming' : 'fold-done'}
            onClick={() => setOpen((value) => !value)}
            className={cn(
              'group flex items-center gap-1.5 rounded-md border border-transparent px-1 py-0.5 text-[11px] transition-colors hover:border-border hover:bg-muted/50',
              streaming ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
            )}
          >
            {streaming ? (
              <Loader2 className="size-3 animate-spin" />
            ) : successful ? (
              <Check className="size-3 text-emerald-600" />
            ) : (
              <CircleAlert className="size-3 text-amber-600" />
            )}
            <span className="font-medium">
              {statusLabel} · {steps} 步
            </span>
            {took ? <span className="text-muted-foreground/70">· {took}</span> : null}
            <ChevronDown
              className={cn(
                'size-3 text-muted-foreground/60 transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
        ) : null}

        {open ? (
          <div className="mt-2 space-y-2 border-l border-border pl-2.5">
            {reasoning ? (
              <div className="flex gap-1.5 text-[11.5px] leading-5 text-muted-foreground">
                <Brain className="mt-0.5 size-3.5 shrink-0" />
                <p className="whitespace-pre-wrap">{reasoning}</p>
              </div>
            ) : null}
            {groups.map((group, index) => (
              <ToolGroup key={index} tools={group.tools} />
            ))}
          </div>
        ) : null}

        {message.parts.map((part, index) =>
          part.type === 'todos' ? (
            <TodosCard key={index} items={part.items} />
          ) : part.type === 'plan' ? (
            <PlanCard key={index} chatId={chatId} messageId={message.id} plan={part} />
          ) : null,
        )}
        {text ? (
          <div
            className={cn(
              'mt-2 text-[13px] leading-6 whitespace-pre-wrap',
              streaming &&
                'after:ml-0.5 after:inline-block after:h-3.5 after:w-1.5 after:animate-pulse after:bg-foreground/60 after:align-middle',
            )}
          >
            {text}
          </div>
        ) : null}

        {streaming && !text && steps === 0 ? (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            正在准备这一轮…
          </div>
        ) : null}

        {!streaming ? (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground/80">
            <span>{formatTime(message.createdAt)}</span>
            <span>·</span>
            <span>{modelName}</span>
            {message.versionId ? (
              <button
                type="button"
                onClick={() => onOpenVersion(message.versionId as string)}
                className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                查看版本
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const TOOL_META: Record<
  string,
  { icon: typeof Terminal; label: (input: Record<string, unknown>) => string }
> = {
  write_file: {
    icon: FilePlus2,
    label: (input) => `写入 ${String(input.path ?? '')}`,
  },
  list_files: { icon: FolderTree, label: () => '列出工作区文件' },
  run_command: { icon: Terminal, label: (input) => `运行 ${String(input.command ?? '')}` },
  web_search: { icon: Search, label: (input) => `搜索「${String(input.query ?? '')}」` },
  search_web: { icon: Search, label: (input) => `搜索「${String(input.query ?? '')}」` },
  fetch_url: { icon: Globe, label: (input) => `抓取 ${String(input.url ?? '')}` },
  read_file: { icon: FilePlus2, label: (input) => `读取 ${String(input.path ?? '')}` },
  edit_file: { icon: FilePlus2, label: (input) => `编辑 ${String(input.path ?? '')}` },
  glob_files: { icon: FolderTree, label: (input) => `查找 ${String(input.pattern ?? '')}` },
  grep_files: { icon: Search, label: (input) => `搜索代码 ${String(input.query ?? '')}` },
  move_file: {
    icon: FilePlus2,
    label: (input) => `${input.operation === 'copy' ? '复制' : '移动'} ${String(input.from ?? '')}`,
  },
  delete_file: { icon: FilePlus2, label: (input) => `删除 ${String(input.path ?? '')}` },
  read_skill_file: { icon: Sparkles, label: (input) => `读取技能参考 ${String(input.path ?? '')}` },
  verify_project: { icon: Check, label: (input) => `验证修订 ${String(input.revision ?? '')}` },
  complete_task: { icon: Check, label: () => '核对完成条件' },
  load_skill: { icon: Sparkles, label: (input) => `加载技能 ${String(input.skill ?? '')}` },
  read_attachment: {
    icon: ImageIcon,
    label: (input) => `读取截图 ${String(input.name ?? '')}`,
  },
};

function ToolGroup({ tools }: { tools: Extract<Part, { type: 'tool' }>[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const running = tools.some((tool) => tool.state === 'running');
  const failed = tools.some((tool) => tool.state === 'error');
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-1.5 border-b border-border/70 bg-muted/40 px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
        {running ? (
          <Loader2 className="size-3 animate-spin" />
        ) : failed ? (
          <CircleAlert className="size-3 text-amber-600" />
        ) : (
          <Check className="size-3 text-emerald-600" />
        )}
        工具调用 · {tools.length} 步
      </div>
      <div className="divide-y divide-border/60">
        {tools.map((tool) => {
          const meta = TOOL_META[tool.name] ?? { icon: Terminal, label: () => tool.name };
          const Icon = meta.icon;
          const expanded = open === tool.id;
          return (
            <div key={tool.id}>
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : tool.id)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/40"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground/70" />
                <span className="truncate font-mono text-[11px]">{meta.label(tool.input)}</span>
                <span className="ml-auto shrink-0">
                  {tool.state === 'running' ? (
                    <Loader2 className="size-3 animate-spin text-muted-foreground" />
                  ) : tool.state === 'error' ? (
                    <CircleAlert className="size-3 text-red-500" />
                  ) : (
                    <Check className="size-3 text-emerald-600" />
                  )}
                </span>
                <ChevronDown
                  className={cn(
                    'size-3 shrink-0 text-muted-foreground/50 transition-transform',
                    expanded && 'rotate-180',
                  )}
                />
              </button>
              {expanded ? (
                <div className="space-y-1.5 border-t border-border/60 bg-muted/30 px-2.5 py-2">
                  <div className="font-mono text-[10px] leading-4 break-all text-muted-foreground">
                    输入 {JSON.stringify(tool.input)}
                  </div>
                  {tool.output ? (
                    <pre className="max-h-32 overflow-auto rounded bg-card p-1.5 font-mono text-[10px] leading-4 whitespace-pre-wrap text-muted-foreground">
                      {tool.output}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
