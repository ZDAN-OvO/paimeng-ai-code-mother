import { json, withErrors } from '@/mock/http';
import { listSkills } from '@/mock/world';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async () => json({ skills: listSkills() }));
