import { execFileSync } from 'node:child_process';

/**
 * 按运行标签停掉本轮 runtime 容器。
 *
 * 只认 `paimeng.run=<runId>`：同一台机器上别的 checkout、别的测试轮次的容器不归本轮清理。
 * Docker 不可用或标签不合法时什么都不做，也不抛错——停进程的主流程不能被清理拖垮。
 */
export function stopRunContainers(runId: string): { removed: number; failed: number } {
  if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(runId)) return { removed: 0, failed: 0 };
  let ids: string[];
  try {
    ids = execFileSync('docker', ['ps', '-aq', '--filter', `label=paimeng.run=${runId}`], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return { removed: 0, failed: 0 };
  }
  let removed = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
