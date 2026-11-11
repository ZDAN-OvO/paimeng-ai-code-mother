import {
  patchProjectRequestSchema,
  projectDetailSchema,
  projectSchema,
} from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/server/http';
import { deleteProject, getProject, listChats, renameProject } from '@/server/projects';
import { changesetsForProject } from '@/server/agent/changes';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export const GET = withErrors(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const project = await getProject(id);
  const page = changesetsForProject(id, undefined, 20);
  return json(
    projectDetailSchema.parse({
      project,
      chats: listChats(id),
      changeSets: page.changeSets,
      nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
    }),
  );
});

export const PATCH = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = await parseBody(request, patchProjectRequestSchema);
  renameProject(id, body.name);
  return json(projectSchema.parse(await getProject(id)));
});

export const DELETE = withErrors(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  await deleteProject(id);
  return new Response(null, { status: 204 });
});
