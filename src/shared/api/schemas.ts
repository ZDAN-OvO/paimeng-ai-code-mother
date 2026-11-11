import { z } from 'zod';

/**
 * 前后端契约的唯一来源。`docs/api.md` 是同一份内容的可读版本。
 * 类型一律由 z.infer 推出，持久层按协议适配。
 */

export const fileMapSchema = z.record(z.string(), z.string());
export type FileMap = z.infer<typeof fileMapSchema>;

export const toolStateSchema = z.enum(['running', 'done', 'error']);
export type ToolState = z.infer<typeof toolStateSchema>;

export const runStatusSchema = z.enum([
  'running',
  'awaiting_approval',
  'succeeded',
  'stopped',
  'failed',
  'budget_exhausted',
  'rejected',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const designContextSchema = z.object({
  component: z.string(),
  src: z.string(),
  label: z.string(),
});
export type DesignContext = z.infer<typeof designContextSchema>;

export const todoItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

export const planStatusSchema = z.enum(['pending', 'approved', 'changes_requested', 'rejected']);
export type PlanStatus = z.infer<typeof planStatusSchema>;

/** code：检查一次改动本身；completion：交付前核对本轮目标。 */
export const reviewKindSchema = z.enum(['code', 'completion']);
export type ReviewKind = z.infer<typeof reviewKindSchema>;

export const reviewVerdictSchema = z.enum(['passed', 'changes_requested']);
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/** 消息里的一个片段。`id` 让流式更新可以定位到具体片段。 */
export const partSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('text'), text: z.string() }),
  z.object({ id: z.string(), type: z.literal('reasoning'), text: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal('tool'),
    name: z.string(),
    state: toolStateSchema,
    input: z.record(z.string(), z.unknown()),
    output: z.string().optional(),
  }),
  z.object({ id: z.string(), type: z.literal('image'), url: z.string(), name: z.string() }),
  z.object({ id: z.string(), type: z.literal('selection'), selection: designContextSchema }),
  z.object({ id: z.string(), type: z.literal('todos'), items: z.array(todoItemSchema) }),
  z.object({
    id: z.string(),
    type: z.literal('plan'),
    revision: z.number().int().positive(),
    title: z.string(),
    steps: z.array(z.string()),
    status: planStatusSchema,
    feedback: z.string().optional(),
  }),
  /**
   * 一次 review subagent 调用。`round` 按 kind 各自从 1 计数；`revision` 是被审的源码修订。
   * 运行中 `state` 为 running、没有 verdict；结束后 `state` 为 done 并带 verdict，
   * 打回时 `findings` 是打回理由。subagent 自身失败时 `state` 为 error。
   */
  z.object({
    id: z.string(),
    type: z.literal('review'),
    kind: reviewKindSchema,
    round: z.number().int().positive(),
    revision: z.string(),
    scope: z.string(),
    state: toolStateSchema,
    verdict: reviewVerdictSchema.optional(),
    findings: z.array(z.string()).optional(),
  }),
]);
export type Part = z.infer<typeof partSchema>;

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  parts: z.array(partSchema),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  /** 这一轮留下的改动记录；没有改动文件时为空。 */
  changeSetId: z.string().optional(),
  streaming: z.boolean().optional(),
  status: runStatusSchema.optional(),
  /** 本轮最后的源码修订是否通过了 completion review；成功但为 false 时界面标「未经完成审查」。 */
  completionReviewed: z.boolean().optional(),
});
export type Message = z.infer<typeof messageSchema>;

export const siteContentSchema = z.object({
  brand: z.string(),
  headline: z.string(),
  tagline: z.string(),
  cta: z.string(),
  nav: z.array(z.string()),
  features: z.array(z.object({ title: z.string(), body: z.string() })),
  detailTitle: z.string(),
  details: z.array(z.object({ name: z.string(), price: z.string(), note: z.string() })),
  testimonial: z.object({ quote: z.string(), author: z.string() }),
  footerNote: z.string(),
});
export type SiteContent = z.infer<typeof siteContentSchema>;

export const siteStateSchema = z.object({
  iteration: z.number().int().nonnegative(),
  layout: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  content: siteContentSchema,
});
export type SiteState = z.infer<typeof siteStateSchema>;

export const changeSetStatusSchema = z.enum(['applied', 'undone']);
export type ChangeSetStatus = z.infer<typeof changeSetStatusSchema>;

/**
 * 一轮对话对项目文件做的一次改动。`before` / `after` 是撤销与 diff 的唯一依据：
 * 撤销时把 `before` 写回，比较当前文件与 `after` 判断有没有后续编辑。
 */
export const changeSetSchema = z.object({
  id: z.string(),
  seq: z.number().int().positive(),
  chatId: z.string(),
  messageId: z.string().nullable(),
  summary: z.string(),
  createdAt: z.string(),
  /** applied：改动仍在当前文件里；undone：已经撤销。 */
  status: changeSetStatusSchema,
  changedFiles: z.array(z.string()),
  before: fileMapSchema,
  after: fileMapSchema,
  siteBefore: siteStateSchema.nullable(),
  siteAfter: siteStateSchema.nullable(),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

/** 项目目录里由助手管理的本地进程。首版 `source` 恒为 sample，没有真的启动。 */
export const runtimeSchema = z.object({
  state: z.enum(['stopped', 'starting', 'running', 'failed']),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  logs: z.array(z.string()),
  source: z.enum(['sample', 'local']),
});
export type Runtime = z.infer<typeof runtimeSchema>;

/** sample：示例项目，没有连接真实磁盘目录；linked：已连接本地目录。 */
export const workspaceStateSchema = z.enum(['sample', 'linked']);
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export const envVarSchema = z.object({
  key: z.string(),
  value: z.string(),
  secret: z.boolean(),
});
export type EnvVar = z.infer<typeof envVarSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  templateId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  env: z.array(envVarSchema),
  /** 项目对应的本地目录；首版示例项目还没有真正读写这里。 */
  workspacePath: z.string(),
  workspaceState: workspaceStateSchema,
  /** 项目共享态：当前文件与预览以它为准，不再按对话或历史版本切换。 */
  files: fileMapSchema,
  site: siteStateSchema.nullable(),
  changeSets: z.array(changeSetSchema),
  runtime: runtimeSchema,
});
export type Project = z.infer<typeof projectSchema>;

/** 列表与导航用的对话线摘要；消息走单独的端点。 */
export const chatSummarySchema = z.object({
  id: z.string(),
  /** 对话必须属于某个项目；没有「草稿会话」这一层。 */
  projectId: z.string(),
  title: z.string(),
  modelId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  streaming: z.boolean(),
  /** 归档时间；有值就不出现在默认列表里，只出现在「归档」列表。 */
  archivedAt: z.string().nullable().default(null),
  pendingPlan: z.object({ messageId: z.string(), revision: z.number().int() }).nullable(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

/**
 * 进行中回合的起点：本轮第一条消息与改动前的项目快照。
 * 落盘后进程重启时用它把已经写入的文件收尾成一条可撤销的改动记录。
 */
export const roundStartSchema = z.object({
  messageId: z.string(),
  before: z.object({ files: fileMapSchema, site: siteStateSchema.nullable() }),
});
export type RoundStart = z.infer<typeof roundStartSchema>;

/** 服务端存储形状：消息内联在对话线里。仅 mock 世界与持久化文件使用。 */
export const chatRecordSchema = chatSummarySchema.extend({
  messages: z.array(messageSchema),
  /** 只剩进行中的回合有值；收尾时清空，不参与前端列表。 */
  activeRound: roundStartSchema.nullable().optional(),
});
export type ChatRecord = z.infer<typeof chatRecordSchema>;

export const skillSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(['builtin', 'user']),
  disableModelInvocation: z.boolean().optional(),
  trusted: z.boolean(),
  enabled: z.boolean(),
  files: z.array(z.string()),
  contents: z.record(z.string(), z.string()).optional(),
});
export type Skill = z.infer<typeof skillSchema>;

export const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  accent: z.string(),
  prompt: z.string(),
});
export type Template = z.infer<typeof templateSchema>;

export const galleryTemplateSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  name: z.string(),
  blurb: z.string(),
  look: z.enum(['landing', 'app', 'dashboard']),
  uses: z.number().int().nonnegative(),
  brand: z.string(),
  iteration: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string(),
  site: siteStateSchema,
});
export type GalleryTemplate = z.infer<typeof galleryTemplateSchema>;

export const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  note: z.string(),
});
export type Model = z.infer<typeof modelSchema>;

export const worldStateSchema = z.object({
  version: z.literal(1),
  projects: z.array(projectSchema),
  chats: z.array(chatRecordSchema),
  skills: z.array(skillSchema),
});
export type WorldState = z.infer<typeof worldStateSchema>;

/* ---------------------------------------------------------------- 请求体 */

export const createProjectRequestSchema = z.object({
  /** 项目对应的本地目录。首版示例项目会原样记下路径，但不会真的读写磁盘。 */
  workspacePath: z.string().min(1),
  /** 不填时按描述或目录名推一个。 */
  name: z.string().optional(),
  prompt: z.string().default(''),
  templateId: z.string().default('auto'),
  modelId: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const createProjectResponseSchema = z.object({
  project: projectSchema,
  chat: chatSummarySchema,
});
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

export const openProjectRequestSchema = z.object({ workspacePath: z.string().min(1) });
export type OpenProjectRequest = z.infer<typeof openProjectRequestSchema>;

export const patchProjectRequestSchema = z.object({ name: z.string().min(1) });
export type PatchProjectRequest = z.infer<typeof patchProjectRequestSchema>;

export const envRequestSchema = z.object({ env: z.array(envVarSchema) });
export type EnvRequest = z.infer<typeof envRequestSchema>;

export const createChatRequestSchema = z.object({
  modelId: z.string().optional(),
  title: z.string().optional(),
});
export type CreateChatRequest = z.infer<typeof createChatRequestSchema>;

export const archivedChatsResponseSchema = z.object({ chats: z.array(chatSummarySchema) });
export type ArchivedChatsResponse = z.infer<typeof archivedChatsResponseSchema>;

export const patchChatRequestSchema = z.object({
  modelId: z.string().optional(),
  title: z.string().optional(),
});
export type PatchChatRequest = z.infer<typeof patchChatRequestSchema>;

export const attachmentSchema = z.object({ name: z.string(), dataUrl: z.string() });
export type Attachment = z.infer<typeof attachmentSchema>;

export const sendMessageRequestSchema = z.object({
  text: z.string().default(''),
  attachments: z.array(attachmentSchema).default([]),
  selection: designContextSchema.optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const runAcceptedSchema = z.object({ messageId: z.string(), eventsUrl: z.string() });
export type RunAccepted = z.infer<typeof runAcceptedSchema>;

export const planDecisionSchema = z.object({
  decision: z.enum(['approved', 'changes_requested', 'rejected']),
  feedback: z.string().optional(),
});
export type PlanDecision = z.infer<typeof planDecisionSchema>;

export const chatBundleSchema = z.object({
  project: projectSchema,
  chat: chatSummarySchema,
  chats: z.array(chatSummarySchema),
  messages: z.array(messageSchema),
  skills: z.array(skillSchema),
  models: z.array(modelSchema),
});
export type ChatBundle = z.infer<typeof chatBundleSchema>;

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  templateId: z.string(),
  workspacePath: z.string(),
  workspaceState: workspaceStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  chatCount: z.number().int(),
  changeCount: z.number().int(),
  lastChatId: z.string().nullable(),
  thumb: siteStateSchema.nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectsResponseSchema = z.object({ projects: z.array(projectSummarySchema) });
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;

export const templatesResponseSchema = z.object({
  templates: z.array(templateSchema),
  gallery: z.array(galleryTemplateSchema),
});
export type TemplatesResponse = z.infer<typeof templatesResponseSchema>;

export const modelsResponseSchema = z.object({ models: z.array(modelSchema) });
export type ModelsResponse = z.infer<typeof modelsResponseSchema>;

export const undoChangeSetResponseSchema = z.object({
  project: projectSchema,
  changeSet: changeSetSchema,
});
export type UndoChangeSetResponse = z.infer<typeof undoChangeSetResponseSchema>;

export const localSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(['user', 'project']),
  filePath: z.string(),
  baseDir: z.string(),
  disableModelInvocation: z.boolean(),
});
export type LocalSkill = z.infer<typeof localSkillSchema>;

export const skillCatalogSchema = z.object({
  skills: z.array(localSkillSchema),
  directories: z.object({ user: z.string(), project: z.string().nullable() }),
  diagnostics: z.array(
    z.object({
      kind: z.enum(['invalid', 'collision', 'io']),
      path: z.string(),
      message: z.string(),
    }),
  ),
});
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;

export const skillsResponseSchema = z.object({
  skills: z.array(skillSchema),
  catalog: skillCatalogSchema.optional(),
});
export type SkillsResponse = z.infer<typeof skillsResponseSchema>;

export const skillPatchSchema = z.object({
  enabled: z.boolean().optional(),
  trusted: z.boolean().optional(),
});
export type SkillPatch = z.infer<typeof skillPatchSchema>;

export const skillImportSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  trusted: z.boolean().default(false),
  slug: z.string().optional(),
  description: z.string().optional(),
});
export type SkillImport = z.infer<typeof skillImportSchema>;

export const skillDraftRequestSchema = z.object({ prompt: z.string() });
export type SkillDraftRequest = z.infer<typeof skillDraftRequestSchema>;

export const skillDraftResponseSchema = z.object({
  slug: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  manifest: z.string(),
});
export type SkillDraftResponse = z.infer<typeof skillDraftResponseSchema>;

export const apiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof apiErrorSchema>;

/* ------------------------------------------------------------ SSE 事件 */

export const sseEventSchema = z.discriminatedUnion('type', [
  z.object({
    seq: z.number().int(),
    type: z.literal('snapshot'),
    message: messageSchema.nullable(),
  }),
  z.object({
    seq: z.number().int(),
    type: z.literal('part-added'),
    messageId: z.string(),
    part: partSchema,
  }),
  z.object({
    seq: z.number().int(),
    type: z.literal('part-updated'),
    messageId: z.string(),
    partId: z.string(),
    patch: z.object({
      state: toolStateSchema.optional(),
      output: z.string().optional(),
      items: z.array(todoItemSchema).optional(),
      verdict: reviewVerdictSchema.optional(),
      findings: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    seq: z.number().int(),
    type: z.literal('text-delta'),
    messageId: z.string(),
    partId: z.string(),
    delta: z.string(),
  }),
  z.object({
    seq: z.number().int(),
    type: z.literal('finish'),
    messageId: z.string(),
    status: runStatusSchema,
    summary: z.string(),
    changeSetId: z.string().nullable(),
    completionReviewed: z.boolean(),
  }),
  z.object({
    seq: z.number().int(),
    type: z.literal('preview'),
    site: siteStateSchema,
    files: fileMapSchema,
  }),
  z.object({ seq: z.number().int(), type: z.literal('error'), message: z.string() }),
]);
export type SseEvent = z.infer<typeof sseEventSchema>;
