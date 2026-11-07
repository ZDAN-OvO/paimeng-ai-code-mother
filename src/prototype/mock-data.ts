import type {
  Chat,
  FileMap,
  GalleryTemplate,
  Message,
  Model,
  Part,
  Project,
  SiteContent,
  SiteState,
  Skill,
  Template,
  Version,
} from './types';

export const MODELS: Model[] = [
  {
    id: 'local/qwen3-coder-30b',
    name: 'Qwen3 Coder 30B',
    provider: '本地网关',
    note: '本地 · 零成本',
  },
  {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    note: '前端质量最好',
  },
  { id: 'openai/gpt-5.2', name: 'GPT-5.2', provider: 'OpenAI', note: '长上下文' },
  { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', provider: 'DeepSeek', note: '便宜、快' },
];

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

const GALLERY: Omit<GalleryTemplate, 'site'>[] = [
  {
    id: 'gallery-coffee',
    templateId: 'coffee',
    name: '山间咖啡',
    blurb: '单一产区咖啡品牌：主视觉、豆单、门店与订阅说明。',
    look: 'landing',
    uses: 1284,
    brand: '山间咖啡',
    iteration: 1,
    prompt: '做一个山间咖啡馆的官网：要有品牌介绍、招牌豆子、菜单和门店信息，风格温暖一点。',
  },
  {
    id: 'gallery-devtool',
    templateId: 'saas',
    name: '开发者工具',
    blurb: 'SaaS 落地页：导航、三个能力点、定价表与试用入口。',
    look: 'landing',
    uses: 962,
    brand: '栈桥',
    iteration: 2,
    prompt: '做一个开发者工具的落地页：说明它是做什么的、三个核心能力、定价和试用入口。',
  },
  {
    id: 'gallery-portfolio',
    templateId: 'portfolio',
    name: '设计师作品集',
    blurb: '克制的个人站：一句自我介绍、精选项目、联系方式。',
    look: 'landing',
    uses: 517,
    brand: '林迟',
    iteration: 1,
    prompt: '做一个设计师的个人作品集：自我介绍、精选项目、联系方式，排版克制一点。',
  },
  {
    id: 'gallery-studio',
    templateId: 'portfolio',
    name: '摄影工作室',
    blurb: '深色主视觉的品牌站，适合影像、展览与工作室。',
    look: 'landing',
    uses: 403,
    brand: '沈默摄影',
    iteration: 3,
    prompt: '做一个摄影工作室的官网：深色主视觉、作品列表和预约联系方式。',
  },
  {
    id: 'gallery-weekly',
    templateId: 'blank',
    name: '团队周报',
    blurb: '内部工具：按成员筛选的周报列表，先跑通信息结构。',
    look: 'app',
    uses: 318,
    brand: '周报',
    iteration: 2,
    prompt: '做一个团队周报面板，能按成员筛选，先只做静态页面。',
  },
  {
    id: 'gallery-dashboard',
    templateId: 'blank',
    name: '数据看板',
    blurb: '深色数据界面：指标、明细与操作入口，适合后台首页。',
    look: 'dashboard',
    uses: 176,
    brand: '看板',
    iteration: 3,
    prompt: '做一个数据看板：顶部三个指标、中间明细列表、右侧筛选。',
  },
];

export const SKILLS_SEED: Skill[] = [
  {
    slug: 'frontend-design',
    name: '前端设计',
    description: '生成页面前先定版式、间距与配色，避免一眼 AI 味的默认样式。',
    source: 'builtin',
    trusted: true,
    enabled: true,
    files: ['SKILL.md', 'references/layout.md'],
  },
  {
    slug: 'shadcn',
    name: 'shadcn/ui',
    description: '使用 shadcn 组件与 Tailwind 令牌，不要手写重复的按钮与弹窗。',
    source: 'builtin',
    trusted: true,
    enabled: true,
    files: ['SKILL.md', 'references/components.md'],
  },
  {
    slug: 'nextjs',
    name: 'Next.js App Router',
    description: '服务端组件与客户端组件的边界、路由与数据获取约定。',
    source: 'builtin',
    trusted: true,
    enabled: true,
    files: ['SKILL.md'],
  },
  {
    slug: 'debug-and-verify',
    name: '调试与验证',
    description: '先复现问题，再做最小修复；用构建检查与浏览器验证说明结果。',
    source: 'builtin',
    trusted: true,
    enabled: true,
    files: ['SKILL.md', 'references/checklist.md'],
  },
  {
    slug: 'web-search',
    name: '联网搜索',
    description: '需要外部资料时先抓取网页正文，再引用来源。',
    source: 'builtin',
    trusted: true,
    enabled: true,
    files: ['SKILL.md'],
  },
  {
    slug: 'skill-creator',
    name: '技能创建',
    description: '演示把用户需求整理成可复用技能草稿；当前原型使用固定 mock，不调用模型。',
    source: 'builtin',
    trusted: true,
    enabled: false,
    files: ['SKILL.md', 'references/format.md'],
  },
  {
    slug: 'brand-voice',
    name: '品牌语气',
    description: '文案不要感叹号，不要营销套话，句子短一点。',
    source: 'user',
    trusted: true,
    enabled: true,
    files: ['SKILL.md', 'references/examples.md'],
  },
  {
    slug: 'report-export',
    name: '报表导出',
    description: '把页面里的表格导出为 CSV 与 Excel。',
    source: 'user',
    trusted: false,
    enabled: false,
    files: ['SKILL.md', 'scripts/export.ts'],
  },
];

const COPY: Record<
  string,
  {
    headlines: string[];
    taglines: string[];
    ctas: string[];
    nav: string[];
    features: { title: string; body: string }[];
    detailTitle: string;
    details: { name: string; price: string; note: string }[];
    testimonials: { quote: string; author: string }[];
    footerNote: string;
  }
> = {
  coffee: {
    headlines: [
      '一杯来自山间的慢咖啡',
      '把山里的春天装进杯子',
      '烘焙师的日常，从一杯开始',
      '慢一点，喝更好的咖啡',
    ],
    taglines: [
      '每天清晨烘焙，24 小时内送到你手上。',
      '手冲、冷萃与季节限定，只做当季的风味。',
      '单一产区直采，小批量烘焙，风味写在杯测表上。',
      '订阅制咖啡豆，每月按你的口味寄出。',
    ],
    ctas: ['看看这周的豆子', '预约到店品鉴', '阅读冲煮笔记', '开始订阅'],
    nav: ['豆子', '菜单', '门店'],
    features: [
      { title: '每周新鲜烘焙', body: '周一烘焙、周二发货，到手时正是风味最完整的时候。' },
      { title: '单一产区直采', body: '和云南、埃塞的四个小农庄长期合作，价格写在明处。' },
      { title: '按口味订阅', body: '填一次口味偏好，之后每月按你的节奏寄出。' },
    ],
    detailTitle: '本季菜单',
    details: [
      { name: '耶加雪菲 水洗', price: '¥88 / 200g', note: '柑橘 · 茉莉 · 蜂蜜' },
      { name: '哥伦比亚 蜜处理', price: '¥78 / 200g', note: '红糖 · 坚果 · 可可' },
      { name: '店内战斧冰滴', price: '¥38 / 杯', note: '12 小时冷萃 · 每日限量' },
    ],
    testimonials: [
      { quote: '第一次喝到不用加糖也有甜感的豆子，喝完就订了半年。', author: '林一 · 订阅 8 个月' },
      { quote: '包装上写了烘焙日期和冲煮参数，对新手很友好。', author: '周舟 · 门店常客' },
    ],
    footerNote: '山间咖啡 · 杭州 · 每天 08:00 – 19:00',
  },
  saas: {
    headlines: [
      '把想法说清楚，剩下的交给它',
      '从一句描述到可发布的页面',
      '生成、预览、迭代，都在浏览器里',
      '先跑起来，再慢慢变好',
    ],
    taglines: [
      '描述你要的东西，拿到一个能点击、能修改的完整项目。',
      '内置实时预览与版本回滚，改坏了随时退回去。',
      '不写代码也能交付第一版，写代码的人可以接着改。',
      '开源、自托管，数据留在你自己的机器上。',
    ],
    ctas: ['免费开始', '看一段演示', '读部署文档', '加入社区'],
    nav: ['能力', '定价', '文档'],
    features: [
      { title: '一句话生成', body: '用中文描述需求，直接得到多文件、可构建的 Next.js 项目。' },
      { title: '实时预览', body: '沙箱里跑真项目，改完立刻看到结果，刷新不丢。' },
      { title: '版本与回滚', body: '每条回复一个版本，能看 diff，也能一键退回。' },
    ],
    detailTitle: '定价',
    details: [
      { name: '开源版', price: '¥0', note: '自己部署，功能不限' },
      { name: '团队版', price: '¥199 / 月', note: '共享项目与发布地址' },
      { name: '托管版', price: '¥499 / 月', note: '我们帮你跑沙箱' },
    ],
    testimonials: [
      {
        quote: '以前找外包两周起步，现在一个下午能出三个版本给客户挑。',
        author: '陈默 · 独立开发者',
      },
      { quote: '版本和 diff 这两个功能救了命，客户改主意也不怕。', author: '徐清 · 设计工作室' },
    ],
    footerNote: 'Paimeng Labs · 开源项目 · MIT',
  },
  portfolio: {
    headlines: [
      '做有耐心的界面',
      '在结构与手感之间找平衡',
      '把复杂的事做得安静',
      '十年，只做这几件事',
    ],
    taglines: [
      '产品设计师，做过工具、内容与出行。',
      '擅长把信息排清楚，把交互做轻。',
      '目前接少量长期合作，其余时间写自己的项目。',
      '作品不多，但每一个都跟到最后。',
    ],
    ctas: ['看作品', '下载简历', '聊聊合作', '写信给我'],
    nav: ['项目', '关于', '联系'],
    features: [
      { title: '品牌与视觉', body: '从命名、字体到落地物料，一套做完。' },
      { title: '产品界面', body: '复杂后台与移动端，先解决结构再谈风格。' },
      { title: '前端实现', body: '设计稿能落地，动效与可访问性一起交付。' },
    ],
    detailTitle: '精选项目',
    details: [
      { name: '山野地图', price: '2025', note: '徒步路线与离线地图，30 万次下载' },
      { name: '慢读', price: '2024', note: 'Markdown 编辑器，被 200 多个团队使用' },
      { name: '南站', price: '2023', note: '城市交通信息站，纯静态、1 秒内打开' },
    ],
    testimonials: [
      { quote: '她交的东西总能直接用，不用再补一遍细节。', author: '周予 · 产品负责人' },
      { quote: '沟通成本极低，方案里连边界情况都写了。', author: 'Ada · 创业者' },
    ],
    footerNote: '林迟 · 杭州 · 接受 2027 年春季档期',
  },
  blank: {
    headlines: ['从一句话开始', '先做一个能用的版本', '把想法变成页面', '小步快跑'],
    taglines: [
      '这一版先把主流程跑通，细节我们下一轮再调。',
      '页面结构按你说的来，颜色先保持克制。',
      '没有多余的装饰，先把信息放对位置。',
      '每一轮都会留下版本，改坏了可以退回去。',
    ],
    ctas: ['开始使用', '了解更多', '查看示例', '联系我们'],
    nav: ['功能', '价格', '关于'],
    features: [
      { title: '核心流程', body: '把最重要的一步做成一条直线，其余先收起来。' },
      { title: '清晰的信息层级', body: '标题、说明、操作三件事分开，不堆在一起。' },
      { title: '可以继续改', body: '这一轮只是起点，下一轮直接告诉我要改什么。' },
    ],
    detailTitle: '价格',
    details: [
      { name: '基础', price: '¥0', note: '够用就好' },
      { name: '标准', price: '¥99 / 月', note: '更多用量' },
      { name: '高级', price: '按需', note: '单独沟通' },
    ],
    testimonials: [
      { quote: '先给了一个能点的版本，比画原型快多了。', author: '试用用户' },
      { quote: '改了两轮就上线了，回滚功能让人安心。', author: '小团队负责人' },
    ],
    footerNote: '用 Paimeng 生成的原型页面',
  },
};

const ALL_COPY_KEYS = Object.keys(COPY);

export function resolveTemplate(templateId: string, prompt: string): string {
  if (templateId !== 'auto' && COPY[templateId]) return templateId;
  if (/咖啡|豆子|茶|餐厅|烘焙/.test(prompt)) return 'coffee';
  if (/作品集|设计|摄影|插画|博客/.test(prompt)) return 'portfolio';
  if (/SaaS|工具|平台|落地页|产品|订阅/.test(prompt)) return 'saas';
  return 'blank';
}

export function deriveProjectName(prompt: string): string {
  const cleaned = prompt.trim();
  const named = cleaned.match(/(?:叫|名为|叫做)\s*[「“"]?([\u4e00-\u9fa5A-Za-z0-9]{2,12})/);
  if (named) return named[1];
  const target = cleaned.match(
    /(?:做|写|生成|创建|搭)(?:一个|一套|个)?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,10}?)(?:的)?(?:官网|网站|落地页|首页|应用|界面|面板)/,
  );
  if (target) return target[1];
  const fallback = cleaned.replace(/^[做写生成创建一个套]*/, '').slice(0, 10);
  return fallback || '未命名项目';
}

export function buildSiteContent(
  templateId: string,
  brand: string,
  iteration: number,
): SiteContent {
  const key = ALL_COPY_KEYS.includes(templateId) ? templateId : 'blank';
  const copy = COPY[key];
  const index = Math.max(0, iteration - 1);
  const pick = <T>(list: T[]) => list[index % list.length];
  return {
    brand,
    headline: pick(copy.headlines),
    tagline: pick(copy.taglines),
    cta: pick(copy.ctas),
    nav: copy.nav,
    features: copy.features,
    detailTitle: copy.detailTitle,
    details: copy.details,
    testimonial: pick(copy.testimonials),
    footerNote: copy.footerNote,
  };
}

export function buildSite(templateId: string, brand: string, iteration: number): SiteState {
  return {
    iteration,
    layout: Math.min(iteration, 3) as 1 | 2 | 3,
    content: buildSiteContent(templateId, brand, iteration),
  };
}

export const TEMPLATE_GALLERY: (GalleryTemplate & { site: SiteState })[] = GALLERY.map((item) => ({
  ...item,
  site: buildSite(item.templateId, item.brand, item.iteration),
}));

const UI_BUTTON_FILE = `import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-full text-sm font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-stone-900 text-white hover:bg-stone-800',
        outline: 'border border-stone-300 hover:bg-stone-100',
        ghost: 'hover:bg-stone-900/5',
      },
      size: { default: 'h-10 px-6', sm: 'h-8 px-4', icon: 'size-9' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
`;

const UTILS_FILE = `import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;

const CONSTANT_FILES = {
  'app/layout.tsx': `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '首页',
  description: '由 Paimeng 生成的项目',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
`,
  'app/globals.css': `@import 'tailwindcss';

:root {
  --page: #faf7f2;
  --ink: #1c1917;
}

body {
  background: var(--page);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, 'PingFang SC', sans-serif;
  -webkit-font-smoothing: antialiased;
}
`,
  'package.json': `{
  "name": "generated-site",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "next": "^16.4.5",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "tailwind-merge": "^3.3.1"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.3.4",
    "tailwindcss": "^4.3.4"
  }
}
`,
};

function contentFile(site: SiteState): string {
  const c = site.content;
  const list = (items: Record<string, string>[]) => JSON.stringify(items, null, 2);
  return `export const content = {
  brand: ${JSON.stringify(c.brand)},
  headline: ${JSON.stringify(c.headline)},
  tagline: ${JSON.stringify(c.tagline)},
  cta: ${JSON.stringify(c.cta)},
  nav: ${JSON.stringify(c.nav)},
  features: ${list(c.features)},
  detailTitle: ${JSON.stringify(c.detailTitle)},
  details: ${list(c.details)},
  testimonial: ${JSON.stringify(c.testimonial)},
  footerNote: ${JSON.stringify(c.footerNote)},
} as const;
`;
}

function heroFile(site: SiteState): string {
  const dark = site.layout >= 3;
  if (dark) {
    return `import { content } from '@/lib/content';
import { Button } from '@/components/ui/button';

export function Hero() {
  return (
    <section className="bg-stone-950 px-6 pt-24 pb-20 text-stone-50">
      <div className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[1.2fr_1fr] md:items-center">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-stone-400">{content.brand}</p>
          <h1 className="mt-6 text-5xl font-semibold leading-tight tracking-tight">
            {content.headline}
          </h1>
          <p className="mt-6 max-w-md text-base leading-7 text-stone-300">{content.tagline}</p>
          <Button className="mt-9 bg-stone-50 text-stone-950 hover:bg-stone-200">
            {content.cta}
          </Button>
        </div>
        <div className="aspect-square rounded-3xl bg-gradient-to-br from-stone-600 via-stone-800 to-stone-900" />
      </div>
    </section>
  );
}
`;
  }
  return `import { content } from '@/lib/content';
import { Button } from '@/components/ui/button';

export function Hero() {
  return (
    <section className="mx-auto max-w-3xl px-6 pt-24 pb-16 text-center">
      <p className="text-xs uppercase tracking-[0.2em] text-stone-500">{content.brand}</p>
      <h1 className="mt-5 text-5xl font-semibold tracking-tight text-stone-900">
        {content.headline}
      </h1>
      <p className="mt-5 text-base leading-7 text-stone-600">{content.tagline}</p>
      ${site.layout >= 2 ? '<p className="mt-6 inline-block rounded-full bg-stone-900/5 px-3 py-1 text-xs text-stone-600">本季新品已上架</p>\n      ' : ''}<button className="mt-8 rounded-full bg-stone-900 px-6 py-3 text-sm font-medium text-white">
        {content.cta}
      </button>
    </section>
  );
}
`;
}

function pageFile(site: SiteState): string {
  const imports = [`import { Hero } from '@/components/hero';`];
  if (site.layout >= 2) imports.push(`import { SiteHeader } from '@/components/site-header';`);
  imports.push(`import { FeatureGrid } from '@/components/feature-grid';`);
  if (site.layout >= 2)
    imports.push(`import { DetailSection } from '@/components/detail-section';`);
  if (site.layout >= 3)
    imports.push(`import { TestimonialBand } from '@/components/testimonial-band';`);
  imports.push(`import { SiteFooter } from '@/components/site-footer';`);

  const body = [
    site.layout >= 2 ? '      <SiteHeader />' : null,
    '      <Hero />',
    '      <FeatureGrid />',
    site.layout >= 2 ? '      <DetailSection />' : null,
    site.layout >= 3 ? '      <TestimonialBand />' : null,
    '      <SiteFooter />',
  ].filter(Boolean);

  return `${imports.join('\n')}

export default function Page() {
  return (
    <main className="min-h-screen">
${body.join('\n')}
    </main>
  );
}
`;
}

function featureFile(): string {
  return `import { content } from '@/lib/content';

export function FeatureGrid() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-16">
      <div className="grid gap-10 md:grid-cols-3">
        {content.features.map((feature) => (
          <div key={feature.title}>
            <div className="h-9 w-9 rounded-lg bg-stone-900/5" />
            <h2 className="mt-4 text-base font-medium text-stone-900">{feature.title}</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">{feature.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
`;
}

function footerFile(): string {
  return `import { content } from '@/lib/content';

export function SiteFooter() {
  return (
    <footer className="border-t border-stone-200 px-6 py-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 text-xs text-stone-500 sm:flex-row sm:items-center sm:justify-between">
        <span>{content.footerNote}</span>
        <span>{content.brand}</span>
      </div>
    </footer>
  );
}
`;
}

function headerFile(): string {
  return `import { content } from '@/lib/content';
import { Button } from '@/components/ui/button';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-stone-200 bg-[#faf7f2]/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <span className="text-sm font-semibold tracking-tight">{content.brand}</span>
        <nav className="flex items-center gap-6 text-sm text-stone-600">
          {content.nav.map((item) => (
            <a key={item} href="#">
              {item}
            </a>
          ))}
        </nav>
        <Button variant="outline" size="sm">
          {content.cta}
        </Button>
      </div>
    </header>
  );
}
`;
}

function detailFile(): string {
  return `import { content } from '@/lib/content';

export function DetailSection() {
  return (
    <section className="bg-stone-900/[0.03] px-6 py-20">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-baseline justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">{content.detailTitle}</h2>
          <span className="text-xs text-stone-500">共 {content.details.length} 项</span>
        </div>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {content.details.map((item) => (
            <article key={item.name} className="rounded-xl bg-white p-5 shadow-sm">
              <h3 className="text-sm font-medium">{item.name}</h3>
              <p className="mt-1 text-xs text-stone-500">{item.note}</p>
              <p className="mt-6 text-sm text-stone-900">{item.price}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
`;
}

function testimonialFile(): string {
  return `import { content } from '@/lib/content';

export function TestimonialBand() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-20 text-center">
      <p className="text-xs uppercase tracking-[0.25em] text-stone-400">客户评价</p>
      <blockquote className="mt-6 text-xl leading-8 text-stone-800">
        “{content.testimonial.quote}”
      </blockquote>
      <p className="mt-4 text-sm text-stone-500">{content.testimonial.author}</p>
    </section>
  );
}
`;
}

export function buildSiteFiles(site: SiteState): FileMap {
  const files: FileMap = {
    ...CONSTANT_FILES,
    'app/page.tsx': pageFile(site),
    'lib/content.ts': contentFile(site),
    'components/hero.tsx': heroFile(site),
    'components/feature-grid.tsx': featureFile(),
    'components/site-footer.tsx': footerFile(),
    'components/ui/button.tsx': UI_BUTTON_FILE,
    'lib/utils.ts': UTILS_FILE,
  };
  if (site.layout >= 2) {
    files['components/site-header.tsx'] = headerFile();
    files['components/detail-section.tsx'] = detailFile();
  }
  if (site.layout >= 3) {
    files['components/testimonial-band.tsx'] = testimonialFile();
  }
  return files;
}

export function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// 种子数据：一个已经聊过三轮的咖啡馆项目，用来直接演示版本、diff 与发布。
// ---------------------------------------------------------------------------

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function toolsForVersion(site: SiteState, files: FileMap, round: number): Part[] {
  const writePaths = Object.keys(files).filter((path) => path !== 'package.json');
  const parts: Part[] = [
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
  return parts;
}

const SUMMARIES = [
  '首页已经生成：顶部是主视觉，中间是三个能力点，页脚放了信息位。文件按组件拆开，下一轮可以只改其中一块。',
  '加了顶部导航与内容区块，导航项来自内容文件，改文案不用动组件。',
  '主视觉换成深色版，标题和副标题重新写了一遍，并补了一段客户评价。',
];

function seedChatBundle(options: {
  chatId: string;
  projectId: string;
  title: string;
  modelId: string;
  templateId: string;
  brand: string;
  rounds: { user: string; at: string }[];
  baseAt: string;
}): { chat: Chat; versions: Version[] } {
  const versions: Version[] = [];
  const messages: Message[] = [];
  let previousFiles: FileMap = {};

  options.rounds.forEach((round, index) => {
    const iteration = index + 1;
    const site = buildSite(options.templateId, options.brand, iteration);
    const files = buildSiteFiles(site);
    const changedFiles = Object.keys(files).filter((path) => files[path] !== previousFiles[path]);
    previousFiles = files;

    const userMessage: Message = {
      id: `${options.chatId}_u${iteration}`,
      role: 'user',
      parts: [{ type: 'text', text: round.user }],
      createdAt: round.at,
    };
    const versionId = `${options.chatId}_v${iteration}`;
    const parts = toolsForVersion(site, files, iteration);
    const textPart = parts[parts.length - 1];
    if (textPart.type === 'text') {
      textPart.text = SUMMARIES[Math.min(index, SUMMARIES.length - 1)];
    }
    const assistantMessage: Message = {
      id: `${options.chatId}_a${iteration}`,
      role: 'assistant',
      parts,
      createdAt: round.at,
      finishedAt: addSeconds(round.at, 46 + index * 31),
      versionId,
    };

    versions.push({
      id: versionId,
      seq: iteration,
      chatId: options.chatId,
      messageId: assistantMessage.id,
      label: `v${iteration}`,
      summary: SUMMARIES[Math.min(index, SUMMARIES.length - 1)],
      createdAt: round.at,
      files,
      site,
      changedFiles,
    });
    messages.push(userMessage, assistantMessage);
  });

  const last = versions[versions.length - 1];
  return {
    chat: {
      id: options.chatId,
      projectId: options.projectId,
      title: options.title,
      modelId: options.modelId,
      createdAt: options.baseAt,
      updatedAt: last.createdAt,
      messages,
      versions,
      activeVersionId: last.id,
      viewVersionId: last.id,
      streaming: false,
    },
    versions,
  };
}

export function seedProjects(): { projects: Project[]; chats: Chat[]; skills: Skill[] } {
  const cafe = seedChatBundle({
    chatId: 'chat_cafe',
    projectId: 'proj_cafe',
    title: '山间咖啡馆官网',
    modelId: 'anthropic/claude-sonnet-4.5',
    templateId: 'coffee',
    brand: '山间咖啡',
    baseAt: '2026-11-06T09:00:00+08:00',
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

  const portfolio = seedChatBundle({
    chatId: 'chat_portfolio',
    projectId: 'proj_portfolio',
    title: '个人作品集',
    modelId: 'openai/gpt-5.2',
    templateId: 'portfolio',
    brand: '林迟',
    baseAt: '2026-11-05T15:40:00+08:00',
    rounds: [
      {
        user: '做一个设计师的个人作品集：自我介绍、精选项目、联系方式，排版克制一点。',
        at: '2026-11-05T15:41:00+08:00',
      },
      { user: '项目列表加上年份，页脚换成我的邮箱。', at: '2026-11-06T08:32:00+08:00' },
    ],
  });

  const weekly = seedChatBundle({
    chatId: 'chat_weekly',
    projectId: 'proj_weekly',
    title: '团队周报面板',
    modelId: 'local/qwen3-coder-30b',
    templateId: 'blank',
    brand: '周报面板',
    baseAt: '2026-11-06T07:50:00+08:00',
    rounds: [
      {
        user: '做一个团队周报面板，能按成员筛选，先只做静态页面。',
        at: '2026-11-06T07:51:00+08:00',
      },
    ],
  });

  const projects: Project[] = [
    {
      id: 'proj_cafe',
      name: '山间咖啡',
      prompt: '做一个山间咖啡馆的官网：要有品牌介绍、招牌豆子、菜单和门店信息，风格温暖一点。',
      templateId: 'coffee',
      createdAt: '2026-11-06T08:58:00+08:00',
      updatedAt: '2026-11-06T09:14:00+08:00',
      env: [
        { key: 'NEXT_PUBLIC_SHOP_ID', value: 'shop_2041', secret: false },
        { key: 'RESEND_API_KEY', value: 're_9f2c_••••••', secret: true },
      ],
      deployKey: 'cafe-8f2a',
      deploys: [
        {
          id: 'deploy_cafe_1',
          deployKey: 'cafe-8f2a',
          versionId: cafe.versions[2].id,
          versionSeq: 3,
          state: 'ready',
          createdAt: '2026-11-06T09:15:00+08:00',
        },
      ],
    },
    {
      id: 'proj_portfolio',
      name: '林迟 · 作品集',
      prompt: '做一个设计师的个人作品集：自我介绍、精选项目、联系方式，排版克制一点。',
      templateId: 'portfolio',
      createdAt: '2026-11-05T15:38:00+08:00',
      updatedAt: '2026-11-06T08:33:00+08:00',
      env: [],
      deployKey: null,
      deploys: [],
    },
    {
      id: 'proj_weekly',
      name: '周报面板',
      prompt: '做一个团队周报面板，能按成员筛选，先只做静态页面。',
      templateId: 'blank',
      createdAt: '2026-11-06T07:48:00+08:00',
      updatedAt: '2026-11-06T07:56:00+08:00',
      env: [],
      deployKey: null,
      deploys: [],
    },
  ];

  return {
    projects,
    chats: [cafe.chat, portfolio.chat, weekly.chat],
    skills: SKILLS_SEED.map((skill) => ({ ...skill })),
  };
}

export const MODEL_FALLBACK = MODELS[0].id;

/** 固定按东八区生成 ISO 字符串，格式与种子数据一致。 */
export function addSeconds(iso: string, seconds: number): string {
  const time = Date.parse(iso) + seconds * 1000;
  const shifted = new Date(time + 8 * 3600_000);
  return shifted.toISOString().slice(0, 19) + '+08:00';
}

export function nowIso(): string {
  const shifted = new Date(Date.now() + 8 * 3600_000);
  return shifted.toISOString().slice(0, 19) + '+08:00';
}

export function formatTime(iso: string): string {
  // 固定按 ISO 字符串切片，服务端与浏览器渲染结果一致。
  const day = iso.slice(5, 10).replace('-', '/');
  const time = iso.slice(11, 16);
  return `${day} ${time}`;
}

const SAMPLE_SCREENSHOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 360 240">
  <rect width="360" height="240" fill="#f5f5f4"/>
  <rect x="16" y="14" width="328" height="26" rx="6" fill="#e7e5e4"/>
  <circle cx="30" cy="27" r="5" fill="#a8a29e"/>
  <rect x="48" y="22" width="52" height="10" rx="3" fill="#d6d3d1"/>
  <rect x="16" y="56" width="180" height="14" rx="4" fill="#a8a29e"/>
  <rect x="16" y="78" width="140" height="10" rx="3" fill="#d6d3d1"/>
  <rect x="16" y="104" width="76" height="24" rx="12" fill="#78716c"/>
  <rect x="16" y="150" width="96" height="70" rx="8" fill="#e7e5e4"/>
  <rect x="124" y="150" width="96" height="70" rx="8" fill="#e7e5e4"/>
  <rect x="232" y="150" width="96" height="70" rx="8" fill="#e7e5e4"/>
  <text x="16" y="234" font-family="sans-serif" font-size="9" fill="#78716c">视觉参考 · 手绘线框</text>
</svg>`;

export const SAMPLE_SCREENSHOT = `data:image/svg+xml;utf8,${encodeURIComponent(SAMPLE_SCREENSHOT_SVG)}`;
