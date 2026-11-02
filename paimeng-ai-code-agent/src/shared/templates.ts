import type { CodeGenType } from './contracts';

export type TemplateIdentity = { id: string; version: string };
export type TemplateInfo = TemplateIdentity & {
  name: string;
  description: string;
  codeGenType: CodeGenType;
  runtime: 'static' | 'server';
};

/**
 * 新建起点的二分类：`light` 是不需要构建的轻量静态页，`build` 是带构建步骤的前端工程。
 * 存储层的 Generation type 仍是四值，这里只是产品面对 Owner 的两条路。
 */
export type StarterKind = 'light' | 'build';

export const codeGenTemplates: readonly TemplateInfo[] = [
  { id: 'html', version: '1.0.0', name: '原生 HTML', description: '单文件静态页，样式与交互集中在 index.html', codeGenType: 'html', runtime: 'static' },
  { id: 'multi-file', version: '1.0.0', name: '原生多文件', description: '多文件静态站，按目录组织页面、样式与脚本', codeGenType: 'multi_file', runtime: 'static' },
  { id: 'vue-ts', version: '1.0.0', name: 'Vue + TypeScript', description: '从任务清单示例开始，适合交互式前端应用', codeGenType: 'vue_project', runtime: 'static' },
  { id: 'react-ts', version: '1.0.0', name: 'React + TypeScript', description: '同样的任务清单示例，改用 React 与函数组件', codeGenType: 'react_project', runtime: 'static' },
  { id: 'react-ts', version: '2.0.0', name: 'React 厚架子', description: 'React + Vite + Tailwind + shadcn/ui 骨架，含布局、设计令牌、路由与示例页面', codeGenType: 'react_project', runtime: 'static' },
];

export type CreationTemplate = { starter: StarterKind; label: string; description: string; template: TemplateInfo };

function registered(id: string, version: string) {
  const template = codeGenTemplates.find(value => value.id === id && value.version === version);
  if (!template) throw new Error(`未注册的模板 ${id}@${version}`);
  return template;
}

/** 首页「技术栈」下拉里的显式选项：只有轻量静态页和 React 厚架子。 */
export const creationTemplates: readonly CreationTemplate[] = [
  { starter: 'light', label: '轻量静态页', description: '单文件静态页，无需构建，适合内容简单的单页站点', template: registered('html', '1.0.0') },
  { starter: 'build', label: 'React 厚架子', description: 'React + Vite + Tailwind + shadcn/ui 骨架，含布局、设计令牌、路由与示例页面', template: registered('react-ts', '2.0.0') },
];

export function templateForStarter(starter: StarterKind): TemplateInfo {
  const choice = creationTemplates.find(value => value.starter === starter);
  if (!choice) throw new Error(`没有 ${starter} 起点对应的模板`);
  return choice.template;
}
