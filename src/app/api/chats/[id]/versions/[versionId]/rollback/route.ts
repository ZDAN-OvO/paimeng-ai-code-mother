import { json, withErrors } from '@/mock/http';
import { rollbackTo } from '@/mock/world';

export const dynamic = 'force-dynamic';

export const POST = withErrors(
  async (_request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) => {
    const { id, versionId } = await params;
    return json(rollbackTo(id, versionId), 201);
  },
);
