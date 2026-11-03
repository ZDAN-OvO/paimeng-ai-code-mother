import 'server-only';
import { BusinessError } from '../infra/http';
import { getConfig } from '../infra/config';
import { settleGenerationBilling } from '../billing/settlement';
import { generationControl } from '../generation/generation-store';
import { queuePosition } from './capacity';
import {
  deleteQueueTicket, failQueuedGeneration, heartbeatQueueTicket, queueWaitExpired, readQueueTicket,
  reserveRuntimeTicket, waitingQueue, type SlotReservation,
} from './queue';
import { maintainRuntimeCapacity, startRuntimeMaintenance } from './supervisor';
import type { QueueApp } from './queue';

/**
 * 运行时槽位的准入与等待。
 *
 * Generation 的写权限只在真正开始执行时才拿；没有槽位时它先落成 `queued`，由这里等待：
 * - 等待截止 = min(本轮绝对 Deadline, 入队时间 + 排队等待上限)，到达就落 failed/timeout；
 * - 排队、唤醒等待不产生 Credit（没有执行行与模型步骤）；
 * - 取消由 `cancelQueuedGeneration` 落终态并删排队记录，等待方看到记录消失后退出；
 * - 崩溃/重启留下的等待者由心跳超时收成 failed/interrupted，不会被重新启动。
 */

export type QueuedWaitInfo = { position: number; waitDeadline: string };

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms));
}

export type RuntimeSlotPlan = {
  app: QueueApp;
  generationId: string;
  holder: string;
  /** true 表示这一轮已经在排队记录里等位（granted 之前不进执行）。 */
  waiting: boolean;
  /** 等待期间的可读进度回调（用于 SSE 的排队事件）。 */
  onQueued?: (info: QueuedWaitInfo) => void;
};

/** 轻量/静态应用不需要 runtime，也就没有容量这一说；只有构建类应用会走到这里。 */
export async function reserveRuntimeSlot(input: {
  app: QueueApp;
  generationId: string;
  holder: string;
  deadline: string | null;
}): Promise<SlotReservation> {
  startRuntimeMaintenance();
  return reserveRuntimeTicket(input);
}

/** 等待 granted；已 granted/已有 runtime 时立即返回。超时或取消抛可读 BusinessError。 */
export async function awaitRuntimeSlot(plan: RuntimeSlotPlan): Promise<void> {
  if (!plan.waiting) return;
  startRuntimeMaintenance();
  const pollMs = getConfig().appRuntime.queuePollMs;
  let lastPosition = 0;
  for (;;) {
    const ticket = await readQueueTicket(plan.app);
    if (!ticket || ticket.generationId !== plan.generationId) {
      const control = await generationControl(plan.generationId);
      if (control?.status === 'cancelled') throw new BusinessError(409, 40900, '排队已取消，生成没有开始');
      if (control?.status === 'failed') throw new BusinessError(409, 40900, control.error ?? '排队已结束，生成没有开始');
      throw new BusinessError(409, 40900, '排队记录已失效，请重新提交');
    }
    if (ticket.state === 'granted') return;
    if (await queueWaitExpired(plan.app)) {
      const message = '排队等待超时，还没有空出运行时槽位；请稍后重新提交';
      const settled = await failQueuedGeneration({
        app: plan.app, generationId: plan.generationId, status: 'failed', error: message, stopReason: 'timeout',
      });
      if (settled) await settleGenerationBilling(plan.generationId);
      throw new BusinessError(429, 42902, message);
    }
    // 回收空闲 runtime、为等待者腾一格、批准队首；等待方自己也参与推进，不依赖某个常驻进程。
    await maintainRuntimeCapacity().catch(error => console.warn(`运行时容量维护失败：${(error as Error).message}`));
    const current = await readQueueTicket(plan.app);
    if (current?.state === 'granted') return;
    if (current && current.generationId === plan.generationId) {
      await heartbeatQueueTicket(plan.app, plan.generationId);
      const position = queuePosition(await waitingQueue(), plan.app.id) ?? lastPosition;
      lastPosition = position;
      plan.onQueued?.({ position, waitDeadline: current.waitDeadline });
    }
    await sleep(pollMs);
  }
}

/** 启动执行前确认这一轮仍然持有槽位（granted 或已有 runtime）。 */
export async function claimRuntimeSlot(input: { app: QueueApp; generationId: string }): Promise<void> {
  const ticket = await readQueueTicket(input.app);
  if (!ticket) return;
  if (ticket.generationId !== input.generationId) throw new BusinessError(409, 40900, '运行时槽位已归属另一轮生成');
  if (ticket.state !== 'granted') throw new BusinessError(409, 40900, '还没有获得运行时槽位');
}

/** 这轮生成不再需要这张排队/占位记录（收束、创建 runtime 失败、取消）。 */
export async function releaseRuntimeSlot(app: QueueApp, generationId?: string): Promise<void> {
  await deleteQueueTicket(app, generationId).catch(() => false);
}

/** 取消排队中的 Generation：落 cancelled 终态、删排队记录，并补一次 0 消耗结算。 */
export async function cancelQueuedGeneration(input: { app: QueueApp; generationId: string }): Promise<boolean> {
  const settled = await failQueuedGeneration({
    app: input.app, generationId: input.generationId, status: 'cancelled', error: '生成已取消', stopReason: 'cancelled',
  });
  if (settled) await settleGenerationBilling(input.generationId);
  return settled;
}

/** 状态读取用的排队视图：position 从 1 开始，`waiting` 是队列总长。 */
export async function queuedGenerationView(app: QueueApp): Promise<{ position: number; waiting: number; waitDeadline: string } | null> {
  const ticket = await readQueueTicket(app);
  if (!ticket || ticket.state !== 'waiting') return null;
  const waiting = await waitingQueue();
  const position = queuePosition(waiting, app.id);
  return position === null ? null : { position, waiting: waiting.length, waitDeadline: ticket.waitDeadline };
}
