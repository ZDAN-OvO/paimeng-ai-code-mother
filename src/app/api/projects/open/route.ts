import { openProjectRequestSchema, openProjectResponseSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/server/http';
import { openProject } from '@/server/projects';

export const dynamic = 'force-dynamic';

export const POST = withErrors(async (request: Request) => {
  const body = await parseBody(request, openProjectRequestSchema);
  return json(openProjectResponseSchema.parse(await openProject(body.workspacePath)), 201);
});
