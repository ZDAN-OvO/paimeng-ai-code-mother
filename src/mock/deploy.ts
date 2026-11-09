import type { DeployEvent } from '@/shared/api/schemas';
import { finishDeploy, recordDeploy } from './world';
import { getRun, openRun, pushEvent } from './runs';

const STEPS = [
  '导出源码树',
  '在沙箱里执行 next build',
  '复制 .next/standalone 产物',
  '启动只读 runner 容器',
  '把 /deploys/<deployKey> 指到新容器',
];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runSteps(runId: string, deployId: string) {
  const run = getRun<DeployEvent>(runId);
  if (!run) return;
  for (const step of STEPS) {
    pushEvent(run, { type: 'step', step, state: 'running' });
    await wait(260);
    pushEvent(run, { type: 'step', step, state: 'done' });
  }
  const deploy = finishDeploy(deployId, 'ready');
  pushEvent(run, {
    type: 'finish',
    deployKey: deploy.deployKey,
    state: deploy.state === 'failed' ? 'failed' : 'ready',
  });
  run.close();
}

export function startDeploy(projectId: string, versionId: string) {
  const deploy = recordDeploy(projectId, versionId);
  const runId = `deploy:${deploy.id}`;
  openRun<DeployEvent>(runId);
  void runSteps(runId, deploy.id);
  return { deploy, eventsUrl: `/api/deploys/${deploy.id}/events` };
}
