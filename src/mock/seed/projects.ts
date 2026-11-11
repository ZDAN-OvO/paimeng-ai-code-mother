import type {
  ChangeSet,
  ChatRecord,
  FileMap,
  Message,
  Part,
  Project,
  SiteState,
  Skill,
} from '@/shared/api/schemas';
import { buildSite } from '@/mock/site';
import { buildSiteFiles } from '@/mock/seed/files';
import { SKILLS_SEED } from '@/mock/seed/skills';
import { bytesOf } from '@/lib/format';
import { changedPaths } from '@/lib/diff';
import { uid } from '@/mock/ids';
import { addSeconds } from '@/lib/time';

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type DraftPart = DistributiveOmit<Part, 'id'> & { id?: string };

function withPartIds(parts: DraftPart[]): Part[] {
  return parts.map((part) => ({ ...part, id: part.id ?? uid('part') })) as Part[];
}

function toolsForRound(site: SiteState, files: FileMap, round: number): Part[] {
  const writePaths = Object.keys(files).filter((path) => path !== 'package.json');
  const parts: DraftPart[] = [
    {
      type: 'reasoning',
      text:
        round === 1
          ? '这是一个静态官网，先定页面结构：主视觉、能力介绍、页脚。文件拆成 components，方便下一轮只改局部。'
          : '先看当前目录，只改受影响的文件，避免把已经能跑的东西重写一遍。',
    },
  ];
  if (round > 1) {
    parts.push({
      type: 'tool',
      id: uid('tool'),
      name: 'list_files',
      state: 'done',
      input: { path: '.' },
      output: writePaths.join('\n'),
    });
  }
  for (const path of writePaths) {
    parts.push({
      type: 'tool',
      id: uid('tool'),
      name: 'write_file',
      state: 'done',
      input: { path, bytes: bytesOf(files[path] ?? '') },
      output: '已写入',
    });
  }
  parts.push({
    type: 'tool',
    id: uid('tool'),
    name: 'run_command',
    state: 'done',
    input: { command: 'npm run build' },
    output: `▲ Next.js 16.4.5
   Creating an optimized production build ...
 ✓ Compiled successfully
 ✓ Generating static pages (3/3)
 ✓ Build completed in 8.4s`,
  });
  parts.push({ type: 'text', text: '' });
  return withPartIds(parts);
}

const SUMMARIES = [
  '首页已经生成：顶部是主视觉，中间是三个能力点，页脚放了信息位。文件按组件拆开，下一轮可以只改其中一块。',
  '加了顶部导航与内容区块，导航项来自内容文件，改文案不用动组件。',
  '主视觉换成深色版，标题和副标题重新写了一遍，并补了一段客户评价。',
];

type Round = { user: string; at: string };

function seedProject(options: {
  projectId: string;
  chatId: string;
  name: string;
  description: string;
  workspacePath: string;
  templateId: string;
  brand: string;
  modelId: string;
  baseAt: string;
  updatedAt: string;
  env?: Project['env'];
  rounds: Round[];
}): { project: Project; chat: ChatRecord } {
  const messages: Message[] = [];
  const changeSets: ChangeSet[] = [];
  let previous: { files: FileMap; site: SiteState | null } = { files: {}, site: null };
  let current = previous;

  options.rounds.forEach((round, index) => {
    const iteration = index + 1;
    const site = buildSite(options.templateId, options.brand, iteration);
    const files = buildSiteFiles(site);
    const changeSetId = `${options.chatId}_cs${iteration}`;
    const userMessage: Message = {
      id: `${options.chatId}_u${iteration}`,
      role: 'user',
      parts: [{ id: `${options.chatId}_u${iteration}_p`, type: 'text', text: round.user }],
      createdAt: round.at,
    };
    const parts = toolsForRound(site, files, iteration);
    const textPart = parts[parts.length - 1];
    if (textPart.type === 'text') {
      textPart.text = SUMMARIES[Math.min(index, SUMMARIES.length - 1)];
    }
    const summary = SUMMARIES[Math.min(index, SUMMARIES.length - 1)];
    const assistantMessage: Message = {
      id: `${options.chatId}_a${iteration}`,
      role: 'assistant',
      parts,
      createdAt: round.at,
      finishedAt: addSeconds(round.at, 46 + index * 31),
      changeSetId,
      status: 'succeeded',
      completionReviewed: true,
    };

    const previousFiles = previous.files;
    const changedFiles = changedPaths(previousFiles, files);
    changeSets.push({
      id: changeSetId,
      seq: iteration,
      chatId: options.chatId,
      messageId: assistantMessage.id,
      summary,
      createdAt: round.at,
      status: 'applied',
      changedFiles,
      before: previousFiles,
      after: files,
      siteBefore: previous.site,
      siteAfter: site,
    });
    messages.push(userMessage, assistantMessage);
    previous = { files, site };
    current = previous;
  });

  return {
    chat: {
      id: options.chatId,
      projectId: options.projectId,
      title: options.name,
      modelId: options.modelId,
      createdAt: options.baseAt,
      updatedAt: options.updatedAt,
      streaming: false,
      archivedAt: null,
      pendingPlan: null,
      messages,
    },
    project: {
      id: options.projectId,
      name: options.name,
      description: options.description,
      templateId: options.templateId,
      createdAt: options.baseAt,
      updatedAt: options.updatedAt,
      env: options.env ?? [],
      workspacePath: options.workspacePath,
      workspaceState: 'sample',
      files: current.files,
      site: current.site,
      changeSets,
      runtime: { state: 'stopped', port: null, url: null, logs: [], source: 'sample' },
    },
  };
}

export function seedProjects(): { projects: Project[]; chats: ChatRecord[]; skills: Skill[] } {
  const cafe = seedProject({
    projectId: 'proj_cafe',
    chatId: 'chat_cafe',
    name: '山间咖啡',
    description: '做一个山间咖啡馆的官网：要有品牌介绍、招牌豆子、菜单和门店信息，风格温暖一点。',
    workspacePath: '~/Projects/cafe-site',
    templateId: 'coffee',
    brand: '山间咖啡',
    modelId: 'anthropic/claude-sonnet-4.5',
    baseAt: '2026-11-06T08:58:00+08:00',
    updatedAt: '2026-11-06T09:14:00+08:00',
    env: [
      { key: 'NEXT_PUBLIC_SHOP_ID', value: 'shop_2041', secret: false },
      { key: 'RESEND_API_KEY', value: 're_9f2c_••••••', secret: true },
    ],
    rounds: [
      {
        user: '做一个山间咖啡馆的官网：要有品牌介绍、招牌豆子、菜单和门店信息，风格温暖一点。',
        at: '2026-11-06T09:01:00+08:00',
      },
      { user: '加一个菜单区块，导航里也放上菜单和门店。', at: '2026-11-06T09:08:00+08:00' },
      {
        user: '主视觉太普通了，换成深色一点的版本，再加一段客户评价。',
        at: '2026-11-06T09:13:00+08:00',
      },
    ],
  });

  const portfolio = seedProject({
    projectId: 'proj_portfolio',
    chatId: 'chat_portfolio',
    name: '林迟 · 作品集',
    description: '做一个设计师的个人作品集：自我介绍、精选项目、联系方式，排版克制一点。',
    workspacePath: '~/Projects/linchi-portfolio',
    templateId: 'portfolio',
    brand: '林迟',
    modelId: 'openai/gpt-5.2',
    baseAt: '2026-11-05T15:38:00+08:00',
    updatedAt: '2026-11-06T08:33:00+08:00',
    rounds: [
      {
        user: '做一个设计师的个人作品集：自我介绍、精选项目、联系方式，排版克制一点。',
        at: '2026-11-05T15:41:00+08:00',
      },
      { user: '项目列表加上年份，页脚换成我的邮箱。', at: '2026-11-06T08:32:00+08:00' },
    ],
  });

  const weekly = seedProject({
    projectId: 'proj_weekly',
    chatId: 'chat_weekly',
    name: '周报面板',
    description: '做一个团队周报面板，能按成员筛选，先只做静态页面。',
    workspacePath: '~/Projects/weekly-board',
    templateId: 'blank',
    brand: '周报面板',
    modelId: 'local/qwen3-coder-30b',
    baseAt: '2026-11-06T07:48:00+08:00',
    updatedAt: '2026-11-06T07:56:00+08:00',
    rounds: [
      {
        user: '做一个团队周报面板，能按成员筛选，先只做静态页面。',
        at: '2026-11-06T07:51:00+08:00',
      },
    ],
  });

  return {
    projects: [cafe.project, portfolio.project, weekly.project],
    chats: [cafe.chat, portfolio.chat, weekly.chat],
    skills: SKILLS_SEED.map((skill) => ({ ...skill })),
  };
}
