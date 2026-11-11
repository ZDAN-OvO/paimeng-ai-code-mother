import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { FileWindow } from '@/shared/api/schemas';
import { ApiError } from '@/server/http';

export const DEFAULT_IGNORED = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
]);

const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_LINES = 2000;
const BINARY_SNIFF_BYTES = 8192;

export class WorkspaceError extends ApiError {}

export function toPosix(value: string) {
  return value.split(path.sep).join('/');
}

export function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

/** 只接受绝对、存在且是目录的路径；软链以真实路径作为项目身份。 */
export async function validateWorkspacePath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) throw new WorkspaceError(400, '工作区路径不能为空');
  if (!path.isAbsolute(trimmed)) throw new WorkspaceError(400, '工作区路径必须是绝对路径');
  let actual: string;
  try {
    actual = await realpath(trimmed);
  } catch {
    throw new WorkspaceError(400, '工作区目录不存在');
  }
  const info = await stat(actual);
  if (!info.isDirectory()) throw new WorkspaceError(400, '工作区路径不是目录');
  const protectedRoots = await Promise.all(
    [path.parse(actual).root, homedir(), process.cwd()].map((item) =>
      realpath(item).catch(() => path.resolve(item)),
    ),
  );
  if (protectedRoots.some((protectedRoot) => actual === protectedRoot)) {
    throw new WorkspaceError(400, '不能打开系统根目录、用户主目录或派蒙自身目录');
  }
  const installRoot = await realpath(process.cwd()).catch(() => path.resolve(process.cwd()));
  if (within(installRoot, actual)) {
    throw new WorkspaceError(400, '不能打开派蒙自身或其子目录');
  }
  return { workspacePath: actual, name: path.basename(actual) || actual };
}

/** 读取已有路径：解析软链后必须仍在项目内。 */
export async function resolveExistingPath(root: string, relative: string) {
  if (relative.includes('\0')) throw new WorkspaceError(400, '路径包含非法字符');
  if (path.isAbsolute(relative)) throw new WorkspaceError(403, '只能访问项目内的相对路径');
  const candidate = path.resolve(root, relative);
  if (!within(root, candidate)) throw new WorkspaceError(403, '路径越出项目目录');
  let actual: string;
  try {
    actual = await realpath(candidate);
  } catch {
    throw new WorkspaceError(404, `文件不存在：${relative}`);
  }
  const realRoot = await realpath(root);
  if (!within(realRoot, actual)) throw new WorkspaceError(403, '软链指向项目目录之外');
  return { absolute: actual, relative: toPosix(path.relative(realRoot, actual)) };
}

/**
 * 写入路径：允许目标不存在，但最近的已存在父目录必须真实落在项目内，
 * 防止通过新建目录或软链把写入带到项目外。
 */
export async function resolveWritePath(root: string, relative: string) {
  if (relative.includes('\0')) throw new WorkspaceError(400, '路径包含非法字符');
  if (path.isAbsolute(relative)) throw new WorkspaceError(403, '只能访问项目内的相对路径');
  const realRoot = await realpath(root);
  const candidate = path.resolve(realRoot, relative);
  if (!within(realRoot, candidate)) throw new WorkspaceError(403, '路径越出项目目录');
  let current = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      const info = await lstat(current);
      const actualParent = await realpath(current);
      if (!within(realRoot, actualParent)) throw new WorkspaceError(403, '路径经过的目录越出项目');
      if (info.isDirectory()) {
        const target = path.join(actualParent, ...suffix.reverse());
        if (!within(realRoot, target)) throw new WorkspaceError(403, '路径越出项目目录');
        return { absolute: target, relative: toPosix(path.relative(realRoot, target)) };
      }
      if (suffix.length === 0)
        return { absolute: actualParent, relative: toPosix(path.relative(realRoot, actualParent)) };
      throw new WorkspaceError(400, '父路径不是目录');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new WorkspaceError(403, '路径越出项目目录');
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function isBinary(file: string) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let output = '';
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

/** 流式读取一页文本；总行数精确，内存只保留当前页。 */
export async function readFileWindow(
  absolute: string,
  relative: string,
  offset = 1,
  limit = MAX_READ_LINES,
): Promise<FileWindow> {
  const info = await stat(absolute);
  if (!info.isFile()) throw new WorkspaceError(400, '路径不是文件');
  if (await isBinary(absolute)) {
    return {
      path: relative,
      content: '',
      offset: 1,
      limit,
      totalLines: 0,
      truncated: false,
      nextOffset: null,
      binary: true,
      size: info.size,
    };
  }
  const start = Math.max(1, Math.floor(offset) || 1);
  const requested = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(limit) || MAX_READ_LINES));
  let lineNumber = 0;
  let collected = 0;
  let bytes = 0;
  let content = '';
  let stopped = false;
  const stream = createReadStream(absolute, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < start || stopped) continue;
      if (collected >= requested) continue;
      const separator = collected === 0 ? 0 : 1;
      const remaining = MAX_READ_BYTES - bytes - separator;
      if (remaining <= 0) {
        stopped = true;
        continue;
      }
      const value = Buffer.byteLength(line) > remaining ? truncateUtf8(line, remaining) : line;
      content += (collected === 0 ? '' : '\n') + value;
      bytes += separator + Buffer.byteLength(value);
      collected += 1;
      if (Buffer.byteLength(value) < Buffer.byteLength(line)) stopped = true;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  const available = Math.max(0, lineNumber - start + 1);
  const shown = Math.min(collected, available);
  const truncated = shown < available;
  return {
    path: relative,
    content,
    offset: start,
    limit: requested,
    totalLines: lineNumber,
    truncated,
    nextOffset: truncated ? start + shown : null,
    binary: false,
    size: info.size,
  };
}

type IgnoreRule = {
  base: string;
  pattern: string;
  negate: boolean;
  dirOnly: boolean;
  hasSlash: boolean;
};

async function readIgnoreRules(root: string, directory: string, base: string) {
  const rules: IgnoreRule[] = [];
  let text: string;
  try {
    text = await readFile(path.join(directory, '.gitignore'), 'utf8');
  } catch {
    return rules;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    let pattern = negate ? line.slice(1) : line;
    const dirOnly = pattern.endsWith('/');
    pattern = pattern.replace(/\/+$/, '');
    const hasSlash = pattern.includes('/');
    pattern = pattern.replace(/^\/+/, '');
    if (!pattern) continue;
    rules.push({ base, pattern, negate, dirOnly, hasSlash });
  }
  return rules;
}

function matchesRule(rule: IgnoreRule, relative: string, isDirectory: boolean) {
  const local = toPosix(path.relative(rule.base, relative));
  if (!local || local.startsWith('..')) return false;
  const segments = local.split('/');
  const targets = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
  if (rule.dirOnly) {
    // 目录规则命中自身或其下任意层级；对文件只看它经过的目录。
    const directories = isDirectory ? targets : targets.slice(0, -1);
    return directories.some((target) => {
      const name = target.split('/').at(-1) ?? target;
      return rule.hasSlash
        ? path.matchesGlob(target, rule.pattern) || path.matchesGlob(target, `${rule.pattern}/**`)
        : path.matchesGlob(name, rule.pattern);
    });
  }
  return targets.some((target) => {
    const name = target.split('/').at(-1) ?? target;
    return rule.hasSlash
      ? path.matchesGlob(target, rule.pattern) || path.matchesGlob(target, `${rule.pattern}/**`)
      : path.matchesGlob(name, rule.pattern);
  });
}

function ignored(rules: IgnoreRule[], relative: string, isDirectory: boolean) {
  let result = false;
  for (const rule of rules) {
    if (matchesRule(rule, relative, isDirectory)) result = !rule.negate;
  }
  return result;
}

/**
 * 只枚举展示/快照需要的内容：跳过固定依赖目录与本项目 .gitignore。
 * limit 为 Infinity 时用于快照；文件树按 5000 截断。
 */
export async function listProjectFiles(
  root: string,
  limit = 5000,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;
  async function walk(directory: string, relativeDir: string, inherited: IgnoreRule[]) {
    if (truncated) return;
    const rules = [...inherited, ...(await readIgnoreRules(root, directory, relativeDir))];
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      if (DEFAULT_IGNORED.has(entry.name)) continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const isDirectory = entry.isDirectory();
      if (ignored(rules, relative, isDirectory)) continue;
      if (isDirectory) {
        await walk(absolute, relative, rules);
      } else if (entry.isSymbolicLink()) {
        // 目录软链不展开，避免环和越界；文件软链保留路径，读取时再校验。
        paths.push(relative);
        if (paths.length >= limit) {
          truncated = true;
          return;
        }
      } else if (entry.isFile()) {
        paths.push(relative);
        if (paths.length >= limit) {
          truncated = true;
          return;
        }
      }
    }
  }
  await walk(root, '', []);
  return { paths, truncated };
}

export async function fileBytes(absolute: string) {
  return readFile(absolute);
}

export function looksBinary(buffer: Buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** 撤销和删除用：只校验父目录，不跟随最后一级软链。 */
export async function resolveEntryPath(root: string, relative: string) {
  if (relative.includes('\0')) throw new WorkspaceError(400, '路径包含非法字符');
  if (path.isAbsolute(relative)) throw new WorkspaceError(403, '只能访问项目内的相对路径');
  const realRoot = await realpath(root);
  const parent = path.dirname(path.resolve(realRoot, relative));
  const parentActual = await realpath(parent).catch(() => null);
  if (!parentActual || !within(realRoot, parentActual)) {
    throw new WorkspaceError(403, '路径越出项目目录');
  }
  return { absolute: path.join(parentActual, path.basename(relative)), relative };
}
