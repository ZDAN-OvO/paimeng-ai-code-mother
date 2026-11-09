import { json, withErrors } from '@/mock/http';
import { versionDiff } from '@/mock/world';

export const dynamic = 'force-dynamic';

export const GET = withErrors(
  async (_request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) => {
    const { id, versionId } = await params;
    return json(versionDiff(id, versionId));
  },
);
