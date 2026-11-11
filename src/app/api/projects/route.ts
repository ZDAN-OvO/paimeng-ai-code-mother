import { createProjectRequestSchema } from '@/shared/api/schemas';
import { json, parseBody, withErrors } from '@/mock/http';
import { createProject, findProject, listProjects, summaryOf } from '@/mock/world';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async () => json({ projects: listProjects() }));

/** 新建项目：记下目录路径并开一条空对话；路径对应的磁盘目录在这一版不会被读写。 */
export const POST = withErrors(async (request: Request) => {
  const body = await parseBody(request, createProjectRequestSchema);
  const { project, chat } = createProject(body);
  return json({ project: findProject(project.id), chat: summaryOf(chat) }, 201);
});
