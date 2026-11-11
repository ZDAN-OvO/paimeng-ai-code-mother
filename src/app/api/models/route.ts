import { modelsResponseSchema } from '@/shared/api/schemas';
import { json, withErrors } from '@/server/http';
import { configuredModels } from '@/server/projects';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async () => {
  return json(modelsResponseSchema.parse({ models: configuredModels() }));
});
