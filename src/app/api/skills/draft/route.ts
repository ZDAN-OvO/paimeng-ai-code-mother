import { skillDraftRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { WEEKLY_SKILL_CONTENT } from '@/mock/seed/skill-draft';

export const dynamic = 'force-dynamic';

export const POST = withErrors(async (request: Request) => {
  await parseBody(request, skillDraftRequestSchema);
  return json({
    slug: 'weekly-report-format',
    files: [{ path: 'SKILL.md', content: WEEKLY_SKILL_CONTENT }],
    manifest: '固定结构的周报技能：先写结论，再写风险。',
  });
});
