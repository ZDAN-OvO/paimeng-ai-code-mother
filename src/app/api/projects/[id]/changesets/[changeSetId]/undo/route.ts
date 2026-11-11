import { undoChangeFileRequestSchema, undoChangeFileResponseSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/server/http';
import { undoChangeFile } from '@/server/agent/changes';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string; changeSetId: string }> };

export const POST = withErrors(async (request: Request, { params }: Params) => {
  const { id, changeSetId } = await params;
  const body = await parseBody(request, undoChangeFileRequestSchema);
  const result = await undoChangeFile(id, changeSetId, body.path);
  if (!result) return json({ error: '改动文件不存在' }, 404);
  return json(
    undoChangeFileResponseSchema.parse({ changeSet: result.changeSet, file: result.file }),
  );
});
