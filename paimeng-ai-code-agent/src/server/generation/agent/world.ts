import 'server-only';
import { getWorld } from 'workflow/runtime';

/** 与同库其他应用隔离；旧 pi-durable 的表在 paimeng_agent 里，靠前缀区分队列。 */
export const agentJobPrefix = 'paimeng_agent_';

/**
 * 崩溃恢复上限：PR-00 实测默认 0 时 `kill -9` 后运行在 90 秒内不恢复，
 * 30 秒配置下同一运行 28 秒完成。所有共享这个库的进程必须用同一个值。
 */
export const agentJobLockStaleSeconds = 30;

/** World 由 `WORKFLOW_TARGET_WORLD` 在运行时动态加载，不能静态 import 进 Next 的任一层。 */
export function assertAgentWorldEnv() {
  if (process.env.WORKFLOW_TARGET_WORLD !== '@workflow/world-postgres')
    throw new Error('GENERATION_ENGINE=agent 需要 WORKFLOW_TARGET_WORLD=@workflow/world-postgres');
  if (!process.env.WORKFLOW_POSTGRES_URL)
    throw new Error('GENERATION_ENGINE=agent 需要 WORKFLOW_POSTGRES_URL 指向 paimeng_agent');
  if (process.env.WORKFLOW_POSTGRES_JOB_PREFIX !== agentJobPrefix)
    throw new Error(`WORKFLOW_POSTGRES_JOB_PREFIX 必须是 ${agentJobPrefix}`);
}

type AgentWorld = Awaited<ReturnType<typeof getWorld>>;

// Next 会为每个 layer 单独打包一份模块；启动状态必须挂在 globalThis 上，否则同一进程会起两个 worker。
const state = globalThis as typeof globalThis & { __agentWorldStarting?: Promise<AgentWorld> };

/** 同一个进程只启动一次；Next 的 instrumentation 与独立 worker 二选一。 */
export function startAgentWorld(): Promise<AgentWorld> {
  state.__agentWorldStarting ??= (async () => {
    assertAgentWorldEnv();
    const world = await getWorld();
    await world.start?.();
    return world;
  })();
  return state.__agentWorldStarting;
}

export async function stopAgentWorld() {
  if (!state.__agentWorldStarting) return;
  const world = await state.__agentWorldStarting;
  state.__agentWorldStarting = undefined;
  await world.close?.();
}
