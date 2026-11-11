import { templatesResponseSchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { TEMPLATES } from '@/server/templates/templates';
import { TEMPLATE_GALLERY } from '@/server/templates/gallery';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async () =>
  json(templatesResponseSchema.parse({ templates: TEMPLATES, gallery: TEMPLATE_GALLERY })),
);
