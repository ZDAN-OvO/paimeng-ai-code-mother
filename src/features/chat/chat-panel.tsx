'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronDown,
  CircleStop,
  Clock3,
  Code2,
  Loader2,
  ShieldAlert,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/features/chat/markdown';
import { ModelSelect } from '@/features/home/model-select';
import { useWorkspace } from '@/features/workspace/workspace-store';
import { cn } from '@/lib/utils';
import { formatTime } from '@/lib/time';
import type { ApprovalStatus, Message, Part, RunStatus } from '@/shared/api/schemas';

const TOOL_LABEL: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  grep: '搜索内容',
  find: '查找文件',
  ls: '列出目录',
  bash: '运行命令',
};

function runStatusText(status: RunStatus, stopReason?: string, error?: string): string {
  if (status === 'running') return '正在执行';
  if (status === 'awaiting_approval') return '等待命令批准';
  if (status === 'succeeded') return '本轮已结束';
  if (status === 'failed') return error ? `失败：${error}` : '失败';
  if (stopReason === 'user_stop') return '已停止（用户停止）';
  if (stopReason === 'service_restart') return '已停止（服务重启）';
  return stopReason ? `已停止（${stopReason}）` : '已停止';
}

function statusStyle(status: RunStatus): string {
  if (status === 'running') return 'border-emerald-500/40 text-emerald-600';
  if (status === 'awaiting_approval') return 'border-amber-500/40 text-amber-600';
  if (status === 'failed') return 'border-destructive/40 text-destructive';
  return 'border-border text-muted-foreground';
}

function ToolPart({ part }: { part: Extract<Part, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const label = TOOL_LABEL[part.name];
  const stateLabel =
    part.state === 'running'
      ? '运行中'
      : part.state === 'awaiting_approval'
        ? '待批准'
        : part.state === 'error'
          ? '出错'
          : '已完成';
  const hasDetails = Object.keys(part.input).length > 0 || part.output || part.error;

  return (
    <div className="rounded-lg border border-border bg-card/60">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Code2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium">{label ?? part.name}</span>
          {label ? (
            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{part.name}</span>
          ) : null}
        </span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-[10px]',
            part.state === 'error' && 'text-destructive',
            part.state === 'running' && 'text-emerald-600',
            part.state === 'awaiting_approval' && 'text-amber-600',
            part.state === 'done' && 'text-muted-foreground',
          )}
        >
          {part.state === 'running' ? <Loader2 className="size-3 animate-spin" /> : null}
          {stateLabel}
        </span>
        {hasDetails ? (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        ) : null}
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <div>
            <p className="mb-1 text-[10px] font-medium text-muted-foreground">输入</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-[10px] leading-4">
              {JSON.stringify(part.input, null, 2)}
            </pre>
          </div>
          {part.output ? (
            <div>
              <p className="mb-1 text-[10px] font-medium text-muted-foreground">输出</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-[10px] leading-4">
                {part.output}
              </pre>
            </div>
          ) : null}
          {part.error ? (
            <div>
              <p className="mb-1 text-[10px] font-medium text-destructive">错误</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-destructive/20 bg-destructive/5 p-2 font-mono text-[10px] leading-4 text-destructive">
                {part.error}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  pending: '等待批准',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已失效',
};

function ApprovalPart({
  part,
  onDecide,
}: {
  part: Extract<Part, { type: 'approval' }>;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
}) {
  const [deciding, setDeciding] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = part.status === 'pending';

  async function decide(decision: 'approved' | 'rejected') {
    if (!pending || deciding) return;
    setDeciding(decision);
    setError(null);
    try {
      await onDecide(part.approvalId, decision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交批准结果失败，请重试。');
    } finally {
      setDeciding(null);
    }
  }

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        pending ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-card/60',
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldAlert
          className={cn('size-4 shrink-0', pending ? 'text-amber-600' : 'text-muted-foreground')}
        />
        <p className="min-w-0 flex-1 text-xs font-medium">命令需要确认</p>
        <Badge
          variant="outline"
          className={cn(
            'h-5 text-[10px]',
            part.status === 'approved' && 'border-emerald-500/40 text-emerald-600',
            part.status === 'rejected' && 'border-destructive/40 text-destructive',
            pending && 'border-amber-500/40 text-amber-700 dark:text-amber-400',
          )}
        >
          {APPROVAL_LABEL[part.status]}
        </Badge>
      </div>
      <div className="mt-2 space-y-1.5">
        <pre className="overflow-x-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-5">
          {part.command}
        </pre>
        <p className="break-all font-mono text-[10px] text-muted-foreground">目录：{part.cwd}</p>
        {part.reason ? (
          <p className="break-words text-[11px] leading-5 text-muted-foreground">{part.reason}</p>
        ) : null}
        <p className="break-words text-[10px] leading-5 text-muted-foreground">
          关键词规则只是操作提醒，不是隔离边界；批准前请自行确认命令内容。
        </p>
      </div>
      {error ? <p className="mt-2 break-words text-[10px] text-destructive">{error}</p> : null}
      {pending ? (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            className="h-7 gap-1 text-[11px]"
            disabled={deciding !== null}
            onClick={() => void decide('approved')}
          >
            {deciding === 'approved' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Check className="size-3" />
            )}
            批准并运行
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            disabled={deciding !== null}
            onClick={() => void decide('rejected')}
          >
            {deciding === 'rejected' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <X className="size-3" />
            )}
            拒绝
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AssistantMessage({
  message,
  run,
  summary,
  decidingApproval,
  onDecideApproval,
  onShowChanges,
}: {
  message: Message;
  run: { id: string; status: RunStatus; messageId: string } | null;
  summary?: string;
  decidingApproval: string | null;
  onDecideApproval: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onShowChanges: () => void;
}) {
  const liveStatus = run?.messageId === message.id ? run.status : undefined;
  const status = liveStatus ?? message.status ?? (message.streaming ? 'running' : undefined);
  const statusText = status ? runStatusText(status, message.stopReason, message.error) : null;
  const hasText = message.parts.some((part) => part.type === 'text' && part.text.trim());

  return (
    <div className="group min-w-0">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">助手</span>
        <span className="text-[10px] text-muted-foreground/70">
          {formatTime(message.createdAt)}
        </span>
      </div>
      <div className="space-y-2.5">
        {message.parts.map((part) => {
          if (part.type === 'text') {
            if (!part.text) return null;
            return <Markdown key={part.id} text={part.text} />;
          }
          if (part.type === 'tool') return <ToolPart key={part.id} part={part} />;
          return (
            <ApprovalPart
              key={part.id}
              part={part}
              onDecide={async (approvalId, decision) => {
                if (decidingApproval) return;
                await onDecideApproval(approvalId, decision);
              }}
            />
          );
        })}
        {!hasText && message.parts.every((part) => part.type === 'text') && status === 'running' ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            正在思考…
          </div>
        ) : null}
      </div>
      {summary ? (
        <p className="mt-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] leading-5 text-muted-foreground">
          {summary}
        </p>
      ) : null}
      {statusText ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn('h-5 gap-1 text-[10px]', statusStyle(status ?? 'succeeded'))}
          >
            {status === 'running' ? <Loader2 className="size-3 animate-spin" /> : null}
            {status === 'awaiting_approval' ? <Clock3 className="size-3" /> : null}
            {status === 'failed' ? <AlertCircle className="size-3" /> : null}
            {statusText}
          </Badge>
          {message.changeSetId ? (
            <button
              type="button"
              onClick={onShowChanges}
              className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              查看本轮改动
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ChatPanel({ onShowChanges }: { onShowChanges: () => void }) {
  const {
    bundle,
    messages,
    models,
    run,
    summaries,
    error,
    stopping,
    sendMessage,
    stopRun,
    decideApproval,
    setModel,
  } = useWorkspace();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [decidingApproval, setDecidingApproval] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const configuredModels = models.filter((model) => model.configured);
  const busy =
    run?.status === 'running' ||
    run?.status === 'awaiting_approval' ||
    bundle?.chat.streaming === true ||
    bundle?.chat.pendingApproval === true;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [messages, run]);

  async function submit() {
    const text = draft.trim();
    if (!text || sending || busy) return;
    setSending(true);
    const ok = await sendMessage(text);
    setSending(false);
    if (ok) setDraft('');
  }

  async function decide(approvalId: string, decision: 'approved' | 'rejected') {
    setDecidingApproval(approvalId);
    try {
      await decideApproval(approvalId, decision);
    } finally {
      setDecidingApproval(null);
    }
  }

  if (!bundle) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        正在打开对话…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-3 py-4 sm:px-5">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <p className="text-sm font-medium">开始处理 {bundle.project.name}</p>
              <p className="max-w-sm text-[11px] leading-5 text-muted-foreground">
                说明你想改什么、查什么或运行什么。助手会读取项目文件，并在需要时请求运行命令的批准。
              </p>
            </div>
          ) : (
            messages.map((message) =>
              message.role === 'user' ? (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[88%] rounded-2xl rounded-br-md bg-foreground px-3.5 py-2 text-[13px] leading-6 text-background">
                    <p className="whitespace-pre-wrap break-words">
                      {message.parts
                        .filter(
                          (part): part is Extract<Part, { type: 'text' }> => part.type === 'text',
                        )
                        .map((part) => part.text)
                        .join('')}
                    </p>
                    <p className="mt-1 text-right text-[9px] opacity-60">
                      {formatTime(message.createdAt)}
                    </p>
                  </div>
                </div>
              ) : (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  run={run}
                  summary={summaries[message.id]}
                  decidingApproval={decidingApproval}
                  onDecideApproval={decide}
                  onShowChanges={onShowChanges}
                />
              ),
            )
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-background px-3 pb-3 pt-2 sm:px-5">
        <div className="mx-auto w-full max-w-3xl">
          {configuredModels.length === 0 ? (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-5 text-amber-800 dark:text-amber-300">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <p>
                尚未配置模型。请在项目根目录的 <span className="font-mono">.env</span> 中设置{' '}
                <span className="font-mono">AI_BASE_URL</span>、
                <span className="font-mono">AI_MODEL</span> 和{' '}
                <span className="font-mono">AI_API_KEY</span>，然后重启服务。
              </p>
            </div>
          ) : null}
          {error ? (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] leading-5 text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <p className="break-words">{error}</p>
            </div>
          ) : null}
          <div className="rounded-xl border border-border bg-card focus-within:border-foreground/30">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={
                busy ? '本轮结束后可以继续发送…' : '描述要完成的事，Enter 发送，Shift+Enter 换行'
              }
              disabled={sending || busy}
              rows={3}
              className="min-h-16 resize-none border-0 bg-transparent text-[13px] shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center gap-1.5 border-t border-border/70 px-2 py-1.5">
              <ModelSelect
                models={models}
                value={bundle.chat.modelId}
                onChange={(modelId) => void setModel(modelId)}
                disabled={busy}
                compact
              />
              <span className="ml-auto text-[10px] text-muted-foreground">
                {busy ? '助手正在处理这一轮' : '助手会按需读取项目文件'}
              </span>
              {busy ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[11px]"
                  disabled={stopping}
                  onClick={() => void stopRun()}
                >
                  {stopping ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <CircleStop className="size-3" />
                  )}
                  {stopping ? '正在停止…' : '停止'}
                </Button>
              ) : (
                <Button
                  size="icon"
                  className="size-7 rounded-full"
                  disabled={!draft.trim() || sending}
                  onClick={() => void submit()}
                  title="发送"
                >
                  {sending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="size-3.5" />
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
