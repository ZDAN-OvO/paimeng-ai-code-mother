import { skillImportSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { importSkill } from '@/mock/world';

export const dynamic = 'force-dynamic';

export const POST = withErrors(async (request: Request) => {
  const body = await parseBody(request, skillImportSchema);
  return json(importSkill(body), 201);
});
