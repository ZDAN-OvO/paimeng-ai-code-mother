import { json, withErrors } from '@/mock/http';
import { restoreChat } from '@/mock/world';

export const dynamic = 'force-dynamic';

export const POST = withErrors(
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return json(restoreChat(id));
  },
);
