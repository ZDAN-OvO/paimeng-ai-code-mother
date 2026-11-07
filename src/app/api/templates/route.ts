import { json, withErrors } from '@/mock/http';
import { TEMPLATES } from '@/mock/seed/templates';
import { TEMPLATE_GALLERY } from '@/mock/seed/gallery';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async () =>
  json({ templates: TEMPLATES, gallery: TEMPLATE_GALLERY }),
);
