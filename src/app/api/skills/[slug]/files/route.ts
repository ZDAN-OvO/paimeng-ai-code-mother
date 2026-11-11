import { json, withErrors } from '@/mock/http';
import { ApiError, findProject } from '@/mock/world';
import { catalogForProject } from '@/server/skills/context';
import { readSkillFile, SkillReadError } from '@/server/skills/catalog';

export const dynamic = 'force-dynamic';

export const GET = withErrors(
  async (request: Request, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params;
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId');
    const relativePath = url.searchParams.get('path') ?? 'SKILL.md';
    const catalog = await catalogForProject(projectId ? findProject(projectId) : undefined);
    try {
      const content = await readSkillFile(catalog, slug, relativePath);
      return json({ name: slug, path: relativePath, content });
    } catch (error) {
      if (error instanceof SkillReadError) throw new ApiError(error.status, error.message);
      throw error;
    }
  },
);
