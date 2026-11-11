import { openProjectRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { openProject } from '@/mock/world';

export const dynamic = 'force-dynamic';

/** 打开已有本地目录：这一版没有本地文件访问，明确返回不可用，不假装已经连上。 */
export const POST = withErrors(async (request: Request) => {
  await parseBody(request, openProjectRequestSchema);
  openProject();
  return json({}, 201);
});
