import { spawn } from 'node:child_process';
import { lstat, link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { rgPath } from '@vscode/ripgrep';
import { sqlite } from '@/server/db';
import { observe, observationFor, matchesObservation } from '@/server/agent/observations';
import {
  approvalReason,
  bashEnvironment,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  runBash,
} from '@/server/agent/bash';
import {
  abortFileIntent,
  beginFileIntent,
  recordChange,
  recordOperation,
  lastWriter,
  type FileState,
} from '@/server/agent/changes';
import { requestApproval } from '@/server/agent/approvals';
import { diffTrees, recordSnapshot, snapshotProject } from '@/server/projects/snapshots';
import {
  DEFAULT_IGNORED,
  readFileWindow,
  resolveExistingPath,
  resolveWritePath,
} from '@/server/projects/workspace';
import { publish } from '@/server/agent/events';
import { withProjectWrite } from '@/server/concurrency';
import { newId } from '@/server/id';

export type ToolContext = {
  projectId: string;
  chatId: string;
  runId: string;
  root: string;
  onApproval?: (input: {
    approvalId: string;
    toolCallId: string;
    command: string;
    cwd: string;
    reason: string;
  }) => void;
};

function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

function fail(error: unknown) {
  return { ok: false as const, error: errorMessage(error) };
}

const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_GREP_MATCHES = 100;
const MAX_FIND = 1000;
const MAX_LS = 500;
const MAX_TOOL_BYTES = 50 * 1024;
const IGNORE_GLOBS = [
  '!**/.git/**',
  '!**/node_modules/**',
  '!**/.next/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/coverage/**',
];

function cap(text: string) {
  if (Buffer.byteLength(text) <= MAX_TOOL_BYTES) return { text, truncated: false };
  return {
    text: Buffer.from(text).subarray(0, MAX_TOOL_BYTES).toString('utf8'),
    truncated: true,
  };
}

function previousRunId(relative: string, context: ToolContext) {
  const last = lastWriter(context.projectId, relative);
  return last && last.run_id !== context.runId ? last : null;
}

async function recordToolChange(
  context: ToolContext,
  relative: string,
  before: FileState,
  after: FileState,
  operation: 'write' | 'edit' | 'delete',
  intentId?: string,
) {
  const recorded = recordChange({
    projectId: context.projectId,
    runId: context.runId,
    path: relative,
    source: 'tool',
    attribution: 'exact',
    before,
    after,
    operation,
    intentId,
  });
  publish(context.projectId, {
    type: 'files-changed',
    runId: context.runId,
    changeSetId: recorded?.changeSetId ?? null,
    paths: [relative],
  });
  return recorded?.changeSetId ?? null;
}

async function writeAtomic(absolute: string, bytes: Buffer, mode?: number, createOnly = false) {
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.paimeng-${newId('tmp')}`;
  await writeFile(temporary, bytes, mode ? { mode } : undefined);
  if (createOnly) {
    try {
      // link 不覆盖已存在文件，保证「新文件」语义在并发下也成立。
      await link(temporary, absolute);
      return;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  await rename(temporary, absolute);
}

function applyEdits(original: Buffer, edits: { oldText: string; newText: string }[]) {
  const bom = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  let text = original.toString('utf8');
  if (bom) text = text.slice(1);
  const crlf = text.includes('\r\n');
  const normalized = crlf ? text.replace(/\r\n/g, '\n') : text;
  const ranges: { start: number; end: number; newText: string }[] = [];
  for (const [index, edit] of edits.entries()) {
    if (!edit.oldText) throw new Error(`第 ${index + 1} 个替换的 oldText 为空`);
    const first = normalized.indexOf(edit.oldText);
    if (first === -1) throw new Error(`第 ${index + 1} 个替换没有找到唯一匹配`);
    if (normalized.indexOf(edit.oldText, first + 1) !== -1) {
      throw new Error(`第 ${index + 1} 个替换匹配到多处，请提供更多上下文`);
    }
    ranges.push({
      start: first,
      end: first + edit.oldText.length,
      newText: crlf ? edit.newText.replace(/\r\n/g, '\n') : edit.newText,
    });
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) throw new Error('多个替换的范围重叠');
  }
  let next = normalized;
  for (const range of [...ranges].reverse()) {
    next = next.slice(0, range.start) + range.newText + next.slice(range.end);
  }
  const restored = crlf ? next.replace(/\n/g, '\r\n') : next;
  return Buffer.from((bom ? '\uFEFF' : '') + restored, 'utf8');
}

export function createTools(context: ToolContext) {
  const read = tool({
    description:
      '读取项目内文件，返回带行号的内容。默认最多 2000 行或 50 KiB；大文件用 offset 继续读取。写入或编辑已有文件前必须先读取。',
    inputSchema: z.object({
      path: z.string().describe('相对项目根目录的路径'),
      offset: z.number().int().min(1).optional().describe('起始行号，从 1 开始'),
      limit: z.number().int().min(1).max(2000).optional(),
    }),
    execute: async ({ path: requested, offset, limit }) => {
      try {
        const resolved = await resolveExistingPath(context.root, requested);
        const relative = resolved.relative;
        const absolute = resolved.absolute;
        const info = await stat(absolute);
        if (!info.isFile()) return fail('路径不是文件');
        const window = await readFileWindow(absolute, relative, offset ?? 1, limit ?? 2000);
        if (!window.binary) {
          const bytes = await readFile(absolute);
          await observe(context.runId, relative, absolute, bytes);
        }
        recordOperation({
          projectId: context.projectId,
          runId: context.runId,
          path: relative,
          operation: 'read',
          source: 'tool',
          attribution: 'exact',
        });
        if (window.binary) {
          return {
            ok: true,
            path: relative,
            binary: true,
            size: window.size,
            message: '这是二进制文件，未返回内容',
          };
        }
        const lines = window.content
          .split('\n')
          .map((line, index) => `${window.offset + index}\t${line}`)
          .join('\n');
        const capped = cap(lines);
        return {
          ok: true,
          path: relative,
          offset: window.offset,
          totalLines: window.totalLines,
          nextOffset: window.nextOffset,
          truncated: window.truncated || capped.truncated,
          content: capped.text,
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  const write = tool({
    description:
      '创建或覆盖项目内文件。覆盖已有文件前必须在同一轮先读取；新文件不会覆盖已有内容。内容最多 5 MiB。',
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
    }),
    execute: async ({ path: requested, content }) => {
      try {
        const target = await resolveWritePath(context.root, requested);
        const relative = target.relative;
        const bytes = Buffer.from(content, 'utf8');
        if (bytes.length > MAX_WRITE_BYTES) return fail('内容超过 5 MiB 限制');
        const existing = await lstat(target.absolute).catch(() => null);
        if (existing?.isDirectory()) return fail('目标是目录，不能写入');
        const observation = observationFor(context.runId, relative);
        if (existing && !observation) {
          return fail(`覆盖 ${relative} 前必须先读取该文件`);
        }
        return await import('@/server/concurrency').then(({ withProjectWrite }) =>
          withProjectWrite(context.projectId, async () => {
            const current = await lstat(target.absolute).catch(() => null);
            if (current?.isDirectory()) return fail('目标是目录，不能写入');
            let before: FileState = { exists: false, bytes: Buffer.alloc(0) };
            let createOnly = false;
            if (observation) {
              // 读过之后文件被删除也属于版本冲突，不能当成新建覆盖。
              const checked = await matchesObservation(target.absolute, observation);
              if (!checked.ok) {
                const last = previousRunId(relative, context);
                return {
                  ok: false,
                  conflict: true,
                  error: `文件 ${relative} 在读取后已被修改，本次没有写入。请重新读取后合并。`,
                  lastWriter: last ? { source: last.source, at: last.created_at } : null,
                };
              }
              before = {
                exists: true,
                bytes: checked.bytes,
                mode:
                  (await lstat(target.absolute, { bigint: true })).mode & 0o111n
                    ? '100755'
                    : '100644',
              };
            } else {
              if (current) return fail(`覆盖 ${relative} 前必须先读取该文件`);
              createOnly = true;
            }
            const mode = before.exists && before.mode === '100755' ? 0o755 : 0o644;
            const after: FileState = {
              exists: true,
              bytes,
              mode: mode === 0o755 ? '100755' : '100644',
            };
            const intentId = beginFileIntent({
              projectId: context.projectId,
              runId: context.runId,
              path: relative,
              operation: 'write',
              source: 'tool',
              attribution: 'exact',
              before,
              after,
            });
            try {
              await writeAtomic(target.absolute, bytes, mode, createOnly);
            } catch (error) {
              abortFileIntent(intentId, error instanceof Error ? error.message : String(error));
              throw error;
            }
            await observe(context.runId, relative, target.absolute, bytes);
            const changeSetId = await recordToolChange(
              context,
              relative,
              before,
              after,
              'write',
              intentId,
            );
            return {
              ok: true,
              path: relative,
              bytes: bytes.length,
              changeSetId,
            };
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  });

  const edit = tool({
    description:
      '对项目内已有文件做精确文本替换。edits 中每个 oldText 必须在同一原文中唯一匹配且互不重叠；保留 BOM 和原换行风格。编辑前必须先读取文件。',
    inputSchema: z.object({
      path: z.string(),
      edits: z
        .array(z.object({ oldText: z.string(), newText: z.string() }))
        .min(1)
        .max(100),
    }),
    execute: async ({ path: relative, edits }) => {
      try {
        const { absolute } = await resolveExistingPath(context.root, relative);
        const observation = observationFor(context.runId, relative);
        if (!observation) return fail(`编辑 ${relative} 前必须先读取该文件`);
        return await import('@/server/concurrency').then(({ withProjectWrite }) =>
          withProjectWrite(context.projectId, async () => {
            const checked = await matchesObservation(absolute, observation);
            if (!checked.ok) {
              const last = previousRunId(relative, context);
              return {
                ok: false,
                conflict: true,
                error: `文件 ${relative} 在读取后已被修改，本次没有写入。请重新读取后合并。`,
                lastWriter: last ? { source: last.source, at: last.created_at } : null,
              };
            }
            const before: FileState = {
              exists: true,
              bytes: checked.bytes,
              mode: (await lstat(absolute, { bigint: true })).mode & 0o111n ? '100755' : '100644',
            };
            const next = applyEdits(before.bytes, edits);
            if (next.equals(before.bytes)) return { ok: true, path: relative, changed: false };
            const mode = before.mode === '100755' ? 0o755 : 0o644;
            const after: FileState = { exists: true, bytes: next, mode: before.mode };
            const intentId = beginFileIntent({
              projectId: context.projectId,
              runId: context.runId,
              path: relative,
              operation: 'edit',
              source: 'tool',
              attribution: 'exact',
              before,
              after,
            });
            try {
              await writeAtomic(absolute, next, mode);
            } catch (error) {
              abortFileIntent(intentId, error instanceof Error ? error.message : String(error));
              throw error;
            }
            await observe(context.runId, relative, absolute, next);
            const changeSetId = await recordToolChange(
              context,
              relative,
              before,
              after,
              'edit',
              intentId,
            );
            return {
              ok: true,
              path: relative,
              added: edits.length,
              changeSetId,
            };
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  });

  const bash = tool({
    description:
      '在项目目录执行 Bash 命令。默认超时 120 秒，最大 600 秒；输出全量保存，模型只收到尾部。sudo、全局安装、git commit/push、项目外 rm/mv 需要用户批准。',
    inputSchema: z.object({
      command: z.string(),
      timeout: z.number().int().min(1).max(600).optional().describe('超时秒数'),
    }),
    execute: async ({ command, timeout }, options) => {
      try {
        const reason = approvalReason(command, context.root);
        let approvalId: string | undefined;
        if (reason) {
          approvalId = newId('approval');
          context.onApproval?.({
            approvalId,
            toolCallId: options.toolCallId,
            command,
            cwd: context.root,
            reason,
          });
          const decision = await requestApproval({
            approvalId,
            runId: context.runId,
            chatId: context.chatId,
            toolCallId: options.toolCallId,
            command,
            cwd: context.root,
            reason,
            signal: options.abortSignal,
          });
          if (decision === 'rejected') {
            return { ok: false, rejected: true, approvalId, error: '用户拒绝了这条命令' };
          }
        }
        return withProjectWrite(context.projectId, async () => {
          const beforeTree = await snapshotProject(context.projectId, context.root);
          await recordSnapshot(
            context.projectId,
            context.runId,
            `bash-before:${options.toolCallId}`,
            beforeTree,
          );
          const result = await runBash({
            projectId: context.projectId,
            runId: context.runId,
            toolCallId: options.toolCallId,
            command,
            cwd: context.root,
            timeoutMs: Math.min(MAX_TIMEOUT_MS, (timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000),
            approvalId,
          });
          const afterTree = await snapshotProject(context.projectId, context.root);
          await recordSnapshot(
            context.projectId,
            context.runId,
            `bash-after:${options.toolCallId}`,
            afterTree,
          );
          sqlite()
            .prepare('update bash_command set before_tree = ?, after_tree = ? where id = ?')
            .run(beforeTree, afterTree, result.commandId);
          // 快照只能显示窗口内发生了哪些变化，不能证明写入者，Bash 改动统一标为归属不确定。
          const attribution = 'uncertain' as const;
          const changes = await diffTrees(context.projectId, beforeTree, afterTree);
          const paths: string[] = [];
          let changeSetId: string | null = null;
          for (const change of changes) {
            const before: FileState = change.before
              ? { exists: true, bytes: change.before.bytes, mode: change.before.mode }
              : { exists: false, bytes: Buffer.alloc(0) };
            const after: FileState = change.after
              ? { exists: true, bytes: change.after.bytes, mode: change.after.mode }
              : { exists: false, bytes: Buffer.alloc(0) };
            const recorded = recordChange({
              projectId: context.projectId,
              runId: context.runId,
              path: change.path,
              source: 'bash',
              attribution,
              before,
              after,
              operation: 'bash',
              detail: `${command.slice(0, 200)} (${result.commandId})`,
            });
            if (recorded) {
              changeSetId = recorded.changeSetId;
              paths.push(change.path);
            }
          }
          if (paths.length > 0)
            publish(context.projectId, {
              type: 'files-changed',
              runId: context.runId,
              changeSetId,
              paths,
            });
          const output = cap(result.tail);
          if (result.stoppedBy === 'undo') {
            return {
              ok: false,
              userUndo: true,
              error:
                '用户撤销了文件，Bash 已被终止。请重新读取相关文件，不要自动重做被撤销的改动。',
              commandId: result.commandId,
              output: output.text,
              changedPaths: paths,
            };
          }
          return {
            ok: result.exitCode === 0 && !result.timedOut && !result.stopped,
            commandId: result.commandId,
            outputId: result.outputId,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            stopped: result.stopped,
            stoppedBy: result.stoppedBy,
            truncated: result.truncated || output.truncated,
            outputRecord: result.outputPath,
            output: output.text,
            changedPaths: paths,
            changeSetId,
            attribution,
            durationMs: result.durationMs,
          };
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const grep = tool({
    description:
      '用固定版本的 ripgrep 搜索项目文本。默认最多返回 100 条；遵守 .gitignore，并忽略 .git/node_modules/.next/dist/build/coverage。',
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().optional().describe('相对项目根的搜索目录或文件'),
      glob: z.string().optional(),
      caseInsensitive: z.boolean().optional(),
    }),
    execute: async ({ pattern, path: relative, glob, caseInsensitive }) => {
      try {
        const cwd = relative
          ? (await resolveExistingPath(context.root, relative)).absolute
          : context.root;
        const args = [
          '--line-number',
          '--no-heading',
          '--color',
          'never',
          '--max-columns',
          '500',
          '--max-columns-preview',
          ...IGNORE_GLOBS.flatMap((value) => ['--glob', value]),
        ];
        if (caseInsensitive) args.push('--ignore-case');
        if (glob) args.push('--glob', glob);
        args.push('--', pattern, '.');
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve) => {
            const child = spawn(rgPath, args, {
              cwd,
              env: { ...bashEnvironment(), RIPGREP_CONFIG_PATH: '' },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => {
              if (stdout.length < MAX_TOOL_BYTES * 4) stdout += chunk.toString('utf8');
            });
            child.stderr.on('data', (chunk: Buffer) => {
              stderr += chunk.toString('utf8');
            });
            child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
            child.on('close', (code) => resolve({ code, stdout, stderr }));
          },
        );
        if (result.code === 1) return { ok: true, matches: [], truncated: false };
        if (result.code !== 0) return fail(result.stderr || `ripgrep 退出码 ${result.code}`);
        const lines = result.stdout.split('\n').filter(Boolean);
        const matches = lines.slice(0, MAX_GREP_MATCHES);
        return {
          ok: true,
          matches,
          truncated: lines.length > MAX_GREP_MATCHES || result.stdout.length >= MAX_TOOL_BYTES * 4,
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  const find = tool({
    description:
      '用固定版本的 ripgrep 按 glob 查找项目文件，默认最多 1000 条；遵守 .gitignore，并忽略 .git/node_modules/.next/dist/build/coverage。',
    inputSchema: z.object({
      pattern: z.string().describe('glob，如 **/*.ts'),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    execute: async ({ pattern, limit }) => {
      try {
        const hasGlob = /[*?[\]{}]/.test(pattern);
        const args = [
          '--files',
          '--hidden',
          '--color',
          'never',
          '--no-messages',
          ...IGNORE_GLOBS.flatMap((value) => ['--glob', value]),
          '--glob',
          hasGlob ? pattern : `*${pattern}*`,
          '--',
          '.',
        ];
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve) => {
            const child = spawn(rgPath, args, {
              cwd: context.root,
              env: { ...bashEnvironment(), RIPGREP_CONFIG_PATH: '' },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => {
              if (stdout.length < MAX_TOOL_BYTES * 4) stdout += chunk.toString('utf8');
            });
            child.stderr.on('data', (chunk: Buffer) => {
              stderr += chunk.toString('utf8');
            });
            child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
            child.on('close', (code) => resolve({ code, stdout, stderr }));
          },
        );
        if (result.code === 1) return { ok: true, matches: [], truncated: false };
        if (result.code !== 0) return fail(result.stderr || `ripgrep 退出码 ${result.code}`);
        const lines = result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => line.replace(/^\.\//, ''));
        const size = Math.min(MAX_FIND, limit ?? MAX_FIND);
        return {
          ok: true,
          matches: lines.slice(0, size),
          truncated: lines.length > size || result.stdout.length >= MAX_TOOL_BYTES * 4,
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  const ls = tool({
    description: '列出项目内一个目录的直接子项，默认最多 500 条。',
    inputSchema: z.object({
      path: z.string().default('.'),
    }),
    execute: async ({ path: relative }) => {
      try {
        const { absolute } = await resolveExistingPath(context.root, relative || '.');
        const info = await stat(absolute);
        if (!info.isDirectory()) return fail('路径不是目录');
        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(absolute, { withFileTypes: true });
        const sorted = entries
          .filter((entry) => !DEFAULT_IGNORED.has(entry.name))
          .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'}\t${entry.name}`)
          .sort((left, right) => left.localeCompare(right));
        return {
          ok: true,
          entries: sorted.slice(0, MAX_LS),
          truncated: sorted.length > MAX_LS,
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  return { read, write, edit, bash, grep, find, ls };
}
