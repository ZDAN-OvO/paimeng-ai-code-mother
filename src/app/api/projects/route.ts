import { projectsResponseSchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { listProjects } from '@/server/projects';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async () => {
  return json(projectsResponseSchema.parse({ projects: await listProjects() }));
});
