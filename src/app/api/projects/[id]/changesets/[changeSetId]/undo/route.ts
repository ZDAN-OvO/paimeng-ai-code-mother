import { json, withErrors } from '@/mock/http';
import { undoChangeSet } from '@/mock/world';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; changeSetId: string }> };

/** 撤销一轮改动：写回改动前的文件；文件后来又被改过时返回 409，不盲覆盖。 */
export const POST = withErrors(async (_request: Request, { params }: Params) => {
  const { id, changeSetId } = await params;
  return json(undoChangeSet(id, changeSetId));
});
