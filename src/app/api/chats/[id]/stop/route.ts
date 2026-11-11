import { json, withErrors } from '@/server/http';
import { stopRun } from '@/server/agent/runner';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export const POST = withErrors(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  await stopRun(id);
  return json({ ok: true }, 202);
});
