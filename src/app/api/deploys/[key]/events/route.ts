import type { DeployEvent } from '@/shared/api/schemas';
import { getRun, sseResponse } from '@/mock/runs';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const run = getRun<DeployEvent>(`deploy:${key}`);
  if (!run) {
    return Response.json({ error: '没有这次发布的构建过程' }, { status: 404 });
  }
  return sseResponse(run);
}
