import { deployRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { startDeploy } from '@/mock/deploy';
import { listDeploys } from '@/mock/world';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const GET = withErrors(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  return json({ deploys: listDeploys(id) });
});

export const POST = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, deployRequestSchema);
  const { deploy, eventsUrl } = startDeploy(id, body.versionId);
  return json({ deploy, eventsUrl }, 201);
});
