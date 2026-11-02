import { afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeRateLimitRedis } from '@/server/infra/redis';

// 版本库已移出 Workspace：工作区里不再有能拦住向上查找的 .git，一条漏传 --git-dir 的 git
// 会一路找到开发仓库自己的 .git 并在它上面执行。把仓库发现的上限压到产品目录，漏传就直接失败。
process.env.GIT_CEILING_DIRECTORIES = fileURLToPath(new URL('../..', import.meta.url));

afterAll(async () => { await closeRateLimitRedis(); });
