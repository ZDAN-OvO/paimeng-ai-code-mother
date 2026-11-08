import { json, withErrors } from '@/mock/http';
import { promoteChat } from '@/mock/world';

export const dynamic = 'force-dynamic';

/** 草稿转项目：建 Project 并接管这条会话，不部署；部署仍走 projects/:id/deploys。 */
export const POST = withErrors(
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return json(promoteChat(id), 201);
  },
);
