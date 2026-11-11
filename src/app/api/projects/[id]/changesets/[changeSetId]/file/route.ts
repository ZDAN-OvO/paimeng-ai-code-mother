import { changeSetFileResponseSchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { changeVersions } from '@/server/agent/changes';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string; changeSetId: string }> };

export const GET = withErrors(async (request: Request, { params }: Params) => {
  const { id, changeSetId } = await params;
  const relative = new URL(request.url).searchParams.get('path');
  if (!relative) return json({ error: '缺少 path 参数' }, 400);
  const versions = changeVersions(id, changeSetId, relative);
  if (!versions) return json({ error: '改动文件不存在' }, 404);
  return json(changeSetFileResponseSchema.parse(versions));
});
