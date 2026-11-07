// 原型专用类型。真实实现见 docs/architecture.md 第 5 节的数据模型。
export type FileMap = Record<string, string>;

export type ToolState = 'running' | 'done' | 'error';
export type RunStatus =
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'stopped'
  | 'failed'
  | 'budget_exhausted'
  | 'rejected';
export type DemoScenario =
  'normal' | 'repair' | 'failure' | 'budget' | 'evidence' | 'tools' | 'skill-blocked';
export type DesignContext = { component: string; src: string; label: string };
export type TodoItem = {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'completed';
};
export type PlanPart = {
  type: 'plan';
  revision: number;
  title: string;
  steps: string[];
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected';
  feedback?: string;
};
export type RunOptions = {
  plan?: boolean;
  skipPlan?: boolean;
  scenario?: DemoScenario;
  selection?: DesignContext;
};

export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      state: ToolState;
      input: Record<string, unknown>;
      output?: string;
    }
  | { type: 'image'; url: string; name: string }
  | { type: 'selection'; selection: DesignContext }
  | { type: 'todos'; items: TodoItem[] }
  | PlanPart;

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  parts: Part[];
  createdAt: string;
  /** 生成结束时间，用来在折叠行上显示耗时；历史消息可以没有。 */
  finishedAt?: string;
  versionId?: string;
  streaming?: boolean;
  status?: RunStatus;
};

export type SiteContent = {
  brand: string;
  headline: string;
  tagline: string;
  cta: string;
  nav: string[];
  features: { title: string; body: string }[];
  detailTitle: string;
  details: { name: string; price: string; note: string }[];
  testimonial: { quote: string; author: string };
  footerNote: string;
};

export type SiteState = {
  /** 第几轮生成，决定页面结构与文案。 */
  iteration: number;
  layout: 1 | 2 | 3;
  content: SiteContent;
};

export type Version = {
  id: string;
  seq: number;
  chatId: string;
  messageId: string | null;
  label: string;
  summary: string;
  createdAt: string;
  files: FileMap;
  site: SiteState;
  changedFiles: string[];
  restoredFrom?: number;
};

export type Deploy = {
  id: string;
  deployKey: string;
  versionId: string;
  versionSeq: number;
  state: 'building' | 'ready' | 'failed';
  createdAt: string;
};

export type EnvVar = { key: string; value: string; secret: boolean };

export type Project = {
  id: string;
  name: string;
  prompt: string;
  templateId: string;
  createdAt: string;
  updatedAt: string;
  env: EnvVar[];
  deployKey: string | null;
  deploys: Deploy[];
};

export type Chat = {
  id: string;
  projectId: string;
  title: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  versions: Version[];
  activeVersionId: string | null;
  viewVersionId: string | null;
  streaming: boolean;
  /** 生成中的工作区，仅原型用来让文件树与预览随工具调用长出来。 */
  liveFiles?: FileMap;
  liveSite?: SiteState;
  pendingPlan?: { messageId: string; revision: number; prompt: string };
};

export type Skill = {
  slug: string;
  name: string;
  description: string;
  source: 'builtin' | 'user';
  trusted: boolean;
  enabled: boolean;
  files: string[];
  contents?: Record<string, string>;
};

export type TemplateLook = 'landing' | 'app' | 'dashboard';

/** 首页模板画廊的一张卡：一个完整示例应用，点开先看整页，再决定要不要用它开始。 */
export type GalleryTemplate = {
  id: string;
  templateId: string;
  name: string;
  blurb: string;
  look: TemplateLook;
  uses: number;
  brand: string;
  iteration: 1 | 2 | 3;
  prompt: string;
};

export type Template = {
  id: string;
  name: string;
  description: string;
  accent: string;
  prompt: string;
};

export type Model = {
  id: string;
  name: string;
  provider: string;
  note: string;
};

/** 右栏面板：同一时刻只显示一个，宽度可拖。 */
export type RailPanel = 'preview' | 'code' | 'diff' | 'logs' | 'settings' | 'artifact';

/** HUD 的「去演示」通过 intent 驱动工作区 UI，避免每条能力都要单独做页面。 */
export type DemoIntent =
  | 'open-versions'
  | 'open-deploy'
  | 'open-env'
  | 'open-template'
  | 'design-mode'
  | 'attach-screenshot'
  | 'send-search'
  | 'send-iteration'
  | 'prefill-prompt'
  | null;

export type DiffLine = {
  type: 'add' | 'del' | 'same';
  text: string;
  oldNo?: number;
  newNo?: number;
};
