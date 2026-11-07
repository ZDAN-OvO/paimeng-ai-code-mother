import { json, withErrors } from '@/mock/http';
import { stopRun } from '@/mock/scenario';

export const dynamic = 'force-dynamic';

export const POST = withErrors(
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    stopRun(id);
    return json({ ok: true }, 202);
  },
);
