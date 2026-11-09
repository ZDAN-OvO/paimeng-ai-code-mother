import { skillPatchSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { deleteSkill, patchSkill } from '@/mock/world';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

export const PATCH = withErrors(async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const body = await parseBody(request, skillPatchSchema);
  return json(patchSkill(decodeURIComponent(slug), body));
});

export const DELETE = withErrors(async (_request: Request, { params }: Params) => {
  const { slug } = await params;
  deleteSkill(decodeURIComponent(slug));
  return new Response(null, { status: 204 });
});
