import { Injectable } from '@nestjs/common'
import { tool } from 'ai'
import { z } from 'zod'
import { errMessage, truncateBytes } from '../common/truncate'
import { DependencyService } from '../runtime/dependency.service'
import { FileService, ToolContext } from '../runtime/file-service'
import { PreviewService } from '../preview/preview.service'
import { RuntimeService } from '../runtime/runtime.service'
import { SkillService } from '../skills/skill.service'
import { AppConfigService } from '../config/config.module'
import { PlanStep, RunDetailsService } from '../runs/run-details.service'

interface ToolDefinition {
  name: string
  description: string
  inputSchema: z.ZodType
  run: (ctx: ToolContext, input: never) => Promise<unknown>
}

@Injectable()
export class ToolRegistryService {
  private readonly definitions: ToolDefinition[]

  constructor(
    private readonly config: AppConfigService,
    private readonly files: FileService,
    private readonly dependencies: DependencyService,
    private readonly skills: SkillService,
    private readonly preview: PreviewService,
    private readonly runtime: RuntimeService,
    private readonly details: RunDetailsService,
  ) {
    const definitions: ToolDefinition[] = [
      {
        name: 'update_plan',
        description:
          '提交或更新本轮任务的执行计划。修改源码或依赖前必须先调用。步骤 1-8 个，状态只能是 pending、in_progress、completed，最多一个 in_progress。',
        inputSchema: z.object({
          steps: z
            .array(
              z.object({
                id: z.string().min(1).max(64),
                title: z.string().min(1).max(200),
                status: z.enum(['pending', 'in_progress', 'completed']),
              }),
            )
            .min(1)
            .max(8),
        }),
        run: async (ctx, input: { steps: PlanStep[] }) => {
          const plan = await this.details.savePlan(ctx.runId, ctx.appId, input.steps)
          ctx.emit('plan-updated', plan)
          return plan
        },
      },
      {
        name: 'read',
        description:
          '读取当前应用源码目录中的文本文件。使用相对路径。返回行号范围、内容、版本和续读 offset。',
        inputSchema: z.object({
          path: z.string().describe('相对项目根目录的文件路径'),
          offset: z.number().int().min(1).optional().describe('起始行号，默认 1'),
          limit: z.number().int().min(1).max(2000).optional().describe('最多读取行数，默认 2000'),
        }),
        run: (ctx, input: { path: string; offset?: number; limit?: number }) =>
          this.files.read(ctx, input.path, input.offset, input.limit),
      },
      {
        name: 'write',
        description:
          '创建或完整覆盖一个文本文件。覆盖已存在文件前必须先 read 同一文件；写入是原子的。单文件上限 1 MiB。为避免模型输出截断，单次参数建议不超过 6000 字符，大文件拆为多个模块或小段 edit。',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        run: (ctx, input: { path: string; content: string }) =>
          this.files.write(ctx, input.path, input.content),
      },
      {
        name: 'edit',
        description:
          '对已读取的文件做精确文本替换。每个 oldText 必须在文件中唯一匹配，不支持模糊匹配；修改前必须 read。单次参数建议不超过 6000 字符，用短且唯一的锚点替换或追加。',
        inputSchema: z.object({
          path: z.string(),
          edits: z
            .array(z.object({ oldText: z.string(), newText: z.string() }))
            .min(1)
            .max(20),
        }),
        run: (ctx, input: { path: string; edits: Array<{ oldText: string; newText: string }> }) =>
          this.files.edit(ctx, input.path, input.edits),
      },
      {
        name: 'delete',
        description:
          '删除文件或目录。文件需先 read。删除目录必须 recursive=true 且 expectedVersion 等于 ls 返回的 version。',
        inputSchema: z.object({
          path: z.string(),
          recursive: z.boolean().optional(),
          expectedVersion: z.string().optional(),
        }),
        run: (ctx, input: { path: string; recursive?: boolean; expectedVersion?: string }) =>
          this.files.delete(ctx, input.path, input.recursive, input.expectedVersion),
      },
      {
        name: 'ls',
        description: '列出目录内容（最多 500 项），返回 path/type/size 与目录版本。',
        inputSchema: z.object({
          path: z.string().optional().describe('默认项目根目录'),
          depth: z.number().int().min(1).max(3).optional(),
        }),
        run: (ctx, input: { path?: string; depth?: number }) =>
          this.files.ls(ctx, input.path ?? '.', input.depth),
      },
      {
        name: 'grep',
        description: '在项目内按正则搜索文件内容，最多返回 100 条匹配。',
        inputSchema: z.object({
          pattern: z.string().describe('正则表达式'),
          path: z.string().optional(),
          glob: z.string().optional().describe('例如 **/*.ts'),
          ignoreCase: z.boolean().optional(),
        }),
        run: (ctx, input: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean }) =>
          this.files.grep(ctx, input.pattern, input.path ?? '.', input.glob, input.ignoreCase),
      },
      {
        name: 'find',
        description: '按 glob 查找文件，最多返回 1000 条。',
        inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
        run: (ctx, input: { pattern: string; path?: string }) =>
          this.files.find(ctx, input.pattern, input.path ?? '.'),
      },
      {
        name: 'load_skill',
        description: '读取平台技能正文。名称使用系统提示中列出的已注册技能，开始时只加载一个匹配技能。',
        inputSchema: z.object({ name: z.string().min(1).max(64) }),
        run: (_ctx, input: { name: string }) => this.skills.load(input.name),
      },
      {
        name: 'read_skill_resource',
        description: '读取技能 references/、scripts/、assets/ 下的文本资源，支持行偏移与行数限制。',
        inputSchema: z.object({
          name: z.string().min(1).max(64),
          path: z.string(),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(2000).optional(),
        }),
        run: (_ctx, input: { name: string; path: string; offset?: number; limit?: number }) =>
          this.skills.readResource(input.name, input.path, input.offset, input.limit),
      },
      {
        name: 'dependencies',
        description:
          '管理项目依赖：list_allowed 查看平台允许清单，list_installed 查看已安装，add 添加并安装，remove 移除并安装，sync 重新同步安装。',
        inputSchema: z.discriminatedUnion('action', [
          z.object({ action: z.literal('list_allowed') }),
          z.object({ action: z.literal('list_installed') }),
          z.object({
            action: z.literal('add'),
            packages: z
              .array(z.object({ name: z.string(), version: z.string() }))
              .min(1)
              .max(10),
          }),
          z.object({ action: z.literal('remove'), names: z.array(z.string()).min(1).max(10) }),
          z.object({ action: z.literal('sync') }),
        ]),
        run: async (
          ctx,
          input:
            | { action: 'list_allowed' }
            | { action: 'list_installed' }
            | { action: 'add'; packages: Array<{ name: string; version: string }> }
            | { action: 'remove'; names: string[] }
            | { action: 'sync' },
        ) => {
          if (input.action === 'list_allowed') return this.dependencies.listAllowed()
          if (input.action === 'list_installed') return this.dependencies.listInstalled(ctx.appId)
          if (input.action === 'add') return this.dependencies.add(ctx, input.packages)
          if (input.action === 'remove') return this.dependencies.remove(ctx, input.names)
          return this.dependencies.sync(ctx)
        },
      },
      {
        name: 'preview',
        description: '查询当前应用预览状态或读取预览容器最近日志。',
        inputSchema: z.discriminatedUnion('action', [
          z.object({ action: z.literal('status') }),
          z.object({ action: z.literal('logs') }),
        ]),
        run: async (ctx, input: { action: 'status' | 'logs' }) => {
          if (input.action === 'status') {
            const status = await this.preview.getStatus(ctx.appId)
            const source = await this.runtime.sourceExists(ctx.appId)
            return { ...status, sourceExists: source }
          }
          return { logs: await this.runtime.previewContainerLogs(ctx.appId) }
        },
      },
    ]
    this.definitions = definitions
  }

  definitionsForModel() {
    return Object.fromEntries(
      this.definitions.map((def) => [
        def.name,
        tool({ description: def.description, inputSchema: def.inputSchema }),
      ]),
    )
  }

  /**
   * 上下文预算使用可序列化的 JSON Schema，而不是直接 JSON.stringify Zod 对象。
   * 后者在 Zod 4 中通常只留下空对象，会低估工具定义占用。
   */
  modelToolSchemas() {
    return Object.fromEntries(
      this.definitions.map((def) => [
        def.name,
        {
          description: def.description,
          inputSchema: z.toJSONSchema(def.inputSchema, { io: 'input' }),
        },
      ]),
    )
  }

  async execute(ctx: ToolContext, name: string, input: unknown): Promise<string> {
    const def = this.definitions.find((d) => d.name === name)
    if (!def) return JSON.stringify({ error: `未知工具 ${name}` })
    if (ctx.isCancelled()) return JSON.stringify({ error: '任务已取消' })
    ctx.emit('tool-started', {
      tool: name,
      toolCallId: ctx.toolCallId,
      input: summarizeToolInput(name, input),
    })
    try {
      const parsed = def.inputSchema.parse(input) as never
      if (await this.planRequired(ctx, name, parsed)) {
        const message = '修改源码或依赖前请先调用 update_plan 提交本轮计划'
        ctx.emit('tool-finished', { tool: name, toolCallId: ctx.toolCallId, ok: false, error: message })
        return JSON.stringify({ error: message })
      }
      const result = await def.run(ctx, parsed)
      const businessError =
        result && typeof result === 'object' && (result as { ok?: unknown }).ok === false
          ? String((result as { error?: unknown }).error ?? '工具执行失败')
          : null
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      const truncated = truncateBytes(text, this.config.toolOutputMaxBytes)
      ctx.emit('tool-finished', {
        tool: name,
        toolCallId: ctx.toolCallId,
        ok: !businessError,
        ...(businessError ? { error: businessError } : {}),
        truncated: truncated.truncated,
        result: summarizeToolResult(name, result),
      })
      return truncated.text
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? `工具参数不正确：${err.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join('.') || '参数'} ${issue.message}`)
              .join('；')}`
          : errMessage(err)
      ctx.emit('tool-finished', { tool: name, toolCallId: ctx.toolCallId, ok: false, error: message })
      return JSON.stringify({ error: message })
    }
  }

  private async planRequired(ctx: ToolContext, name: string, input: unknown): Promise<boolean> {
    const mutatingFileTool = name === 'write' || name === 'edit' || name === 'delete'
    const mutatingDependencyTool =
      name === 'dependencies' &&
      !!input &&
      typeof input === 'object' &&
      ['add', 'remove', 'sync'].includes(String((input as { action?: unknown }).action))
    if (!mutatingFileTool && !mutatingDependencyTool) return false
    return !(await this.details.hasPlan(ctx.runId))
  }
}

/**
 * SSE 只暴露工具摘要，不把 write 的完整文件内容或 edit 的全文推给 UI/日志。
 */
function summarizeToolInput(name: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  const value = input as Record<string, unknown>
  if (name === 'update_plan') {
    return { steps: Array.isArray(value.steps) ? value.steps.length : undefined }
  }
  if (name === 'write') {
    return {
      path: value.path,
      bytes: typeof value.content === 'string' ? Buffer.byteLength(value.content, 'utf8') : undefined,
    }
  }
  if (name === 'edit') {
    return {
      path: value.path,
      edits: Array.isArray(value.edits) ? value.edits.length : undefined,
    }
  }
  if (name === 'delete') {
    return { path: value.path, recursive: value.recursive === true }
  }
  if (name === 'read' || name === 'ls' || name === 'find' || name === 'grep') {
    return { path: value.path, pattern: value.pattern }
  }
  if (name === 'dependencies') {
    return {
      action: value.action,
      packages: Array.isArray(value.packages)
        ? value.packages.map((item) =>
            item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined,
          )
        : undefined,
      names: value.names,
    }
  }
  if (name === 'load_skill' || name === 'read_skill_resource') {
    return { name: value.name, path: value.path }
  }
  if (name === 'preview') return { action: value.action }
  return { keys: Object.keys(value).slice(0, 8) }
}

function summarizeToolResult(name: string, result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null
  const value = result as Record<string, unknown>
  if (name === 'write' || name === 'edit') {
    return {
      path: value.path,
      bytes: value.bytes,
      created: value.created,
    }
  }
  if (name === 'delete') {
    return { path: value.path, deleted: value.deleted, kind: value.kind }
  }
  if (name === 'update_plan') {
    return { revision: value.revision, steps: Array.isArray(value.steps) ? value.steps.length : undefined }
  }
  if (name === 'dependencies') {
    return { ok: value.ok, action: value.action, error: value.error }
  }
  return null
}
