import { json, withErrors } from '@/mock/http';
import { archiveChat } from '@/mock/world';

export const dynamic = 'force-dynamic';

/** 归档：草稿与项目会话共用。归档不是删除，之后可以 restore。 */
export const POST = withErrors(
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return json(archiveChat(id));
  },
);
