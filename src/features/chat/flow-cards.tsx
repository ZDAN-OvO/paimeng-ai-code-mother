'use client';

import { useState } from 'react';
import { Check, Circle, CircleAlert, ListTodo, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/features/workspace/workspace-store';
import type { Part, TodoItem } from '@/shared/api/schemas';
type PlanPart = Extract<Part, { type: 'plan' }>;
type ReviewPart = Extract<Part, { type: 'review' }>;

export function TodosCard({ items }: { items: TodoItem[] }) {
  return (
    <div
      data-testid="agent-todos"
      className="my-3 rounded-lg border border-border bg-card p-3 text-xs"
    >
      <div className="mb-2 flex items-center gap-2 font-medium">
        <ListTodo className="size-3.5" />
        本轮任务
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">
          {items.filter((item) => item.status === 'completed').length}/{items.length}
        </span>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.id}
            data-status={item.status}
            className="flex items-center gap-2 text-muted-foreground"
          >
            {item.status === 'completed' ? (
              <Check className="size-3.5 text-emerald-600" />
            ) : item.status === 'in_progress' ? (
              <Loader2 className="size-3.5" />
            ) : (
              <Circle className="size-3.5" />
            )}
            <span className={item.status === 'in_progress' ? 'text-foreground' : ''}>
              {item.label}
            </span>
            <span className="ml-auto text-[10px]">
              {item.status === 'completed'
                ? '完成'
                : item.status === 'in_progress'
                  ? '进行中'
                  : '待处理'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlanCard({
  chatId,
  messageId,
  plan,
}: {
  chatId: string;
  messageId: string;
  plan: PlanPart;
}) {
  const { state, resolvePlan } = useWorkspace();
  const [feedback, setFeedback] = useState('');
  const pending = state.chats.find((chat) => chat.id === chatId)?.pendingPlan;
  const active =
    plan.status === 'pending' &&
    pending?.messageId === messageId &&
    pending.revision === plan.revision;
  const labels = {
    pending: '等待审阅',
    approved: '已批准',
    changes_requested: '已要求修改',
    rejected: '已拒绝',
  };
  return (
    <section data-testid="plan-card" className="my-3 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-xs font-medium">
        <ShieldCheck className="size-3.5" />
        实施计划 <span className="font-normal text-muted-foreground">第 {plan.revision} 版</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{labels[plan.status]}</span>
      </div>
      <p className="mt-2 text-xs leading-5">{plan.title}</p>
      <ol className="mt-3 list-decimal space-y-2 pl-4 text-xs leading-5 text-muted-foreground">
        {plan.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
        只读规划期间不修改项目文件，批准仅适用于本版方案。
      </p>
      {plan.feedback ? (
        <p className="mt-2 rounded bg-muted px-2 py-1.5 text-xs">修改意见：{plan.feedback}</p>
      ) : null}
      {active ? (
        <div className="mt-3 space-y-2">
          <Textarea
            aria-label="计划修改意见"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="需要调整？写下修改意见后点“要求修改”。"
            className="min-h-16 text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              data-testid="plan-approve"
              className="h-7 text-xs"
              onClick={() => resolvePlan(chatId, messageId, plan.revision, 'approved')}
            >
              批准并开始
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="plan-request-changes"
              className="h-7 text-xs"
              disabled={!feedback.trim()}
              onClick={() =>
                resolvePlan(chatId, messageId, plan.revision, 'changes_requested', feedback)
              }
            >
              要求修改
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="plan-reject"
              className="h-7 text-xs"
              onClick={() => resolvePlan(chatId, messageId, plan.revision, 'rejected')}
            >
              拒绝实施
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const REVIEW_NAME = { code: 'Code review', completion: 'Completion review' } as const;

/** 一次 review subagent 调用：第几轮、审的是哪一版修订、结论与打回理由。 */
export function ReviewCard({ review }: { review: ReviewPart }) {
  const rejected = review.verdict === 'changes_requested';
  const label =
    review.state === 'running'
      ? '审查中'
      : review.state === 'error'
        ? '没有结论'
        : rejected
          ? '打回'
          : '通过';
  return (
    <div
      data-testid="agent-review"
      data-kind={review.kind}
      data-verdict={review.verdict ?? review.state}
      className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5">
        {review.state === 'running' ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
        ) : review.state === 'error' || rejected ? (
          <CircleAlert className="size-3.5 text-amber-600" aria-hidden />
        ) : (
          <ShieldCheck className="size-3.5 text-emerald-600" aria-hidden />
        )}
        <span className="font-medium">
          {REVIEW_NAME[review.kind]} · 第 {review.round} 轮
        </span>
        <span
          className={
            rejected || review.state === 'error'
              ? 'text-amber-700 dark:text-amber-400'
              : 'text-muted-foreground'
          }
        >
          {label}
        </span>
        <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground/70">
          {review.revision}
        </span>
      </div>
      <div className="mt-1 text-[10.5px] text-muted-foreground">范围：{review.scope}</div>
      {review.findings?.length ? (
        <ul
          aria-label="打回理由"
          className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] leading-5"
        >
          {review.findings.map((finding) => (
            <li key={finding}>{finding}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
