import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { withWorkspaceWrite } from '@/server/generation/control-store';
import { getPool } from '@/server/infra/db';

const input = JSON.parse(process.argv[2]) as { appId: string; generationId: string; epoch: number; executionId: string; root: string };
try {
  await withWorkspaceWrite(input, async () => {
    process.send?.('admitted');
    await once(process, 'message');
    await writeFile(join(input.root, 'index.html'), 'late old writer');
  });
  process.send?.('written');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await getPool().end();
  process.disconnect?.();
}
