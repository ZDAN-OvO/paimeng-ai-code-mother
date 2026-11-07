import { buildSite, buildSiteFiles, bytesOf, resolveTemplate, uid } from './mock-data';
import { changedPaths } from './diff';
import { canComplete, skillKey, sourceRevision } from './flow';
import type {
  Chat,
  FileMap,
  Message,
  Part,
  Project,
  RunOptions,
  RunStatus,
  Skill,
  TodoItem,
} from './types';

type Context = {
  chat: Chat;
  project: Project;
  prompt: string;
  options: RunOptions;
  run: { aborted: boolean };
  skills: Skill[];
  getChat: () => Chat | undefined;
  patchChat: (update: (chat: Chat) => Chat) => void;
  patchMessage: (update: (message: Message) => Message) => void;
  push: (part: Part) => number;
};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Browser-only scripted interactions. No shell, network, model or user code is executed. */
export async function runPrototypeRound(
  ctx: Context,
): Promise<{ status: RunStatus; summary: string }> {
  const { chat, project, prompt, options, run, push } = ctx;
  const previous = chat.versions.at(-1);
  const scenario = options.scenario ?? 'normal';
  const iteration =
    (previous && Object.keys(previous.files).length ? previous.site.iteration : 0) + 1;
  const site = buildSite(
    resolveTemplate(project.templateId, project.prompt),
    previous?.site.content.brand ?? project.name,
    iteration,
  );
  const lastUser = [...chat.messages].reverse().find((message) => message.role === 'user');
  const selection = lastUser?.parts.find((part) => part.type === 'selection');
  const quote = prompt.match(/[「“"]([^」”"]{2,18})[」”"]/)?.[1];
  if (quote && !selection) site.content.cta = quote;
  const target = buildSiteFiles(site);
  const currentFiles = () => ctx.getChat()?.liveFiles ?? previous?.files ?? {};
  const setFiles = (files: FileMap) =>
    ctx.patchChat((item) => ({ ...item, liveFiles: { ...files } }));
  const research = /搜索|找两个|抓一下|联网|调研|参考的同类/.test(prompt);
  const todos: TodoItem[] = [
    { id: 'context', label: '读取项目与相关技能', status: 'in_progress' },
    {
      id: 'implement',
      label: research ? '查看调研示例与网页正文' : '修改本地示例文件',
      status: 'pending',
    },
    {
      id: 'verify',
      label: research ? '核对引用与未改代码的回复' : '检查当前修订并核对完成条件',
      status: 'pending',
    },
  ];
  const todoIndex = push({ type: 'todos', items: todos });
  function progress(index: number) {
    ctx.patchMessage((message) => ({
      ...message,
      parts: message.parts.map((part, n) =>
        n === todoIndex && part.type === 'todos'
          ? {
              ...part,
              items: part.items.map((item, i) => ({
                ...item,
                status: i < index ? 'completed' : i === index ? 'in_progress' : 'pending',
              })),
            }
          : part,
      ),
    }));
  }
  async function tool(
    name: string,
    input: Record<string, unknown>,
    output: string,
    error = false,
    mutate?: () => void,
  ) {
    if (run.aborted) return false;
    const id = uid('tool');
    push({ type: 'tool', id, name, state: 'running', input });
    await wait(190);
    if (run.aborted) return false;
    mutate?.();
    ctx.patchMessage((message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.type === 'tool' && part.id === id
          ? { ...part, state: error ? 'error' : 'done', output: `本地模拟：${output}` }
          : part,
      ),
    }));
    return true;
  }
  const stopped = () => ({
    status: 'stopped' as const,
    summary: '已停止。已完成的本地改动已保留为版本；未完成的任务保持原进度。',
  });
  push({
    type: 'reasoning',
    text: '这是前端演示：读取上下文，按需加载技能，再修改示例文件。检查与权限结果均为模拟。',
  });
  const defaults = ['frontend-design', 'nextjs', 'shadcn', 'debug-and-verify'];
  const candidates = ctx.skills.filter(
    (skill) =>
      skill.enabled &&
      ((skill.source === 'builtin' && defaults.includes(skill.slug)) ||
        (skill.source === 'user' && (prompt.includes(skill.slug) || prompt.includes(skill.name)))),
  );
  for (const skill of candidates) {
    if (
      !(await tool(
        'load_skill',
        { skill: skillKey(skill) },
        skill.contents?.['SKILL.md'] ??
          `${skill.name}\n${skill.description}\n按需读取参考文件；不提升权限。`,
      ))
    )
      return stopped();
    const reference = skill.files.find((file) => file.startsWith('references/'));
    if (
      reference &&
      !(await tool(
        'read_skill_file',
        { skill: skillKey(skill), path: reference },
        skill.contents?.[reference] ?? '保留项目视觉规范，并在结束前重新检查。',
      ))
    )
      return stopped();
  }
  const userSkill =
    candidates.find((skill) => skill.source === 'user') ??
    ctx.skills.find((skill) => skill.source === 'user' && skill.enabled);
  if (
    scenario === 'skill-blocked' ||
    (userSkill && !userSkill.trusted && /脚本|scripts/.test(prompt))
  ) {
    await tool(
      'run_command',
      {
        skill: userSkill ? skillKey(userSkill) : 'user:untrusted-demo',
        command: 'scripts/check.sh',
      },
      '执行被拒绝：技能尚未信任。没有执行脚本，也没有扩大网络权限。',
      true,
    );
    return run.aborted
      ? stopped()
      : {
          status: 'failed',
          summary:
            '未信任的技能脚本已被模拟执行器拒绝。可到技能页核对文件并确认信任后，再发送请求。',
        };
  }
  if (research) {
    progress(1);
    await tool(
      'search_web',
      { query: prompt },
      '1. 同类示例 A — https://slow-coffee.example\n2. 同类示例 B — https://beanmap.example',
    );
    await tool(
      'fetch_url',
      { url: 'https://slow-coffee.example' },
      '首屏一句话、明确行动按钮、下方为产品信息。此结果为固定示例，不实际联网。',
    );
    if (run.aborted) return stopped();
    progress(2);
    await tool(
      'complete_task',
      { scope: 'research', revision: sourceRevision(currentFiles()) },
      '核对模拟引用与未改文件的结果；不把调研当作代码验证。',
    );
    if (run.aborted) return stopped();
    progress(3);
    return {
      status: 'succeeded',
      summary:
        '调研示例已完成，本轮未改代码，仍追加一个源码快照版本。网页内容与引用是固定 mock，不表示实际联网。',
    };
  }
  const firstPath = Object.keys(currentFiles())[0] ?? 'app/page.tsx';
  await tool(
    'glob_files',
    { pattern: '**/*.{ts,tsx}' },
    Object.keys(currentFiles()).join('\n') || '当前工作区为空',
  );
  await tool(
    'read_file',
    { path: firstPath },
    currentFiles()[firstPath] ?? '尚未创建，将在后续写入',
  );
  await tool(
    'grep_files',
    { query: 'export', glob: '**/*.tsx' },
    '返回示例组件位置；结果仅用于前端流程展示。',
  );
  const attachments = lastUser?.parts.filter((part) => part.type === 'image') ?? [];
  if (
    attachments.length &&
    !(await tool(
      'read_attachment',
      { name: attachments[0].name },
      '读取本轮图片作为视觉参考；版式分析为固定 mock，不调用模型。',
    ))
  )
    return stopped();
  if (selection?.type === 'selection')
    await tool(
      'read_file',
      { path: selection.selection.src, component: selection.selection.component },
      `本轮针对 ${selection.selection.label}，定位信息来自用户选中的元素。`,
    );
  progress(1);
  if (scenario === 'tools') {
    await tool('write_file', { path: 'prototype-note.txt' }, '创建示例文件', false, () =>
      setFiles({ ...currentFiles(), 'prototype-note.txt': 'draft' }),
    );
    await tool(
      'edit_file',
      { path: 'prototype-note.txt', old: 'draft', replacement: 'reviewed' },
      '精确替换 draft → reviewed',
      false,
      () => setFiles({ ...currentFiles(), 'prototype-note.txt': 'reviewed' }),
    );
    await tool(
      'move_file',
      { operation: 'copy', from: 'prototype-note.txt', to: 'prototype-note-copy.txt' },
      '复制到新路径，原文件保留',
      false,
      () =>
        setFiles({
          ...currentFiles(),
          'prototype-note-copy.txt': currentFiles()['prototype-note.txt'] ?? '',
        }),
    );
    await tool(
      'move_file',
      { operation: 'move', from: 'prototype-note-copy.txt', to: 'prototype-note-final.txt' },
      '移动完成',
      false,
      () => {
        const files: FileMap = {
          ...currentFiles(),
          'prototype-note-final.txt': currentFiles()['prototype-note-copy.txt'] ?? '',
        };
        delete files['prototype-note-copy.txt'];
        setFiles(files);
      },
    );
    await tool(
      'delete_file',
      { path: 'prototype-note-final.txt', recursive: false },
      '仅删除指定示例文件',
      false,
      () => {
        const files = { ...currentFiles() };
        delete files['prototype-note-final.txt'];
        setFiles(files);
      },
    );
  }
  for (const path of changedPaths(previous?.files ?? {}, target)) {
    if (run.aborted) return stopped();
    const exists = currentFiles()[path] !== undefined;
    await tool(
      exists ? 'edit_file' : 'write_file',
      { path, bytes: bytesOf(target[path] ?? '') },
      exists ? '示例文件已修改' : '示例文件已创建',
      false,
      () => {
        const files = { ...currentFiles() };
        if (target[path] === undefined) delete files[path];
        else files[path] = target[path];
        setFiles(files);
      },
    );
  }
  if (run.aborted) return stopped();
  ctx.patchChat((item) => ({ ...item, liveSite: site }));
  if (scenario === 'budget')
    return {
      status: 'budget_exhausted',
      summary:
        '已达到本轮执行上限，任务尚未完成。已保留完成的改动，但尚未通过验证。此状态仅为前端模拟，不涉及费用或额度。',
    };
  progress(2);
  await tool('run_command', { command: 'npm run build' }, '模拟构建阶段；没有运行终端命令。');
  if (run.aborted) return stopped();
  let evidence: string | null = null;
  if (scenario === 'failure') {
    await tool(
      'verify_project',
      { revision: sourceRevision(currentFiles()) },
      '模拟构建失败，尚未产生通过证据。',
      true,
    );
    return run.aborted
      ? stopped()
      : {
          status: 'failed',
          summary: '检查失败：模拟缺失依赖。当前源码已保留；请修复后重试，没有标记为完成。',
        };
  }
  if (scenario === 'repair') {
    const path = Object.keys(currentFiles()).find((name) => name.endsWith('.tsx')) ?? firstPath;
    const original = currentFiles()[path] ?? '';
    setFiles({ ...currentFiles(), [path]: original + '\n// mock: missing import' });
    await tool(
      'verify_project',
      { revision: sourceRevision(currentFiles()) },
      '模拟检查失败：组件缺失导入，返回主 Agent 修复。',
      true,
    );
    await tool('edit_file', { path }, '已修复示例导入，旧检查结果失效', false, () =>
      setFiles({ ...currentFiles(), [path]: original }),
    );
  }
  if (run.aborted) return stopped();
  const verify = async () => {
    const revision = sourceRevision(currentFiles());
    const passed = await tool(
      'verify_project',
      { revision, checks: ['type-check', 'build', 'preview-ready'] },
      `模拟检查通过。证据绑定 ${revision}；不代表真实编译或浏览器验证。`,
    );
    if (passed) evidence = revision;
  };
  await verify();
  if (scenario === 'evidence' && !run.aborted) {
    const path = 'prototype-evidence.txt';
    await tool('write_file', { path }, '检查后再次修改，原证据已过期', false, () =>
      setFiles({ ...currentFiles(), [path]: 'Changed after verification' }),
    );
    await tool(
      'complete_task',
      { revision: sourceRevision(currentFiles()), evidence },
      '拒绝完成：当前修订与证据不一致，需要重新检查。',
      true,
    );
    await verify();
  }
  if (run.aborted) return stopped();
  const accepted = canComplete(currentFiles(), evidence);
  await tool(
    'complete_task',
    { revision: sourceRevision(currentFiles()), evidence },
    accepted ? '接受本轮模拟结果，保留版本；不触发发布。' : '证据缺失，拒绝完成。',
    !accepted,
  );
  if (run.aborted) return stopped();
  if (!accepted)
    return { status: 'failed', summary: '完成判定未通过：缺少当前修订的证据，工作已保留。' };
  progress(3);
  return {
    status: 'succeeded',
    summary: `本轮前端演示已完成，保留 ${Object.keys(currentFiles()).length} 个文件的源码快照。工具、检查与预览均为本地模拟，可继续对话或查看版本 diff。`,
  };
}
