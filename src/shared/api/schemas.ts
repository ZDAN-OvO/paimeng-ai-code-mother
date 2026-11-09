import { z } from 'zod';

/**
 * 前后端契约的唯一来源。`docs/api.md` 是同一份内容的可读版本。
 * 字段命名对齐 src/server/db/schema.ts；类型一律由 z.infer 推出，不在别处手抄。
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

/** code：检查一次改动本身；completion：交付前核对本轮目标。见 architecture.md 第 6.1 节。 */
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
  versionId: z.string().optional(),
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

export const versionSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  messageId: z.string().nullable(),
  seq: z.number().int().positive(),
  label: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  files: fileMapSchema,
  site: siteStateSchema,
  changedFiles: z.array(z.string()),
  restoredFrom: z.number().int().positive().optional(),
});
export type Version = z.infer<typeof versionSchema>;

export const deploySchema = z.object({
  id: z.string(),
  deployKey: z.string(),
  versionId: z.string(),
  versionSeq: z.number().int().nonnegative(),
  state: z.enum(['building', 'ready', 'failed']),
  createdAt: z.string(),
});
export type Deploy = z.infer<typeof deploySchema>;

export const envVarSchema = z.object({
  key: z.string(),
  value: z.string(),
  secret: z.boolean(),
});
export type EnvVar = z.infer<typeof envVarSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  templateId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  env: z.array(envVarSchema),
  deployKey: z.string().nullable(),
  deploys: z.array(deploySchema),
});
export type Project = z.infer<typeof projectSchema>;

/** 列表与导航用的对话线摘要；消息与版本走各自的端点。 */
export const chatSummarySchema = z.object({
  id: z.string(),
  /** 草稿没有项目：`null` 表示这条会话还没决定要不要变成项目。 */
  projectId: z.string().nullable(),
  /** 只有草稿带这段：转成项目时用它填 Project 的描述与模板。 */
  draft: z.object({ prompt: z.string(), templateId: z.string() }).nullable().default(null),
  title: z.string(),
  modelId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  streaming: z.boolean(),
  /** 归档时间；有值就不出现在默认列表里，只出现在「归档」列表。 */
  archivedAt: z.string().nullable().default(null),
  activeVersionId: z.string().nullable(),
  viewVersionId: z.string().nullable(),
  pendingPlan: z.object({ messageId: z.string(), revision: z.number().int() }).nullable(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

/** 服务端存储形状：消息与版本内联在对话线里。仅 mock 世界与持久化文件使用。 */
export const chatRecordSchema = chatSummarySchema.extend({
  messages: z.array(messageSchema),
  versions: z.array(versionSchema),
  /** 生成中的工作区：预览面板在工具写入时跟随变化，结束后清空。 */
  liveFiles: fileMapSchema.optional(),
  liveSite: siteStateSchema.optional(),
});
export type ChatRecord = z.infer<typeof chatRecordSchema>;

export const skillSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(['builtin', 'user']),
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
  prompt: z.string().min(1),
  templateId: z.string().default('auto'),
  modelId: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const createProjectResponseSchema = z.object({
  project: projectSchema,
  chat: chatSummarySchema,
});
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

export const patchProjectRequestSchema = z.object({ name: z.string().min(1) });
export type PatchProjectRequest = z.infer<typeof patchProjectRequestSchema>;

export const envRequestSchema = z.object({ env: z.array(envVarSchema) });
export type EnvRequest = z.infer<typeof envRequestSchema>;

export const createChatRequestSchema = z.object({
  modelId: z.string().optional(),
  title: z.string().optional(),
});
export type CreateChatRequest = z.infer<typeof createChatRequestSchema>;

/** 首页一句话 / 模板卡：先建草稿并立刻跑首轮，等用户决定要不要变成项目。 */
export const createDraftRequestSchema = z.object({
  prompt: z.string().min(1),
  templateId: z.string().default('auto'),
  modelId: z.string().optional(),
});
export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;

export const createDraftResponseSchema = z.object({
  chat: chatSummarySchema,
  eventsUrl: z.string(),
});
export type CreateDraftResponse = z.infer<typeof createDraftResponseSchema>;

/** 草稿转项目：创建 Project，把这条会话接管过去，不做部署。 */
export const promoteDraftResponseSchema = z.object({
  project: projectSchema,
  chat: chatSummarySchema,
});
export type PromoteDraftResponse = z.infer<typeof promoteDraftResponseSchema>;

export const archivedChatsResponseSchema = z.object({ chats: z.array(chatSummarySchema) });
export type ArchivedChatsResponse = z.infer<typeof archivedChatsResponseSchema>;

export const draftsResponseSchema = z.object({ chats: z.array(chatSummarySchema) });
export type DraftsResponse = z.infer<typeof draftsResponseSchema>;

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
  project: projectSchema.nullable(),
  chat: chatSummarySchema,
  chats: z.array(chatSummarySchema),
  messages: z.array(messageSchema),
  versions: z.array(versionSchema),
  skills: z.array(skillSchema),
  models: z.array(modelSchema),
});
export type ChatBundle = z.infer<typeof chatBundleSchema>;

export const projectsResponseSchema = z.object({
  projects: z.array(
    projectSchema.extend({
      chatCount: z.number().int(),
      versionCount: z.number().int(),
      lastChatId: z.string().nullable(),
      thumb: siteStateSchema.nullable(),
    }),
  ),
});
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;

export const templatesResponseSchema = z.object({
  templates: z.array(templateSchema),
  gallery: z.array(galleryTemplateSchema),
});
export type TemplatesResponse = z.infer<typeof templatesResponseSchema>;

export const modelsResponseSchema = z.object({ models: z.array(modelSchema) });
export type ModelsResponse = z.infer<typeof modelsResponseSchema>;

export const versionsResponseSchema = z.object({ versions: z.array(versionSchema) });
export type VersionsResponse = z.infer<typeof versionsResponseSchema>;

export const versionFilesResponseSchema = z.object({
  versionId: z.string(),
  files: fileMapSchema,
  site: siteStateSchema,
});
export type VersionFilesResponse = z.infer<typeof versionFilesResponseSchema>;

export const diffFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'removed']),
  added: z.number().int(),
  removed: z.number().int(),
  before: z.string(),
  after: z.string(),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const versionDiffResponseSchema = z.object({
  versionId: z.string(),
  files: z.array(diffFileSchema),
});
export type VersionDiffResponse = z.infer<typeof versionDiffResponseSchema>;

export const previewResponseSchema = z.object({
  chatId: z.string(),
  versionId: z.string().nullable(),
  site: siteStateSchema.nullable(),
});
export type PreviewResponse = z.infer<typeof previewResponseSchema>;

export const deployRequestSchema = z.object({ versionId: z.string() });
export type DeployRequest = z.infer<typeof deployRequestSchema>;

export const deployResponseSchema = z.object({
  deploy: deploySchema,
  eventsUrl: z.string(),
});
export type DeployResponse = z.infer<typeof deployResponseSchema>;

export const deploysResponseSchema = z.object({ deploys: z.array(deploySchema) });
export type DeploysResponse = z.infer<typeof deploysResponseSchema>;

export const publishedResponseSchema = z.object({
  project: projectSchema,
  deploy: deploySchema,
  version: versionSchema,
});
export type PublishedResponse = z.infer<typeof publishedResponseSchema>;

export const skillsResponseSchema = z.object({ skills: z.array(skillSchema) });
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
    versionId: z.string().nullable(),
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

export const deployEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('step'),
    step: z.string(),
    state: z.enum(['running', 'done', 'error']),
  }),
  z.object({
    type: z.literal('finish'),
    deployKey: z.string().nullable(),
    state: z.enum(['ready', 'failed']),
  }),
]);
export type DeployEvent = z.infer<typeof deployEventSchema>;
