import { planDecisionSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { decidePlan } from '@/mock/scenario';

export const dynamic = 'force-dynamic';

export const POST = withErrors(
  async (request: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) => {
    const { id, messageId } = await params;
    const body = await parseBody(request, planDecisionSchema);
    return json(decidePlan(id, messageId, body.decision, body.feedback), 202);
  },
);
