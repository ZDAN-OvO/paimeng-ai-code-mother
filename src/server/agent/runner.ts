import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolLoopAgent, isLoopFinished, type ModelMessage } from 'ai';
import { sqlite, instanceId } from '@/server/db';
import { newId } from '@/server/id';
import { createConfiguredModel } from '@/server/model';
import {
  configuredModels,
  getChatRow,
  getProjectRow,
  messagesForChat,
  projectRoot,
} from '@/server/projects';
import { ApiError } from '@/server/http';
import { createTools } from '@/server/agent/tools';
import { publish } from '@/server/agent/events';
import { takeUndoNotices } from '@/server/agent/notices';
import { cancelRunApprovals, expireStaleApprovals } from '@/server/agent/approvals';
import { killRunBash } from '@/server/agent/bash';
import { diffTrees, snapshotProject } from '@/server/projects/snapshots';
import { recordChange, recoverPendingFileIntents, type FileState } from '@/server/agent/changes';
import type { Message, Part, SseEvent } from '@/shared/api/schemas';

type RunRow = {
  id: string;
  chat_id: string;
  user_message_id: string;
  assistant_message_id: string;
  model_id: string;
  status: 'running' | 'awaiting_approval' | 'succeeded' | 'stopped' | 'failed';
  stop_reason: 'user_stop' | 'service_restart' | null;
  error: string | null;
  instance_id: string;
  step_count: number;
  pending_approval_id: string | null;
  change_set_id: string | null;
  started_at: number;
  finished_at: number | null;
};

type Handle = {
  runId: string;
  chatId: string;
  projectId: string;
  userId: string;
  assistantMessageId: string;
  parts: Part[];
  controller: AbortController;
  seq: number;
  done: Promise<void>;
  resolveDone: () => void;
  stopRequested: boolean;
  awaitingApproval: boolean;
  persistTimer: NodeJS.Timeout | null;
};

const activeByChat = new Map<string, Handle>();
const activeById = new Map<string, Handle>();
let recovery: Promise<void> | null = null;

type RunEvent = SseEvent extends infer T
  ? T extends SseEvent
    ? Omit<T, 'seq' | 'runId'>
    : never
  : never;

function emit(handle: Handle, event: RunEvent) {
  handle.seq += 1;
  publish(handle.projectId, { ...event, seq: handle.seq, runId: handle.runId } as SseEvent);
}

function saveParts(handle: Handle, extra: { status?: RunRow['status']; finishedAt?: number } = {}) {
  sqlite()
    .prepare(
      'update message set parts = ?, status = ?, finished_at = coalesce(?, finished_at) where id = ?',
    )
    .run(
      JSON.stringify(handle.parts),
      extra.status ?? (handle.awaitingApproval ? 'awaiting_approval' : 'running'),
      extra.finishedAt ?? null,
      handle.assistantMessageId,
    );
}

function schedulePersist(handle: Handle) {
  if (handle.persistTimer) return;
  handle.persistTimer = setTimeout(() => {
    handle.persistTimer = null;
    saveParts(handle);
  }, 120);
  handle.persistTimer.unref();
}

function flushPersist(handle: Handle) {
  if (handle.persistTimer) {
    clearTimeout(handle.persistTimer);
    handle.persistTimer = null;
  }
  saveParts(handle);
}

function setRun(handle: Handle, patch: Partial<RunRow>) {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const columns = entries.map(([key]) => `${key} = ?`).join(', ');
  sqlite()
    .prepare(`update agent_run set ${columns} where id = ?`)
    .run(...entries.map(([, value]) => value), handle.runId);
}

function asOutput(value: unknown) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function assistantText(message: Message) {
  return message.parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** 把持久化的消息还原成模型历史；未闭合的工具调用补明确中断结果。 */
export function toModelMessages(messages: Message[], skipId: string): ModelMessage[] {
  const output: ModelMessage[] = [];
  for (const message of messages) {
    if (message.id === skipId) continue;
    if (message.role === 'user') {
      const text = assistantText(message);
      if (text) output.push({ role: 'user', content: text });
      continue;
    }
    const content: Extract<ModelMessage, { role: 'assistant' }>['content'] = [];
    const tools: Extract<Part, { type: 'tool' }>[] = [];
    if (!Array.isArray(content)) continue;
    for (const part of message.parts) {
      if (part.type === 'text' && part.text) content.push({ type: 'text', text: part.text });
      if (part.type === 'tool') {
        content.push({
          type: 'tool-call',
          toolCallId: part.id,
          toolName: part.name,
          input: part.input,
        });
        tools.push(part);
      }
    }
    if (content.length > 0) output.push({ role: 'assistant', content });
    for (const part of tools) {
      output.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: part.id,
            toolName: part.name,
            output:
              part.state === 'done' && part.output !== undefined
                ? { type: 'text', value: part.output }
                : { type: 'error-text', value: part.error ?? '工具执行未完成，已中断' },
          },
        ],
      });
    }
  }
  return output;
}

async function systemPrompt(projectId: string, root: string) {
  let agents = '';
  try {
    const content = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    agents = content.slice(0, 100_000);
  } catch {
    agents = '（项目根目录没有 AGENTS.md）';
  }
  const project = getProjectRow(projectId);
  return [
    '你是派蒙，一个在本机项目目录中工作的开发助手。',
    `当前项目：${project?.name ?? ''}，目录：${root}`,
    '你可以使用 read、write、edit、grep、find、ls、bash 工具。文件写入必须限定在项目目录内。',
    '覆盖已有文件前必须先读取；读取后如果文件被修改，工具会拒绝写入，此时重新读取并合并。',
    'bash 在项目目录执行；sudo、全局安装、git commit/push、项目外 rm/mv 需要用户批准。',
    '工具错误会作为结果返回，你可以修正后继续。不要声称执行了实际没有执行的操作。',
    '项目根 AGENTS.md 的约定如下：',
    agents,
  ].join('\n');
}

function newRunHandle(input: {
  runId: string;
  chatId: string;
  projectId: string;
  userId: string;
  assistantMessageId: string;
}): Handle {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    ...input,
    parts: [],
    controller: new AbortController(),
    seq: 0,
    done,
    resolveDone,
    stopRequested: false,
    awaitingApproval: false,
    persistTimer: null,
  };
}

export async function startRun(chatId: string, text: string) {
  await recoverInterruptedRuns();
  const chat = getChatRow(chatId);
  if (!chat) throw new ApiError(404, '对话不存在');
  const project = getProjectRow(chat.project_id);
  if (!project) throw new ApiError(404, '项目不存在');
  const models = configuredModels().filter((model) => model.configured);
  if (models.length === 0) throw new ApiError(400, '没有配置模型，请设置 AI_MODEL 和 AI_BASE_URL');
  if (activeByChat.has(chatId)) throw new ApiError(409, '这个对话已有一轮正在运行');
  const running = sqlite()
    .prepare(
      "select id from agent_run where chat_id = ? and status in ('running','awaiting_approval') limit 1",
    )
    .get(chatId) as { id: string } | undefined;
  if (running) throw new ApiError(409, '这个对话已有一轮正在运行');

  const now = Date.now();
  const seqRow = sqlite()
    .prepare('select coalesce(max(seq), 0) as seq from message where chat_id = ?')
    .get(chatId) as { seq: number };
  const userId = newId('msg');
  const assistantId = newId('msg');
  const runId = newId('run');
  const modelId = models.some((model) => model.id === chat.model_id) ? chat.model_id : models[0].id;
  sqlite()
    .prepare(
      'insert into message (id, chat_id, seq, role, parts, status, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      userId,
      chatId,
      seqRow.seq + 1,
      'user',
      JSON.stringify([{ id: newId('part'), type: 'text', text }] satisfies Part[]),
      'succeeded',
      now,
    );
  sqlite()
    .prepare(
      'insert into message (id, chat_id, seq, role, parts, status, run_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(assistantId, chatId, seqRow.seq + 2, 'assistant', '[]', 'running', runId, now);
  sqlite()
    .prepare(
      'insert into agent_run (id, chat_id, user_message_id, assistant_message_id, model_id, status, instance_id, started_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(runId, chatId, userId, assistantId, modelId, 'running', instanceId(), now);
  sqlite().prepare('update chat set updated_at = ? where id = ?').run(now, chatId);

  const handle = newRunHandle({
    runId,
    chatId,
    projectId: chat.project_id,
    userId,
    assistantMessageId: assistantId,
  });
  activeByChat.set(chatId, handle);
  activeById.set(runId, handle);
  void execute(handle, text, modelId).catch((error) => {
    console.error('run execution failed', error);
  });
  return { runId, messageId: assistantId, eventsUrl: `/api/chats/${chatId}/events` };
}

async function execute(handle: Handle, text: string, modelId: string) {
  let fatal: Error | null = null;
  let finished = false;
  try {
    const project = getProjectRow(handle.projectId);
    if (!project) throw new Error('项目不存在');
    const root = await projectRoot(handle.projectId);
    const history = messagesForChat(handle.chatId);
    const messages = toModelMessages(history, handle.assistantMessageId);
    const notices: string[] = [];
    const tools = createTools({
      projectId: handle.projectId,
      chatId: handle.chatId,
      runId: handle.runId,
      root,
      onApproval: (input) => {
        handle.awaitingApproval = true;
        const part = handle.parts.find(
          (value): value is Extract<Part, { type: 'tool' }> =>
            value.type === 'tool' && value.id === input.toolCallId,
        );
        if (part) {
          part.state = 'awaiting_approval';
          part.approvalId = input.approvalId;
          emit(handle, {
            type: 'part-updated',
            messageId: handle.assistantMessageId,
            partId: part.id,
            patch: { state: 'awaiting_approval' },
          });
        }
        const approval: Part = {
          id: `approval-${input.approvalId}`,
          type: 'approval',
          approvalId: input.approvalId,
          command: input.command,
          cwd: input.cwd,
          reason: input.reason,
          status: 'pending',
        };
        handle.parts.push(approval);
        setRun(handle, { status: 'awaiting_approval', pending_approval_id: input.approvalId });
        flushPersist(handle);
        emit(handle, {
          type: 'part-added',
          messageId: handle.assistantMessageId,
          part: approval,
        });
      },
    });
    const agent = new ToolLoopAgent({
      id: 'paimeng',
      model: createConfiguredModel(process.env, modelId),
      instructions: await systemPrompt(handle.projectId, root),
      tools,
      stopWhen: isLoopFinished(),
      maxRetries: 0,
      prepareStep: ({ messages: current }) => {
        notices.push(...takeUndoNotices(handle.projectId, handle.runId));
        if (notices.length === 0) return undefined;
        const notice = notices.splice(0).join('\n\n');
        return {
          messages: [...current, { role: 'user' as const, content: `系统通知：${notice}` }],
        };
      },
      onStepEnd: (step) => {
        try {
          sqlite()
            .prepare(
              'insert into agent_step (id, run_id, step_number, messages) values (?, ?, ?, ?)',
            )
            .run(
              newId('step'),
              handle.runId,
              step.stepNumber,
              JSON.stringify(step.response.messages),
            );
          setRun(handle, { step_count: step.stepNumber + 1 });
        } catch (error) {
          throw error;
        }
      },
    });
    const result = await agent.stream({
      messages,
      abortSignal: handle.controller.signal,
    });
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-start') {
        handle.parts.push({ id: chunk.id, type: 'text', text: '' });
        emit(handle, {
          type: 'part-added',
          messageId: handle.assistantMessageId,
          part: { id: chunk.id, type: 'text', text: '' },
        });
      } else if (chunk.type === 'text-delta') {
        let part = handle.parts.find(
          (value): value is Extract<Part, { type: 'text' }> =>
            value.type === 'text' && value.id === chunk.id,
        );
        if (!part) {
          part = { id: chunk.id, type: 'text', text: '' };
          handle.parts.push(part);
          emit(handle, { type: 'part-added', messageId: handle.assistantMessageId, part });
        }
        part.text += chunk.text;
        emit(handle, {
          type: 'text-delta',
          messageId: handle.assistantMessageId,
          partId: part.id,
          delta: chunk.text,
        });
        schedulePersist(handle);
      } else if (chunk.type === 'tool-call') {
        sqlite()
          .prepare(
            'insert into tool_execution (id, run_id, tool_call_id, tool_name, input, state) values (?, ?, ?, ?, ?, ?)',
          )
          .run(
            newId('tool'),
            handle.runId,
            chunk.toolCallId,
            chunk.toolName,
            JSON.stringify(chunk.input ?? {}),
            'running',
          );
        const part: Part = {
          id: chunk.toolCallId,
          type: 'tool',
          name: chunk.toolName,
          state: 'running',
          input: (chunk.input ?? {}) as Record<string, unknown>,
        };
        handle.parts.push(part);
        emit(handle, { type: 'part-added', messageId: handle.assistantMessageId, part });
        flushPersist(handle);
      } else if (chunk.type === 'tool-result') {
        const part = handle.parts.find(
          (value): value is Extract<Part, { type: 'tool' }> =>
            value.type === 'tool' && value.id === chunk.toolCallId,
        );
        if (part) {
          part.state = 'done';
          part.output = asOutput(chunk.output);
          sqlite()
            .prepare(
              "update tool_execution set state = 'done', output = ?, finished_at = ? where run_id = ? and tool_call_id = ?",
            )
            .run(part.output, Date.now(), handle.runId, chunk.toolCallId);
          emit(handle, {
            type: 'part-updated',
            messageId: handle.assistantMessageId,
            partId: part.id,
            patch: { state: 'done', output: part.output },
          });
          flushPersist(handle);
        }
      } else if (chunk.type === 'tool-error') {
        const part = handle.parts.find(
          (value): value is Extract<Part, { type: 'tool' }> =>
            value.type === 'tool' && value.id === chunk.toolCallId,
        );
        if (part) {
          part.state = 'error';
          part.error = chunk.error instanceof Error ? chunk.error.message : String(chunk.error);
          sqlite()
            .prepare(
              "update tool_execution set state = 'error', error = ?, finished_at = ? where run_id = ? and tool_call_id = ?",
            )
            .run(part.error, Date.now(), handle.runId, chunk.toolCallId);
          emit(handle, {
            type: 'part-updated',
            messageId: handle.assistantMessageId,
            partId: part.id,
            patch: { state: 'error', error: part.error },
          });
          flushPersist(handle);
        }
      } else if (chunk.type === 'error') {
        throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
      } else if (chunk.type === 'abort') {
        break;
      }
    }
    finished = true;
  } catch (error) {
    fatal = error instanceof Error ? error : new Error(String(error));
  } finally {
    const stopping = handle.stopRequested || handle.controller.signal.aborted;
    const status: RunRow['status'] = stopping ? 'stopped' : fatal ? 'failed' : 'succeeded';
    const stopReason = stopping ? 'user_stop' : null;
    cancelRunApprovals(handle.runId);
    await killRunBash(handle.runId, stopping ? 'stop' : 'undo').catch(() => undefined);
    for (const part of handle.parts) {
      if (
        part.type === 'tool' &&
        (part.state === 'running' || part.state === 'awaiting_approval')
      ) {
        part.state = 'error';
        part.error = stopping ? '用户停止了这一轮，工具执行已中断' : '运行已结束，工具执行未完成';
      }
      if (part.type === 'approval' && part.status === 'pending') part.status = 'expired';
    }
    if (handle.persistTimer) {
      clearTimeout(handle.persistTimer);
      handle.persistTimer = null;
    }
    const change = sqlite()
      .prepare('select id from change_set where run_id = ? order by created_at desc limit 1')
      .get(handle.runId) as { id: string } | undefined;
    const changeSetId = change?.id ?? null;
    const now = Date.now();
    sqlite()
      .prepare(
        'update message set parts = ?, status = ?, stop_reason = ?, error = ?, change_set_id = ?, finished_at = ? where id = ?',
      )
      .run(
        JSON.stringify(handle.parts),
        status,
        stopReason,
        fatal ? userError(fatal) : null,
        changeSetId,
        now,
        handle.assistantMessageId,
      );
    setRun(handle, {
      status,
      stop_reason: stopReason,
      error: fatal ? userError(fatal) : null,
      pending_approval_id: null,
      change_set_id: changeSetId,
      finished_at: now,
    });
    activeByChat.delete(handle.chatId);
    activeById.delete(handle.runId);
    handle.resolveDone();
    if (finished || stopping || fatal) {
      emit(handle, {
        type: 'finish',
        messageId: handle.assistantMessageId,
        status,
        stopReason,
        summary: changeSetId ? '本轮已结束，可在改动中查看文件差异' : '本轮已结束',
        changeSetId,
        error: fatal ? userError(fatal) : null,
      });
    }
  }
}

function userError(error: Error) {
  if (error.name === 'AbortError') return '本轮已停止';
  const message = error.message || error.name;
  return message.slice(0, 500);
}

export function activeRunForChat(chatId: string) {
  return activeByChat.get(chatId) ?? null;
}

export function activeRun(runId: string) {
  return activeById.get(runId) ?? null;
}

export async function stopRun(chatId: string) {
  const handle = activeByChat.get(chatId);
  if (!handle) return false;
  handle.stopRequested = true;
  handle.controller.abort();
  cancelRunApprovals(handle.runId);
  await killRunBash(handle.runId, 'stop').catch(() => undefined);
  await Promise.race([handle.done, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
  return true;
}

/** 批准/拒绝后同步消息片段和运行状态；重复调用不会再次改变。 */
export function reflectApproval(approvalId: string, status: 'approved' | 'rejected' | 'expired') {
  const approval = sqlite()
    .prepare('select id, run_id, tool_call_id from approval where id = ?')
    .get(approvalId) as { id: string; run_id: string; tool_call_id: string } | undefined;
  if (!approval) return false;
  const handle = activeById.get(approval.run_id);
  const run = sqlite()
    .prepare('select assistant_message_id from agent_run where id = ?')
    .get(approval.run_id) as { assistant_message_id: string } | undefined;
  if (!run) return false;
  if (handle) {
    const approvalPart = handle.parts.find(
      (part): part is Extract<Part, { type: 'approval' }> =>
        part.type === 'approval' && part.approvalId === approvalId,
    );
    if (approvalPart) {
      approvalPart.status = status;
      emit(handle, {
        type: 'part-updated',
        messageId: handle.assistantMessageId,
        partId: approvalPart.id,
        patch: { approvalStatus: status },
      });
    }
    const toolPart = handle.parts.find(
      (part): part is Extract<Part, { type: 'tool' }> =>
        part.type === 'tool' && part.id === approval.tool_call_id,
    );
    if (toolPart && status === 'approved') {
      toolPart.state = 'running';
      emit(handle, {
        type: 'part-updated',
        messageId: handle.assistantMessageId,
        partId: toolPart.id,
        patch: { state: 'running' },
      });
    }
    handle.awaitingApproval = false;
    setRun(handle, { status: 'running', pending_approval_id: null });
    flushPersist(handle);
  } else {
    const row = sqlite()
      .prepare('select parts from message where id = ?')
      .get(run.assistant_message_id) as { parts: string } | undefined;
    if (row) {
      const parts = JSON.parse(row.parts) as Part[];
      for (const part of parts) {
        if (part.type === 'approval' && part.approvalId === approvalId) part.status = status;
      }
      sqlite()
        .prepare('update message set parts = ? where id = ?')
        .run(JSON.stringify(parts), run.assistant_message_id);
    }
  }
  return true;
}

export function recoverInterruptedRuns() {
  if (!recovery) recovery = runRecovery();
  return recovery;
}

async function runRecovery() {
  try {
    expireStaleApprovals();
    await recoverPendingFileIntents();
    const runs = sqlite()
      .prepare("select * from agent_run where status in ('running','awaiting_approval')")
      .all() as RunRow[];
    for (const run of runs) {
      const chat = getChatRow(run.chat_id);
      if (!chat) continue;
      const project = getProjectRow(chat.project_id);
      if (!project) continue;
      const commands = sqlite()
        .prepare("select * from bash_command where run_id = ? and status = 'running'")
        .all(run.id) as { id: string; before_tree: string | null }[];
      for (const command of commands) {
        if (command.before_tree) {
          try {
            const after = await snapshotProject(project.id, project.workspace_path);
            const changes = await diffTrees(project.id, command.before_tree, after);
            for (const change of changes) {
              const before: FileState = change.before
                ? { exists: true, bytes: change.before.bytes, mode: change.before.mode }
                : { exists: false, bytes: Buffer.alloc(0) };
              const afterFile: FileState = change.after
                ? { exists: true, bytes: change.after.bytes, mode: change.after.mode }
                : { exists: false, bytes: Buffer.alloc(0) };
              recordChange({
                projectId: project.id,
                runId: run.id,
                path: change.path,
                source: 'bash',
                attribution: 'uncertain',
                before,
                after: afterFile,
                operation: 'bash',
                detail: '服务中断后补记，无法确认写入者',
              });
            }
          } catch (error) {
            console.error('恢复 Bash 改动失败', error);
          }
        }
        sqlite()
          .prepare("update bash_command set status = 'interrupted', finished_at = ? where id = ?")
          .run(Date.now(), command.id);
      }
      const message = sqlite()
        .prepare('select parts from message where id = ?')
        .get(run.assistant_message_id) as { parts: string } | undefined;
      if (message) {
        const parts = JSON.parse(message.parts) as Part[];
        for (const part of parts) {
          if (
            part.type === 'tool' &&
            (part.state === 'running' || part.state === 'awaiting_approval')
          ) {
            part.state = 'error';
            part.error = '服务重启，工具执行已中断';
          }
          if (part.type === 'approval' && part.status === 'pending') part.status = 'expired';
        }
        const change = sqlite()
          .prepare('select id from change_set where run_id = ? order by created_at desc limit 1')
          .get(run.id) as { id: string } | undefined;
        sqlite()
          .prepare(
            'update message set parts = ?, status = ?, stop_reason = ?, finished_at = ?, change_set_id = ? where id = ?',
          )
          .run(
            JSON.stringify(parts),
            'stopped',
            'service_restart',
            Date.now(),
            change?.id ?? null,
            run.assistant_message_id,
          );
      }
      sqlite()
        .prepare(
          "update agent_run set status = 'stopped', stop_reason = 'service_restart', pending_approval_id = null, finished_at = ? where id = ?",
        )
        .run(Date.now(), run.id);
    }
  } catch (error) {
    console.error('恢复中断运行失败', error);
  }
}
