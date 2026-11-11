import { z } from 'zod';

/**
 * 前后端契约的唯一来源。`docs/api.md` 是同一份内容的可读版本。
 * 类型一律由 z.infer 推出，持久层按协议适配。
 */

/** 运行中的对话只可能是这几种状态；没有预算耗尽或拒答这类隐式终态。 */
export const runStatusSchema = z.enum([
  'running',
  'awaiting_approval',
  'succeeded',
  'stopped',
  'failed',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const stopReasonSchema = z.enum(['user_stop', 'service_restart']);
export type StopReason = z.infer<typeof stopReasonSchema>;

export const toolStateSchema = z.enum(['running', 'done', 'error', 'awaiting_approval']);
export type ToolState = z.infer<typeof toolStateSchema>;

export const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** 消息里的一个片段。`id` 让流式更新可以定位到具体片段。 */
export const partSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('text'), text: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal('tool'),
    name: z.string(),
    state: toolStateSchema,
    input: z.record(z.string(), z.unknown()),
    output: z.string().optional(),
    error: z.string().optional(),
    approvalId: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('approval'),
    approvalId: z.string(),
    command: z.string(),
    cwd: z.string(),
    reason: z.string(),
    status: approvalStatusSchema,
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
  stopReason: stopReasonSchema.optional(),
  /** 致命错误只保留面向用户的短原因；详细堆栈不进入对话。 */
  error: z.string().optional(),
});
export type Message = z.infer<typeof messageSchema>;

/** 项目目录的文件路径索引；只用于树形导航，不携带源码内容。 */
export const fileIndexSchema = z.object({
  paths: z.array(z.string()),
  truncated: z.boolean(),
  limit: z.number().int().positive(),
  indexedAt: z.string(),
});
export type FileIndex = z.infer<typeof fileIndexSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  templateId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 项目对应的真实本地目录。 */
  workspacePath: z.string(),
  fileIndex: fileIndexSchema,
  chatCount: z.number().int(),
  changeCount: z.number().int(),
});
export type Project = z.infer<typeof projectSchema>;

/** 按需读取文件时返回的一页文本；二进制文件只返回元数据。 */
export const fileWindowSchema = z.object({
  path: z.string(),
  content: z.string(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  totalLines: z.number().int().nonnegative(),
  truncated: z.boolean(),
  nextOffset: z.number().int().positive().nullable(),
  binary: z.boolean(),
  size: z.number().int().nonnegative(),
});
export type FileWindow = z.infer<typeof fileWindowSchema>;

export const changeKindSchema = z.enum(['added', 'modified', 'deleted']);
export type ChangeKind = z.infer<typeof changeKindSchema>;

export const changeSourceSchema = z.enum(['tool', 'bash', 'user_undo', 'mixed']);
export type ChangeSource = z.infer<typeof changeSourceSchema>;

/** exact：能确定写入来源；uncertain：Bash 窗口重叠或服务中断，不能可靠归因。 */
export const attributionSchema = z.enum(['exact', 'uncertain']);
export type Attribution = z.infer<typeof attributionSchema>;

export const undoStateSchema = z.enum(['applied', 'undone']);
export type UndoState = z.infer<typeof undoStateSchema>;

export const changeFileSchema = z.object({
  path: z.string(),
  change: changeKindSchema,
  source: changeSourceSchema,
  attribution: attributionSchema,
  undoState: undoStateSchema,
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  binary: z.boolean(),
});
export type ChangeFile = z.infer<typeof changeFileSchema>;

export const changeSetStatusSchema = z.enum(['applied', 'partially_undone', 'undone']);
export type ChangeSetStatus = z.infer<typeof changeSetStatusSchema>;

export const changeSetSchema = z.object({
  id: z.string(),
  seq: z.number().int().positive(),
  chatId: z.string(),
  messageId: z.string().nullable(),
  summary: z.string(),
  createdAt: z.string(),
  status: changeSetStatusSchema,
  files: z.array(changeFileSchema),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

/** 某个文件改前或改后的内容；`content` 为空表示文件不存在、二进制或过大。 */
export const changeFileVersionSchema = z.object({
  exists: z.boolean(),
  size: z.number().int().nonnegative(),
  binary: z.boolean(),
  content: z.string().nullable(),
  truncated: z.boolean(),
});
export type ChangeFileVersion = z.infer<typeof changeFileVersionSchema>;

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
  pendingApproval: z.boolean(),
  /** 归档时间；有值就不出现在默认列表里，只出现在「归档」列表。 */
  archivedAt: z.string().nullable().default(null),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const chatRecordSchema = chatSummarySchema.extend({
  messages: z.array(messageSchema),
});
export type ChatRecord = z.infer<typeof chatRecordSchema>;

export const skillFileSchema = z.object({ path: z.string(), content: z.string() });
export type SkillFile = z.infer<typeof skillFileSchema>;

export const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(['user', 'project']),
  filePath: z.string(),
  baseDir: z.string(),
  disableModelInvocation: z.boolean(),
});
export type Skill = z.infer<typeof skillSchema>;
/** 兼容服务端技能发现模块的本地命名。 */
export type LocalSkill = Skill;

export const skillCatalogSchema = z.object({
  skills: z.array(skillSchema),
  directories: z.object({
    user: z.string(),
    project: z.string().nullable(),
  }),
  diagnostics: z.array(
    z.object({
      kind: z.enum(['invalid', 'collision', 'io']),
      path: z.string(),
      message: z.string(),
    }),
  ),
});
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;

export const skillDetailSchema = z.object({
  skill: skillSchema,
  files: z.array(skillFileSchema),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  accent: z.string(),
  prompt: z.string(),
});
export type Template = z.infer<typeof templateSchema>;

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

/** 模板画廊只用于展示模板外观，不会启动示例项目。 */
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

/** 模型标识来自实际配置，不返回凭据，也不提供演示模型。 */
export const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  configured: z.boolean(),
});
export type Model = z.infer<typeof modelSchema>;

/* ---------------------------------------------------------------- 请求体 */

export const openProjectRequestSchema = z.object({ workspacePath: z.string().min(1) });
export type OpenProjectRequest = z.infer<typeof openProjectRequestSchema>;

export const openProjectResponseSchema = z.object({
  project: projectSchema,
  chats: z.array(chatSummarySchema),
});
export type OpenProjectResponse = z.infer<typeof openProjectResponseSchema>;

export const patchProjectRequestSchema = z.object({ name: z.string().min(1) });
export type PatchProjectRequest = z.infer<typeof patchProjectRequestSchema>;

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

export const sendMessageRequestSchema = z.object({
  text: z.string().trim().min(1),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const runAcceptedSchema = z.object({
  runId: z.string(),
  messageId: z.string(),
  eventsUrl: z.string(),
});
export type RunAccepted = z.infer<typeof runAcceptedSchema>;

export const approvalDecisionRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>;

export const undoChangeFileRequestSchema = z.object({ path: z.string().min(1) });
export type UndoChangeFileRequest = z.infer<typeof undoChangeFileRequestSchema>;

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
  createdAt: z.string(),
  updatedAt: z.string(),
  chatCount: z.number().int(),
  changeCount: z.number().int(),
  lastChatId: z.string().nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectsResponseSchema = z.object({ projects: z.array(projectSummarySchema) });
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;

export const projectDetailSchema = z.object({
  project: projectSchema,
  chats: z.array(chatSummarySchema),
  changeSets: z.array(changeSetSchema),
  nextCursor: z.string().nullable(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

export const changesetsResponseSchema = z.object({
  changeSets: z.array(changeSetSchema),
  nextCursor: z.string().nullable(),
});
export type ChangesetsResponse = z.infer<typeof changesetsResponseSchema>;

export const changeSetFileResponseSchema = z.object({
  changeSet: changeSetSchema,
  file: changeFileSchema,
  before: changeFileVersionSchema,
  after: changeFileVersionSchema,
});
export type ChangeSetFileResponse = z.infer<typeof changeSetFileResponseSchema>;

export const undoChangeFileResponseSchema = z.object({
  changeSet: changeSetSchema,
  file: changeFileSchema,
});
export type UndoChangeFileResponse = z.infer<typeof undoChangeFileResponseSchema>;

export const fileIndexResponseSchema = z.object({ fileIndex: fileIndexSchema });
export type FileIndexResponse = z.infer<typeof fileIndexResponseSchema>;

export const templatesResponseSchema = z.object({
  templates: z.array(templateSchema),
  gallery: z.array(galleryTemplateSchema),
});
export type TemplatesResponse = z.infer<typeof templatesResponseSchema>;

export const modelsResponseSchema = z.object({ models: z.array(modelSchema) });
export type ModelsResponse = z.infer<typeof modelsResponseSchema>;

export const healthCheckSchema = z.object({
  node: z.string(),
  git: z.string(),
  bash: z.string(),
  ripgrep: z.string(),
  database: z.string(),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  checks: healthCheckSchema,
  problems: z.array(z.string()),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof apiErrorSchema>;

/* ------------------------------------------------------------ SSE 事件 */

const eventBase = { seq: z.number().int().nonnegative(), runId: z.string() };

export const sseEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal('snapshot'),
    message: messageSchema.nullable(),
    /** 本轮运行状态；没有进行中的运行时为 null。 */
    run: z
      .object({
        id: z.string(),
        status: runStatusSchema,
        messageId: z.string(),
      })
      .nullable(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('part-added'),
    messageId: z.string(),
    part: partSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('part-updated'),
    messageId: z.string(),
    partId: z.string(),
    patch: z.object({
      state: toolStateSchema.optional(),
      output: z.string().optional(),
      error: z.string().optional(),
      approvalStatus: approvalStatusSchema.optional(),
    }),
  }),
  z.object({
    ...eventBase,
    type: z.literal('text-delta'),
    messageId: z.string(),
    partId: z.string(),
    delta: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('files-changed'),
    changeSetId: z.string().nullable(),
    paths: z.array(z.string()),
  }),
  z.object({
    ...eventBase,
    type: z.literal('finish'),
    messageId: z.string(),
    status: runStatusSchema,
    stopReason: stopReasonSchema.nullable(),
    summary: z.string(),
    changeSetId: z.string().nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('error'),
    message: z.string(),
  }),
]);
export type SseEvent = z.infer<typeof sseEventSchema>;
