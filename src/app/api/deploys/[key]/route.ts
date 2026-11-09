import { json, withErrors } from '@/mock/http';
import { publishedByKey } from '@/mock/world';

export const dynamic = 'force-dynamic';

export const GET = withErrors(
  async (_request: Request, { params }: { params: Promise<{ key: string }> }) => {
    const { key } = await params;
    return json(publishedByKey(key));
  },
);
