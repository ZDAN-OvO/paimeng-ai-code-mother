import { json, withErrors } from '@/mock/http';
import { listVersions } from '@/mock/world';

export const dynamic = 'force-dynamic';

export const GET = withErrors(
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return json({ versions: listVersions(id) });
  },
);
