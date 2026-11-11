import { json, withErrors } from '@/mock/http';
import { findProject, listSkills } from '@/mock/world';
import { catalogForProject } from '@/server/skills/context';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async (request: Request) => {
  const projectId = new URL(request.url).searchParams.get('projectId');
  const catalog = await catalogForProject(projectId ? findProject(projectId) : undefined);
  return json({ skills: listSkills(), catalog });
});
