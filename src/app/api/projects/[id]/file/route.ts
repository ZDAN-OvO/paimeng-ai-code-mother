import { fileWindowSchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { projectRoot } from '@/server/projects';
import { readFileWindow, resolveExistingPath } from '@/server/projects/workspace';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export const GET = withErrors(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const url = new URL(request.url);
  const relative = url.searchParams.get('path');
  if (!relative) return json({ error: '缺少 path 参数' }, 400);
  const offset = Math.max(1, Number(url.searchParams.get('offset') ?? '1') || 1);
  const limit = Math.min(
    2000,
    Math.max(1, Number(url.searchParams.get('limit') ?? '2000') || 2000),
  );
  const root = await projectRoot(id);
  const target = await resolveExistingPath(root, relative);
  const window = await readFileWindow(target.absolute, target.relative, offset, limit);
  return json(fileWindowSchema.parse(window));
});
