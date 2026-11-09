import { createProjectRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import {
  appendUserMessage,
  createProject,
  findChat,
  findProject,
  listProjects,
  summaryOf,
} from '@/mock/world';
import { startRound } from '@/mock/scenario';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async () => json({ projects: listProjects() }));

export const POST = withErrors(async (request: Request) => {
  const body = await parseBody(request, createProjectRequestSchema);
  const { project, chat } = createProject(body);
  appendUserMessage(chat.id, body.prompt);
  const accepted = startRound(chat.id, body.prompt);
  return json(
    {
      project: findProject(project.id),
      chat: summaryOf(findChat(chat.id)),
      eventsUrl: accepted.eventsUrl,
    },
    201,
  );
});
