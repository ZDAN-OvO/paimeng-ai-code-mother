import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = mkdtempSync(path.join(os.tmpdir(), 'paimeng-tools-'));
const root = path.join(base, 'project');
const outside = path.join(base, 'outside');
mkdirSync(path.join(root, 'src'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-SENTINEL');
symlinkSync(outside, path.join(root, 'outside-dir'));
writeFileSync(path.join(root, 'src', 'plain.txt'), 'one\ntwo\nthree\n');
writeFileSync(path.join(root, 'src', 'crlf.txt'), 'a\r\nb\r\n');
writeFileSync(
  path.join(root, 'src', 'bom.txt'),
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\nworld\n')]),
);
writeFileSync(path.join(root, 'src', 'binary.bin'), Buffer.from([0, 9, 8, 7]));
writeFileSync(path.join(root, 'AGENTS.md'), '项目规则');

process.env.DATABASE_PATH = path.join(base, 'paimeng.sqlite');
process.env.PAIMENG_DATA_DIR = path.join(base, 'data');

let tools: ReturnType<(typeof import('@/server/agent/tools'))['createTools']>;
let context: import('@/server/agent/tools').ToolContext;
let changes: typeof import('@/server/agent/changes');
let db: typeof import('@/server/db');

function tool(name: string) {
  return (
    tools as unknown as Record<
      string,
      {
        execute: (
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    >
  )[name];
}

beforeAll(async () => {
  const projects = await import('@/server/projects');
  db = await import('@/server/db');
  changes = await import('@/server/agent/changes');
  const opened = await projects.openProject(root);
  const chatId = opened.chats[0].id;
  const runId = 'run_tools_test';
  db.sqlite()
    .prepare(
      'insert into agent_run (id, chat_id, user_message_id, assistant_message_id, model_id, status, instance_id) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(runId, chatId, 'u', 'a', 'fake', 'running', 'test');
  context = { projectId: opened.project.id, chatId, runId, root };
  const { createTools } = await import('@/server/agent/tools');
  tools = createTools(context);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('文件工具', () => {
  it('读取带行号并拒绝覆盖未读文件；先读后写成功', async () => {
    writeFileSync(path.join(root, 'src', 'unread.txt'), 'before\n');
    const denied = await tool('write').execute(
      { path: 'src/unread.txt', content: 'x\n' },
      { toolCallId: 'w0' },
    );
    expect(denied).toMatchObject({ ok: false });
    expect(readFileSync(path.join(root, 'src', 'unread.txt'), 'utf8')).toBe('before\n');
    const read = await tool('read').execute({ path: 'src/plain.txt' }, { toolCallId: 'r1' });
    expect(read).toMatchObject({ ok: true, offset: 1, totalLines: 3 });
    expect((read as { content: string }).content).toContain('1\tone');
    const written = await tool('write').execute(
      { path: 'src/plain.txt', content: 'ONE\n' },
      { toolCallId: 'w1' },
    );
    expect(written).toMatchObject({ ok: true });
    expect(readFileSync(path.join(root, 'src', 'plain.txt'), 'utf8')).toBe('ONE\n');
  });

  it('read 与 write 使用等价路径时仍能识别已读状态', async () => {
    await tool('read').execute({ path: './src/plain.txt' }, { toolCallId: 'r-normalized' });
    const written = await tool('write').execute(
      { path: 'src/plain.txt', content: 'NORMALIZED\n' },
      { toolCallId: 'w-normalized' },
    );
    expect(written).toMatchObject({ ok: true });
    expect(readFileSync(path.join(root, 'src', 'plain.txt'), 'utf8')).toBe('NORMALIZED\n');
  });

  it('外部修改导致版本冲突，重新读取后可以继续', async () => {
    await tool('read').execute({ path: 'src/plain.txt' }, { toolCallId: 'r2' });
    writeFileSync(path.join(root, 'src', 'plain.txt'), 'external\n');
    const conflict = await tool('write').execute(
      { path: 'src/plain.txt', content: 'mine\n' },
      { toolCallId: 'w2' },
    );
    expect(conflict).toMatchObject({ ok: false, conflict: true });
    expect(readFileSync(path.join(root, 'src', 'plain.txt'), 'utf8')).toBe('external\n');
    await tool('read').execute({ path: 'src/plain.txt' }, { toolCallId: 'r3' });
    const ok = await tool('write').execute(
      { path: 'src/plain.txt', content: 'mine\n' },
      { toolCallId: 'w3' },
    );
    expect(ok).toMatchObject({ ok: true });
    expect(readFileSync(path.join(root, 'src', 'plain.txt'), 'utf8')).toBe('mine\n');
  });

  it('编辑保持 BOM 和 CRLF，多块替换不重叠，重复匹配拒绝', async () => {
    await tool('read').execute({ path: 'src/crlf.txt' }, { toolCallId: 'r4' });
    await tool('edit').execute(
      { path: 'src/crlf.txt', edits: [{ oldText: 'a\nb', newText: 'A\r\nB' }] },
      { toolCallId: 'e1' },
    );
    expect(readFileSync(path.join(root, 'src', 'crlf.txt'))).toEqual(Buffer.from('A\r\nB\r\n'));
    await tool('read').execute({ path: 'src/bom.txt' }, { toolCallId: 'r5' });
    const edited = await tool('edit').execute(
      { path: 'src/bom.txt', edits: [{ oldText: 'hello', newText: 'HELLO' }] },
      { toolCallId: 'e2' },
    );
    expect(edited).toMatchObject({ ok: true });
    expect(readFileSync(path.join(root, 'src', 'bom.txt')).subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
    await tool('read').execute({ path: 'src/plain.txt' }, { toolCallId: 'r6' });
    writeFileSync(path.join(root, 'src', 'dup.txt'), 'same\nsame\n');
    await tool('read').execute({ path: 'src/dup.txt' }, { toolCallId: 'r7' });
    const dup = await tool('edit').execute(
      { path: 'src/dup.txt', edits: [{ oldText: 'same', newText: 'x' }] },
      { toolCallId: 'e3' },
    );
    expect(dup).toMatchObject({ ok: false });
  });

  it('拒绝路径穿越、越界软链和越界新文件父目录，项目外文件不变', async () => {
    expect(
      await tool('read').execute({ path: '../outside/secret.txt' }, { toolCallId: 'a1' }),
    ).toMatchObject({ ok: false });
    expect(
      await tool('read').execute({ path: 'outside-dir/secret.txt' }, { toolCallId: 'a2' }),
    ).toMatchObject({ ok: false });
    expect(
      await tool('write').execute(
        { path: 'outside-dir/new.txt', content: 'x' },
        { toolCallId: 'a3' },
      ),
    ).toMatchObject({ ok: false });
    expect(
      await tool('write').execute({ path: '../escaped.txt', content: 'x' }, { toolCallId: 'a4' }),
    ).toMatchObject({ ok: false });
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('SECRET-SENTINEL');
  });

  it('grep/find/ls 有上限并忽略依赖目录', async () => {
    const grep = await tool('grep').execute({ pattern: 'mine' }, { toolCallId: 'g1' });
    expect(grep).toMatchObject({ ok: true });
    expect((grep as { matches: string[] }).matches.length).toBeGreaterThan(0);
    const find = await tool('find').execute({ pattern: '**/*.txt' }, { toolCallId: 'f1' });
    expect((find as { matches: string[] }).matches).toContain('src/plain.txt');
    const ls = await tool('ls').execute({ path: 'src' }, { toolCallId: 'l1' });
    expect((ls as { entries: string[] }).entries.some((entry) => entry.endsWith('plain.txt'))).toBe(
      true,
    );
  });
});

describe('Bash 工具', () => {
  it('在项目目录执行，剔除模型和宿主密钥环境变量', async () => {
    process.env.AI_API_KEY = 'should-not-leak';
    process.env.CUSTOM_SECRET = 'also-hidden';
    const result = await tool('bash').execute(
      {
        command: `pwd; node -e 'console.log(process.env.AI_API_KEY||"none"); console.log(process.env.CUSTOM_SECRET||"none")'`,
      },
      { toolCallId: 'b1', abortSignal: new AbortController().signal },
    );
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect((result as { output: string }).output).toContain(root);
    expect((result as { output: string }).output).not.toContain('should-not-leak');
    expect((result as { output: string }).output).not.toContain('also-hidden');
    delete process.env.AI_API_KEY;
    delete process.env.CUSTOM_SECRET;
  });

  it('非零退出码和超时都返回可见结果，超时杀掉进程组', async () => {
    const failed = await tool('bash').execute(
      { command: 'printf fail; exit 7' },
      { toolCallId: 'b2', abortSignal: new AbortController().signal },
    );
    expect(failed).toMatchObject({ ok: false, exitCode: 7 });
    const marker = path.join(root, 'timeout-marker');
    const timed = await tool('bash').execute(
      { command: `(sleep 4; touch ${marker}) & wait`, timeout: 1 },
      { toolCallId: 'b3', abortSignal: new AbortController().signal },
    );
    expect(timed).toMatchObject({ timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(existsSync(marker)).toBe(false);
  });

  it('全量输出落盘，模型只收到尾部', async () => {
    const result = await tool('bash').execute(
      { command: 'for i in $(seq 1 10000); do echo "line-$i"; done' },
      { toolCallId: 'b4', abortSignal: new AbortController().signal },
    );
    const record = result as { outputRecord: string; output: string; truncated: boolean };
    expect(record.truncated).toBe(true);
    expect(record.output).toContain('line-10000');
    expect(record.output).not.toContain('line-1\n');
    const full = readFileSync(record.outputRecord, 'utf8').trim().split('\n');
    expect(full).toHaveLength(10000);
    expect(statSync(record.outputRecord).size).toBeGreaterThan(50 * 1024);
  });

  it('Bash 改动进入 Diff，忽略目录不进入 Diff', async () => {
    mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const result = await tool('bash').execute(
      {
        command:
          'mkdir -p node_modules/x; echo changed > src/bash-made.txt; echo ignored > node_modules/x/a.txt',
      },
      { toolCallId: 'b5', abortSignal: new AbortController().signal },
    );
    const changed = (result as { changedPaths: string[] }).changedPaths;
    expect(changed).toContain('src/bash-made.txt');
    expect(changed.some((item) => item.startsWith('node_modules/'))).toBe(false);
    const sets = changes.changesetsForProject(context.projectId);
    const paths = sets.changeSets.flatMap((set) => set.files.map((file) => file.path));
    expect(paths).toContain('src/bash-made.txt');
    expect(paths.some((item) => item.startsWith('node_modules/'))).toBe(false);
  });
});

describe('逐文件撤销', () => {
  it('新增文件撤销删除，当前内容不同也恢复 before，其他文件不变', async () => {
    await tool('write').execute(
      { path: 'src/undo-added.txt', content: 'new\n' },
      { toolCallId: 'u1' },
    );
    writeFileSync(path.join(root, 'src', 'undo-modified.txt'), 'original\n');
    await tool('read').execute({ path: 'src/undo-modified.txt' }, { toolCallId: 'u3' });
    await tool('write').execute(
      { path: 'src/undo-modified.txt', content: 'changed\n' },
      { toolCallId: 'u4' },
    );
    writeFileSync(path.join(root, 'src', 'undo-empty.txt'), '');
    await tool('read').execute({ path: 'src/undo-empty.txt' }, { toolCallId: 'u5' });
    await tool('write').execute(
      { path: 'src/undo-empty.txt', content: 'filled\n' },
      { toolCallId: 'u6' },
    );
    const sets = changes.changesetsForProject(context.projectId).changeSets;
    const set = sets.find((item) => item.files.some((file) => file.path === 'src/undo-added.txt'))!;
    expect(set).toBeTruthy();
    writeFileSync(path.join(root, 'src', 'undo-modified.txt'), 'external-later\n');
    const undone = await changes.undoChangeFile(context.projectId, set.id, 'src/undo-added.txt');
    expect(undone?.file.undoState).toBe('undone');
    expect(existsSync(path.join(root, 'src', 'undo-added.txt'))).toBe(false);
    expect(readFileSync(path.join(root, 'src', 'undo-modified.txt'), 'utf8')).toBe(
      'external-later\n',
    );
    const undone2 = await changes.undoChangeFile(
      context.projectId,
      set.id,
      'src/undo-modified.txt',
    );
    expect(undone2?.file.undoState).toBe('undone');
    expect(readFileSync(path.join(root, 'src', 'undo-modified.txt'), 'utf8')).toBe('original\n');
    expect(
      (await changes.undoChangeFile(context.projectId, set.id, 'src/undo-modified.txt'))?.file
        .undoState,
    ).toBe('undone');
    expect(
      (await changes.undoChangeFile(context.projectId, set.id, 'src/undo-empty.txt'))?.file
        .undoState,
    ).toBe('undone');
    expect(existsSync(path.join(root, 'src', 'undo-empty.txt'))).toBe(true);
    expect(statSync(path.join(root, 'src', 'undo-empty.txt')).size).toBe(0);
  });
});

describe('撤销优先', () => {
  it('撤销会终止正在写同一项目的 Bash，恢复后才返回，并通知其他 Agent', async () => {
    const target = 'src/undo-while-bash.txt';
    writeFileSync(path.join(root, target), 'base\n');
    const recorded = changes.recordChange({
      projectId: context.projectId,
      runId: context.runId,
      path: target,
      source: 'tool',
      attribution: 'exact',
      before: { exists: true, bytes: Buffer.from('base\n'), mode: '100644' },
      after: { exists: true, bytes: Buffer.from('planned\n'), mode: '100644' },
      operation: 'write',
    });
    expect(recorded).not.toBeNull();
    const { runBash } = await import('@/server/agent/bash');
    const started = Date.now();
    const running = runBash({
      projectId: context.projectId,
      runId: context.runId,
      toolCallId: 'undo-bash',
      command: `sleep 5; echo changed > ${target}`,
      cwd: root,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const undone = await changes.undoChangeFile(context.projectId, recorded!.changeSetId, target);
    expect(undone?.file.undoState).toBe('undone');
    const result = await running;
    expect(result.stoppedBy).toBe('undo');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(readFileSync(path.join(root, target), 'utf8')).toBe('base\n');
    const { takeUndoNotices } = await import('@/server/agent/notices');
    expect(takeUndoNotices(context.projectId, context.runId).join('\n')).toContain(target);
  }, 20_000);
});
