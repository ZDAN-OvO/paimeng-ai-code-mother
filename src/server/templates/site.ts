import type { SiteContent, SiteState } from '@/shared/api/schemas';

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
      { quote: '先给了一个能点的版本，比画图快多了。', author: '试用用户' },
      { quote: '改了两轮就上线了，回滚功能让人安心。', author: '小团队负责人' },
    ],
    footerNote: '由 Paimeng 生成',
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
  const fallback = cleaned
    .replace(/^[做写生成创建一个套]*/, '')
    .split(/[：:，,。；;！!？?\s]/)[0]
    .slice(0, 10);
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
