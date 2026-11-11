import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function dataRoot() {
  return path.resolve(process.env.PAIMENG_DATA_DIR ?? 'data');
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function projectDataDir(projectId: string) {
  return path.join(dataRoot(), 'projects', safeSegment(projectId));
}

export function blobPath(projectId: string, hash: string) {
  return path.join(projectDataDir(projectId), 'blobs', hash.slice(0, 2), hash);
}

export function putBlobSync(projectId: string, bytes: Buffer) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const target = blobPath(projectId, hash);
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    writeFileSync(target, bytes, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return { ref: `${safeSegment(projectId)}/${hash}`, hash, size: bytes.length };
}

export async function putBlob(projectId: string, bytes: Buffer) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const target = blobPath(projectId, hash);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
  return { ref: `${safeSegment(projectId)}/${hash}`, hash, size: bytes.length };
}

export function getBlobSync(ref: string) {
  return readFileSync(resolveBlobPath(ref));
}

function resolveBlobPath(ref: string) {
  const [project, hash] = ref.split('/');
  if (!project || !hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('快照引用不合法');
  return path.join(dataRoot(), 'projects', safeSegment(project), 'blobs', hash.slice(0, 2), hash);
}

export async function getBlob(ref: string) {
  const [project, hash] = ref.split('/');
  if (!project || !hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('快照引用不合法');
  return readFile(resolveBlobPath(ref));
}

export function commandOutputDir(runId: string) {
  return path.join(dataRoot(), 'command-output', safeSegment(runId));
}

export function commandOutputPath(runId: string, commandId: string) {
  return path.join(
    dataRoot(),
    'command-output',
    safeSegment(runId),
    `${safeSegment(commandId)}.log`,
  );
}

export function snapshotGitDir(projectId: string) {
  return path.join(projectDataDir(projectId), 'snapshot.git');
}

export function projectTempPath(directory: string, name: string) {
  const suffix = `.paimeng-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  return path.join(directory, `.${name}${suffix}`);
}

export async function ensureProjectDataDir(projectId: string) {
  await mkdir(projectDataDir(projectId), { recursive: true });
}
