import { json, withErrors } from '@/mock/http';
import { MODELS } from '@/mock/seed/models';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async () => json({ models: MODELS }));
