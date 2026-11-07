import { envRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { setProjectEnv } from '@/mock/world';

export const dynamic = 'force-dynamic';

export const PUT = withErrors(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const body = await parseBody(request, envRequestSchema);
    return json(setProjectEnv(id, body.env));
  },
);
