import 'server-only';
import { constants } from 'node:fs';
import { type FileHandle, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { codeGenTemplates, type TemplateIdentity, type TemplateInfo } from '@/shared/templates';
import { allowedDependencies, validateProjectManifest } from '../delivery/build-contract';

export const TEMPLATE_MARKER = '.paimeng-template.json';
const identitySchema = z.object({ id: z.string(), version: z.string() }).strict();

type TemplateDefinition = {
  files: readonly string[];
  /** 模板入口；工程模板的 TypeScript 入口不能换成 JS 版本。 */
  entry: string;
  /** 在隔离容器中执行的类型检查命令，参数接在约定镜像的入口之后。 */
  typecheck: readonly string[] | null;
  /** 工程模板的包管理器；静态模板没有依赖安装步骤。 */
  packageManager: 'npm' | 'pnpm' | null;
};

const definitions: Record<string, TemplateDefinition> = {
  'html@1.0.0': { files: ['AGENTS.md', 'index.html'], entry: 'index.html', typecheck: null, packageManager: null },
  'multi-file@1.0.0': { files: ['AGENTS.md', 'index.html', 'css/style.css', 'js/main.js'], entry: 'index.html', typecheck: null, packageManager: null },
  'vue-ts@1.0.0': {
    files: ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', '.gitignore', 'README.md', 'AGENTS.md', 'src/main.ts', 'src/App.vue', 'src/style.css', 'src/types/task.ts', 'src/composables/useTasks.ts', 'src/components/TaskItem.vue'],
    entry: 'src/main.ts',
    typecheck: ['node', 'node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit'],
    packageManager: 'npm',
  },
  'react-ts@1.0.0': {
    files: ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', '.gitignore', 'README.md', 'AGENTS.md', 'src/main.tsx', 'src/App.tsx', 'src/style.css', 'src/types/task.ts', 'src/hooks/useTasks.ts', 'src/components/TaskItem.tsx'],
    entry: 'src/main.tsx',
    typecheck: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'],
    packageManager: 'npm',
  },
  'react-ts@2.0.0': {
    files: ['package.json', 'pnpm-lock.yaml', 'index.html', 'vite.config.ts', 'tsconfig.json', '.gitignore', 'README.md', 'AGENTS.md', 'src/main.tsx', 'src/App.tsx', 'src/index.css', 'src/lib/utils.ts', 'src/components/ui/button.tsx', 'src/components/ui/card.tsx', 'src/components/ui/badge.tsx', 'src/components/layout/app-shell.tsx', 'src/components/layout/page-header.tsx', 'src/pages/home.tsx', 'src/pages/about.tsx', 'src/pages/not-found.tsx', 'src/data/dashboard.ts'],
    entry: 'src/main.tsx',
    typecheck: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'],
    packageManager: 'pnpm',
  },
};

const lockfiles = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml' } as const;

function compareVersions(left: string, right: string) {
  const parts = (version: string) => version.split('.').map(part => Number.parseInt(part, 10) || 0);
  const a = parts(left), b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** 没有指定版本时取同 id 的最新版本：新建应用默认拿最新模板。 */
export function resolveTemplate(id: string, version?: string): TemplateInfo {
  const matches = codeGenTemplates.filter(value => value.id === id);
  const template = version ? matches.find(value => value.version === version) : matches.sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!template) throw new Error(`不支持的工程模板 ${id}${version ? `@${version}` : ''}`);
  return template;
}

function definition(template: TemplateIdentity) {
  const resolved = resolveTemplate(template.id, template.version);
  const value = definitions[`${resolved.id}@${resolved.version}`];
  if (!value) throw new Error(`工程模板 ${resolved.id}@${resolved.version} 缺少文件清单`);
  return value;
}

export function templateFiles(template: TemplateIdentity) {
  return definition(template).files;
}

export function templateTypecheck(template: TemplateIdentity) {
  const command = definition(template).typecheck;
  if (!command) throw new Error('静态模板没有容器类型检查命令');
  return command;
}

export function templateEntry(template: TemplateIdentity) {
  return definition(template).entry;
}

export function templatePackageManager(template: TemplateIdentity) {
  const manager = definition(template).packageManager;
  if (!manager) throw new Error('静态模板没有依赖安装方式');
  return manager;
}

export function templateLockfile(template: TemplateIdentity) {
  return lockfiles[templatePackageManager(template)];
}

/** 按类型取最新的模板；没有匹配时返回 null（显式选择由调用方处理）。 */
export function defaultTemplateFor(type: string) {
  return codeGenTemplates.filter(value => value.codeGenType === type).sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

export async function readTemplateFile(template: TemplateIdentity, path: string) {
  if (!templateFiles(template).includes(path)) throw new Error('文件不属于模板');
  return readFile(join(process.cwd(), 'templates', template.id, template.version, path), 'utf8');
}

export async function readTemplateIdentity(root: string): Promise<TemplateInfo | null> {
  let handle: FileHandle;
  try { handle = await open(join(root, TEMPLATE_MARKER), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024) throw new Error('工程模板标识损坏');
    const identity = identitySchema.parse(JSON.parse(await handle.readFile('utf8')));
    return resolveTemplate(identity.id, identity.version);
  } finally { await handle.close(); }
}

/**
 * 旧 npm 工程模板的依赖由模板版本固定：按历史允许清单逐版本比对。
 * pnpm 模板（react-ts@2.0.0）不在这里校验——模型可以用 shell 装依赖，只由依赖来源策略守住 registry。
 */
export async function validateTemplateManifest(template: TemplateIdentity, content: string) {
  const resolved = resolveTemplate(template.id, template.version);
  if (resolved.codeGenType !== 'vue_project' && resolved.codeGenType !== 'react_project') throw new Error('只有前端工程模板可以校验依赖');
  if (templatePackageManager(resolved) === 'pnpm') throw new Error('pnpm 模板不按模板版本锁定依赖，请改用依赖来源校验');
  const allowed = allowedDependencies(resolved.codeGenType);
  const dependencies = validateProjectManifest(resolved.codeGenType, content);
  if (Object.keys(dependencies).length !== Object.keys(allowed).length || Object.entries(allowed).some(([name, version]) => dependencies[name] !== version)) {
    throw new Error(`当前模板的依赖由模板版本固定，请保留全部依赖及版本。可用依赖 ${JSON.stringify(allowed)}`);
  }
  return dependencies;
}
