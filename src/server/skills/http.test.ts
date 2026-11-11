import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { skillsResponseSchema } from '@/shared/api/schemas';

const locations = vi.hoisted(() => ({ home: '', project: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => locations.home,
}));
vi.mock('@/mock/world', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  listSkills: () => [],
  findProject: (id: string) => ({
    workspacePath: locations.project,
    workspaceState: id === 'linked' ? 'linked' : 'sample',
  }),
}));
import { GET as list } from '@/app/api/skills/route';
import { GET as read } from '@/app/api/skills/[slug]/files/route';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'paimeng-skills-http-'));
  locations.home = path.join(root, 'home');
  locations.project = path.join(root, 'project');
  for (const [directory, name] of [
    [locations.home, 'user-example'],
    [locations.project, 'project-example'],
  ]) {
    const skill = path.join(directory, '.paimeng/skills', name);
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, 'SKILL.md'),
      `---\nname: ${name}\ndescription: 示例说明\n---\n仅按需读取的正文`,
    );
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('技能 HTTP 入口', () => {
  it('列表契约返回双级索引；未连接的示例项目不读取磁盘项目路径', async () => {
    const response = await list(new Request('http://localhost/api/skills?projectId=linked'));
    const data = skillsResponseSchema.parse(await response.json());
    expect(data.catalog?.skills.map((skill) => skill.source)).toEqual(['user', 'project']);
    expect(JSON.stringify(data)).not.toContain('仅按需读取的正文');
    const sample = await list(new Request('http://localhost/api/skills?projectId=sample'));
    const sampleData = skillsResponseSchema.parse(await sample.json());
    expect(sampleData.catalog?.skills.map((skill) => skill.source)).toEqual(['user']);
    expect(sampleData.catalog?.directories.project).toBeNull();
  });

  it('按名称读取技能正文；目录穿越返回403，未知技能返回404', async () => {
    const params = { params: Promise.resolve({ slug: 'user-example' }) };
    const response = await read(
      new Request('http://localhost/api/skills/user-example/files'),
      params,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).content).toContain('仅按需读取的正文');
    const escaped = await read(
      new Request('http://localhost/api/skills/user-example/files?path=../outside'),
      params,
    );
    expect(escaped.status).toBe(403);
    const missing = await read(new Request('http://localhost/api/skills/missing/files'), {
      params: Promise.resolve({ slug: 'missing' }),
    });
    expect(missing.status).toBe(404);
  });
});
