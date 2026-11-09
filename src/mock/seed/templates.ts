import type { GalleryTemplate, Template } from '@/shared/api/schemas';

export const TEMPLATES: Template[] = [
  {
    id: 'auto',
    name: '自动判断',
    description: '不选模板，让模型按描述决定结构。',
    accent: 'bg-stone-200',
    prompt: '',
  },
  {
    id: 'coffee',
    name: '咖啡馆官网',
    description: '品牌介绍、菜单、门店信息与客户评价。',
    accent: 'bg-amber-200',
    prompt: '做一个山间咖啡馆的官网：要有品牌介绍、招牌豆子、菜单和门店信息，风格温暖一点。',
  },
  {
    id: 'saas',
    name: 'SaaS 落地页',
    description: '产品定位、核心能力、定价与试用入口。',
    accent: 'bg-indigo-200',
    prompt: '做一个开发者工具的落地页：说明它是做什么的、三个核心能力、定价和试用入口。',
  },
  {
    id: 'portfolio',
    name: '个人作品集',
    description: '自我介绍、精选项目与联系方式。',
    accent: 'bg-rose-200',
    prompt: '做一个设计师的个人作品集：自我介绍、精选项目、联系方式，排版克制一点。',
  },
];

export const PROMPT_SUGGESTIONS = [
  '做一个山间咖啡馆的官网，要有菜单、豆子介绍和门店信息',
  '做一个开发者工具的落地页，讲清三个核心能力和定价',
  '做一个设计师作品集，只放四个精选项目',
  '做一个团队周报面板，能按成员筛选',
];

export const TEMPLATE_LOOKS: { id: GalleryTemplate['look'] | 'all'; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'landing', label: '落地页' },
  { id: 'app', label: '应用' },
  { id: 'dashboard', label: '数据面板' },
];
