import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// mock 世界按 process.cwd() 落盘；测试切到临时目录，避免碰到本地 data/mock。
const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paimeng-world-'));

let world: typeof import('./world');
let ids: typeof import('./ids');

beforeAll(async () => {
  process.chdir(tempDir);
  world = await import('./world');
  ids = await import('./ids');
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function addReply(chatId: string) {
  const messageId = ids.uid('msg');
  world.updateChat(chatId, (chat) => ({
    ...chat,
    messages: [
      ...chat.messages,
      {
        id: messageId,
        role: 'assistant',
        parts: [],
        createdAt: '2026-11-11T10:00:00+08:00',
      },
    ],
  }));
  return messageId;
}

type PersistedWorld = {
  chats: {
    id: string;
    activeRound: unknown;
    streaming: boolean;
    messages: { status?: string }[];
  }[];
  projects: { id: string }[];
};

/** 模拟进程重启：丢掉模块内存，按落盘文件重新加载并走恢复逻辑。 */
function reloadWorld() {
  const holder = (globalThis as { __paimengMockWorld?: { state: unknown } }).__paimengMockWorld;
  holder!.state = null;
  return world.getState();
}

function persistedWorld(): PersistedWorld {
  return JSON.parse(
    fs.readFileSync(path.join(tempDir, 'data', 'mock', 'state.json'), 'utf8'),
  ) as PersistedWorld;
}

function startInterruptedRound(
  chatId: string,
  parts: unknown[],
  before: { files: Record<string, string>; site: null } = { files: {}, site: null },
) {
  const messageId = ids.uid('msg');
  world.updateChat(chatId, (chat) => ({
    ...chat,
    streaming: true,
    activeRound: { messageId, before },
    messages: [
      ...chat.messages,
      {
        id: messageId,
        role: 'assistant',
        // 测试里用的片段形状与真实回合一致：中断时仍在运行的审查要被标成 error。
        parts: parts as never,
        createdAt: '2026-11-11T10:00:00+08:00',
        streaming: true,
        status: 'running',
      },
    ],
  }));
  return messageId;
}

describe('mock 世界：项目共享文件与撤销', () => {
  it('一轮改动写进项目共享文件，撤销回退到改动前', () => {
    const { project, chat } = world.createProject({
      workspacePath: '~/Projects/tmp-check',
      prompt: '',
      templateId: 'auto',
    });
    expect(project.files).toEqual({});
    expect(project.workspaceState).toBe('sample');

    const messageId = addReply(chat.id);
    const { changeSet } = world.commitRound(chat.id, {
      messageId,
      status: 'succeeded',
      summary: '写入首页',
      before: { files: {}, site: null },
      after: { files: { 'app/a.tsx': 'v1' }, site: null },
    });
    expect(changeSet?.changedFiles).toEqual(['app/a.tsx']);
    expect(world.findProject(project.id).files).toEqual({ 'app/a.tsx': 'v1' });

    const undone = world.undoChangeSet(project.id, changeSet!.id);
    expect(undone.project.files).toEqual({});
    expect(undone.changeSet.status).toBe('undone');
    expect(() => world.undoChangeSet(project.id, changeSet!.id)).toThrow(/已经撤销/);
  });

  it('后续一轮改过同一文件后拒绝盲撤销', () => {
    const { project, chat } = world.createProject({
      workspacePath: '~/Projects/tmp-conflict',
      prompt: '',
      templateId: 'auto',
    });
    const messageId = addReply(chat.id);
    const { changeSet } = world.commitRound(chat.id, {
      messageId,
      status: 'succeeded',
      summary: '第一轮',
      before: { files: {}, site: null },
      after: { files: { 'app/a.tsx': 'v1' }, site: null },
    });
    world.updateProject(project.id, (current) => ({
      ...current,
      files: { 'app/a.tsx': 'v2-外部编辑器' },
    }));
    try {
      world.undoChangeSet(project.id, changeSet!.id);
      throw new Error('应当拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(world.ApiError);
      expect((error as InstanceType<typeof world.ApiError>).status).toBe(409);
      expect((error as InstanceType<typeof world.ApiError>).message).toContain('app/a.tsx');
    }
    expect(world.findProject(project.id).files).toEqual({ 'app/a.tsx': 'v2-外部编辑器' });
    expect(world.findChat(chat.id).projectId).toBe(project.id);
  });

  it('同一项目里另一条对话在生成或等审批时，开始执行、撤销与删除项目都被拒绝', () => {
    const { project, chat } = world.createProject({
      workspacePath: '~/Projects/tmp-busy',
      prompt: '',
      templateId: 'auto',
    });
    const other = world.createChat(project.id, { title: '并行对话' });

    world.updateChat(chat.id, (current) => ({ ...current, streaming: true }));
    expect(() => world.assertProjectCanRun(project.id)).toThrow(/正在生成/);
    expect(() => world.undoChangeSet(project.id, 'cs_missing')).toThrow(/正在生成/);
    expect(() => world.deleteProject(project.id)).toThrow(/正在生成/);

    world.updateChat(chat.id, (current) => ({
      ...current,
      streaming: false,
      pendingPlan: { messageId: 'msg_plan', revision: 1 },
    }));
    expect(() => world.assertProjectCanRun(project.id, other.id)).toThrow(/等方案审批/);
    // 轮到自己审批时不会被自己挡住。
    expect(() => world.assertProjectCanRun(project.id, chat.id)).not.toThrow();

    world.updateChat(chat.id, (current) => ({ ...current, pendingPlan: null }));
    expect(() => world.deleteProject(project.id)).not.toThrow();
  });

  it('进程中断后重启，用持久化的回合起点把已写入文件收成可撤销记录', () => {
    const { project, chat } = world.createProject({
      workspacePath: '~/Projects/tmp-restart',
      prompt: '',
      templateId: 'auto',
    });
    const messageId = startInterruptedRound(
      chat.id,
      [
        {
          id: 'review_running',
          type: 'review',
          kind: 'code',
          round: 1,
          revision: 'rev-1',
          scope: 'app/a.tsx',
          state: 'running',
        },
      ],
      { files: { 'app/old.tsx': 'old-before-round' }, site: null },
    );
    world.updateProject(project.id, (current) => ({
      ...current,
      files: {
        'app/old.tsx': 'new-written-before-crash',
        'app/a.tsx': 'v1-written-before-crash',
      },
    }));
    world.flush();

    // 落盘世界里确实带着回合起点，而不是只存在内存里。
    const onDisk = persistedWorld();
    const storedChat = onDisk.chats.find((item) => item.id === chat.id);
    expect(storedChat?.activeRound).toMatchObject({
      messageId,
      before: { files: { 'app/old.tsx': 'old-before-round' }, site: null },
    });
    expect(storedChat?.streaming).toBe(true);

    reloadWorld();

    const recovered = world.findChat(chat.id);
    const recoveredMessage = recovered.messages.find((item) => item.id === messageId);
    expect(recovered.streaming).toBe(false);
    expect(recovered.activeRound ?? null).toBeNull();
    expect(recoveredMessage?.status).toBe('stopped');
    expect(recoveredMessage?.completionReviewed).toBe(false);
    expect(recoveredMessage?.parts[0]).toMatchObject({ type: 'review', state: 'error' });

    const after = world.findProject(project.id);
    expect(after.changeSets).toHaveLength(1);
    expect(after.changeSets[0]).toMatchObject({
      chatId: chat.id,
      messageId,
      status: 'applied',
      changedFiles: ['app/a.tsx', 'app/old.tsx'],
      before: { 'app/old.tsx': 'old-before-round' },
      after: {
        'app/old.tsx': 'new-written-before-crash',
        'app/a.tsx': 'v1-written-before-crash',
      },
    });
    expect(recoveredMessage?.changeSetId).toBe(after.changeSets[0].id);

    // 撤销依据来自这条恢复出来的记录，不是测试自己构造的快照。
    const undone = world.undoChangeSet(project.id, after.changeSets[0].id);
    expect(undone.project.files).toEqual({ 'app/old.tsx': 'old-before-round' });
  });

  it('进程重启时这一轮没有写入文件，就不产生改动记录', () => {
    const { project, chat } = world.createProject({
      workspacePath: '~/Projects/tmp-restart-empty',
      prompt: '',
      templateId: 'auto',
    });
    const messageId = startInterruptedRound(chat.id, []);
    world.flush();
    reloadWorld();

    const recovered = world.findChat(chat.id);
    const recoveredMessage = recovered.messages.find((item) => item.id === messageId);
    expect(recoveredMessage?.status).toBe('stopped');
    expect(recoveredMessage?.changeSetId).toBeUndefined();
    expect(recovered.activeRound ?? null).toBeNull();
    expect(world.findProject(project.id).changeSets).toEqual([]);
  });

  it('导入技能按 YAML 读取多行描述，不从正文提取元信息', () => {
    const skill = world.importSkill({
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: import-yaml-check\ndescription: >-\n  第一行\n  第二行\ndisable-model-invocation: true\n---\n# 正文',
        },
      ],
      trusted: false,
    });
    expect(skill.description).toBe('第一行 第二行');
    expect(skill.disableModelInvocation).toBe(true);
    expect(skill.enabled).toBe(false);
    expect(() =>
      world.importSkill({
        files: [{ path: 'SKILL.md', content: '# 正文\nname: fake-skill\ndescription: 伪造说明' }],
        trusted: true,
      }),
    ).toThrow(/frontmatter/);
  });

  it('打开真实目录明确返回不可用', () => {
    expect(() => world.openProject()).toThrow(/尚不能打开本地目录/);
  });
});
