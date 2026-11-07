import { describe, expect, it, vi, afterEach } from 'vitest';
import { canComplete, finishRound, skillKey, sourceRevision } from './flow';
import { seedProjects } from './mock-data';
import { runPrototypeRound } from './runner';
import type { Chat, DemoScenario, Part } from './types';

afterEach(() => vi.useRealTimers());

describe('prototype state contracts', () => {
  it('invalidates evidence when source changes', () => {
    const files = { 'page.tsx': 'before' };
    const evidence = sourceRevision(files);
    expect(canComplete(files, evidence)).toBe(true);
    expect(canComplete({ 'page.tsx': 'after' }, evidence)).toBe(false);
    expect(canComplete(files, null)).toBe(false);
  });
  it('separates same-slug builtin and user skills', () => {
    expect(skillKey({ source: 'builtin', slug: 'nextjs' })).not.toBe(
      skillKey({ source: 'user', slug: 'nextjs' }),
    );
  });
  it('snapshots unchanged and interrupted replies without rewriting history', () => {
    const initial = seedProjects().chats[0];
    const message = {
      id: 'reply',
      role: 'assistant' as const,
      parts: [] as Part[],
      createdAt: '2026-11-07',
    };
    const chat = {
      ...initial,
      messages: [...initial.messages, message],
      liveFiles: { 'partial.tsx': 'saved work' },
    };
    const stopped = finishRound(
      chat,
      'reply',
      'stopped',
      'stopped',
      initial.versions[0].site,
      'saved',
      '2026-11-07',
    );
    expect(stopped.versions.at(-1)?.files).toEqual({ 'partial.tsx': 'saved work' });
    expect(stopped.messages.at(-1)?.status).toBe('stopped');
    expect(stopped.versions.length).toBe(initial.versions.length + 1);
    expect(initial.versions.length).toBe(chat.versions.length);
    expect(
      finishRound(stopped, 'reply', 'stopped', '', initial.versions[0].site, 'duplicate', '')
        .versions.length,
    ).toBe(stopped.versions.length);
    const next = { ...stopped, messages: [...stopped.messages, { ...message, id: 'research' }] };
    const research = finishRound(
      next,
      'research',
      'succeeded',
      'no edits',
      initial.versions[0].site,
      'research-version',
      'now',
    );
    expect(research.versions.at(-1)?.changedFiles).toEqual([]);
    expect(research.versions.length).toBe(stopped.versions.length + 1);
  });
});

async function play(scenario: DemoScenario, prompt = '修改页面', userParts: Part[] = []) {
  vi.useFakeTimers();
  const state = seedProjects();
  let chat: Chat = {
    ...state.chats[0],
    streaming: true,
    liveFiles: { ...state.chats[0].versions.at(-1)?.files },
    messages: [
      ...state.chats[0].messages,
      {
        id: 'request',
        role: 'user',
        parts: [{ type: 'text', text: prompt }, ...userParts],
        createdAt: 'now',
      },
      { id: 'test', role: 'assistant', parts: [], createdAt: 'now' },
    ],
  };
  const patchMessage = (fn: (message: Chat['messages'][number]) => Chat['messages'][number]) => {
    chat = { ...chat, messages: chat.messages.map((m) => (m.id === 'test' ? fn(m) : m)) };
  };
  const promise = runPrototypeRound({
    chat,
    project: state.projects.find((p) => p.id === chat.projectId)!,
    prompt,
    options: { scenario },
    run: { aborted: false },
    skills: state.skills,
    getChat: () => chat,
    patchChat: (fn) => {
      chat = fn(chat);
    },
    patchMessage,
    push: (part) => {
      const index = chat.messages.at(-1)!.parts.length;
      patchMessage((message) => ({ ...message, parts: [...message.parts, part] }));
      return index;
    },
  });
  await vi.runAllTimersAsync();
  return { result: await promise, chat };
}

describe('browser-only mock runner', () => {
  it('keeps image reference and source selection in the mock flow', async () => {
    const { result, chat } = await play('normal', '调整「顶部导航」这个区块', [
      { type: 'image', url: 'data:image/png;base64,AA==', name: 'reference.png' },
      {
        type: 'selection',
        selection: { component: 'Header', src: 'components/header.tsx:5', label: '顶部导航' },
      },
    ]);
    const tools = chat.messages.at(-1)!.parts.filter((part) => part.type === 'tool');
    expect(tools.some((tool) => tool.name === 'read_attachment')).toBe(true);
    expect(tools.some((tool) => tool.input.path === 'components/header.tsx:5')).toBe(true);
    expect(chat.liveSite?.content.cta).not.toBe('顶部导航');
    expect(result.status).toBe('succeeded');
  });
  it('shows error, repair, recheck and accepted completion', async () => {
    const { result, chat } = await play('repair');
    const tools = chat.messages.at(-1)!.parts.filter((part) => part.type === 'tool');
    expect(result.status).toBe('succeeded');
    expect(tools.some((tool) => tool.name === 'verify_project' && tool.state === 'error')).toBe(
      true,
    );
    expect(tools.some((tool) => tool.name === 'verify_project' && tool.state === 'done')).toBe(
      true,
    );
    expect(tools.at(-1)?.name).toBe('complete_task');
  });
  it('rejects stale evidence before checking the new revision', async () => {
    const { result, chat } = await play('evidence');
    const tools = chat.messages
      .at(-1)!
      .parts.filter(
        (part): part is Extract<Part, { type: 'tool' }> =>
          part.type === 'tool' && part.name === 'complete_task',
      );
    expect(tools.map((tool) => tool.state)).toEqual(['error', 'done']);
    expect(result.status).toBe('succeeded');
  });
  it.each(['budget', 'failure', 'skill-blocked'] as const)(
    'does not claim success for %s',
    async (scenario) => {
      const { result, chat } = await play(scenario);
      expect(result.status).not.toBe('succeeded');
      const todo = chat.messages.at(-1)!.parts.find((part) => part.type === 'todos');
      expect(
        todo?.type === 'todos' && todo.items.every((item) => item.status === 'completed'),
      ).toBe(false);
    },
  );
  it('demonstrates all eight file tools without running generated code', async () => {
    const { result, chat } = await play('tools');
    const names = chat.messages
      .at(-1)!
      .parts.flatMap((part) => (part.type === 'tool' ? [part.name] : []));
    for (const name of [
      'read_file',
      'write_file',
      'edit_file',
      'glob_files',
      'grep_files',
      'move_file',
      'delete_file',
      'run_command',
    ])
      expect(names).toContain(name);
    expect(chat.liveFiles?.['prototype-note-final.txt']).toBeUndefined();
    expect(chat.liveFiles?.['prototype-note.txt']).toBe('reviewed');
    expect(result.status).toBe('succeeded');
  });
});
