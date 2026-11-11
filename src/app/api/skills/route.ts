import { skillCatalogSchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { discoverSkills } from '@/server/skills/catalog';
import { projectRoot } from '@/server/projects';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async (request: Request) => {
  const projectId = new URL(request.url).searchParams.get('projectId');
  const catalog = await discoverSkills({
    projectPath: projectId ? await projectRoot(projectId) : undefined,
  });
  return json(skillCatalogSchema.parse(catalog));
});
