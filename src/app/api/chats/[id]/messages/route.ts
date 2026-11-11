import { runAcceptedSchema, sendMessageRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/server/http';
import { startRun } from '@/server/agent/runner';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export const POST = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, sendMessageRequestSchema);
  return json(runAcceptedSchema.parse(await startRun(id, body.text)), 202);
});
