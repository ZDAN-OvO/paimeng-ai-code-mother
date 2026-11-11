import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

export type Observation = {
  path: string;
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  hash: string;
};

const byRun = new Map<string, Map<string, Observation>>();

export async function observe(runId: string, relative: string, absolute: string, bytes?: Buffer) {
  const info = await lstat(absolute, { bigint: true });
  const content = bytes ?? (await readFile(absolute));
  const observation: Observation = {
    path: relative,
    dev: String(info.dev),
    ino: String(info.ino),
    size: Number(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
    hash: createHash('sha256').update(content).digest('hex'),
  };
  let map = byRun.get(runId);
  if (!map) {
    map = new Map();
    byRun.set(runId, map);
  }
  map.set(relative, observation);
  return observation;
}

export function observationFor(runId: string, relative: string) {
  return byRun.get(runId)?.get(relative);
}

type ObservationMatch =
  | { ok: true; current: Record<string, unknown>; bytes: Buffer }
  | { ok: false; reason: 'missing' | 'changed'; current: Record<string, unknown> | null };

export async function matchesObservation(
  absolute: string,
  observation: Observation,
): Promise<ObservationMatch> {
  const info = await lstat(absolute, { bigint: true }).catch(() => null);
  if (!info) return { ok: false, reason: 'missing' as const, current: null };
  const current = {
    dev: String(info.dev),
    ino: String(info.ino),
    size: Number(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
  if (
    current.dev !== observation.dev ||
    current.ino !== observation.ino ||
    current.size !== observation.size ||
    current.mtimeNs !== observation.mtimeNs ||
    current.ctimeNs !== observation.ctimeNs
  ) {
    return { ok: false, reason: 'changed' as const, current };
  }
  const bytes = await readFile(absolute);
  const hash = createHash('sha256').update(bytes).digest('hex');
  return hash === observation.hash
    ? { ok: true as const, current, bytes }
    : { ok: false, reason: 'changed' as const, current };
}

export function invalidatePath(relative: string) {
  for (const map of byRun.values()) map.delete(relative);
}

export function invalidateRun(runId: string) {
  byRun.delete(runId);
}
