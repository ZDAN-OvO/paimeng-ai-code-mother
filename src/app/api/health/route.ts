import { spawnSync } from 'node:child_process';
import { rgPath } from '@vscode/ripgrep';
import { healthResponseSchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { ping, sqlite } from '@/server/db';

export const dynamic = 'force-dynamic';

function version(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) return '';
  return (result.stdout || result.stderr).trim().split('\n')[0] ?? '';
}

export const GET = withErrors(async () => {
  const checks = {
    node: process.version,
    git: version('git', ['--version']),
    bash: version('bash', ['--version']),
    ripgrep: version(rgPath, ['--version']),
    database: ping() ? 'ok' : '',
  };
  const problems: string[] = [];
  if (!checks.git) problems.push('未找到可用的 git');
  if (!checks.bash) problems.push('未找到可用的 bash');
  if (!checks.ripgrep) problems.push('未找到可用的 ripgrep');
  if (!checks.database) problems.push('SQLite 数据库不可用');
  const response = { ok: problems.length === 0, checks, problems };
  try {
    sqlite();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : '数据库初始化失败');
  }
  return json(healthResponseSchema.parse({ ...response, problems }));
});
