import { sendMessageRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { sendMessage } from '@/mock/scenario';

export const dynamic = 'force-dynamic';

export const POST = withErrors(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const body = await parseBody(request, sendMessageRequestSchema);
    return json(sendMessage(id, body), 202);
  },
);
