import { patchProjectRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { deleteProject, renameProject } from '@/mock/world';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const PATCH = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, patchProjectRequestSchema);
  return json(renameProject(id, body.name));
});

export const DELETE = withErrors(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  deleteProject(id);
  return new Response(null, { status: 204 });
});
