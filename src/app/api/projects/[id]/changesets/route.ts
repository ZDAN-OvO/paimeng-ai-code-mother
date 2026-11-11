import { changesetsResponseSchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { getProjectRow } from '@/server/projects';
import { changesetsForProject } from '@/server/agent/changes';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export const GET = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  if (!getProjectRow(id)) return json({ error: '项目不存在' }, 404);
  const url = new URL(request.url);
  const cursor = Number(url.searchParams.get('cursor') ?? '') || undefined;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20));
  const page = changesetsForProject(id, cursor, limit);
  return json(
    changesetsResponseSchema.parse({
      changeSets: page.changeSets,
      nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
    }),
  );
});
