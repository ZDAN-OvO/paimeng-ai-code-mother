#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

/**
 * 容器内的「轮末屏障」原型。
 *
 * 目标：在平台提交源码之前，确保没有任何非白名单进程还能写 Workspace。
 * 做法：把 dev server 进程树 SIGSTOP，枚举 /proc，按 PID 杀掉其余进程，
 * TERM 宽限期后 KILL，轮询 /proc 直到只剩白名单与僵尸；快照后再 SIGCONT。
 *
 * 这是 spike 原型，不是生产实现；它只用于回答「枚举 + 冻结是否足够」。
 */

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const devPid = Number(option('--dev') ?? 0);
const graceMs = Number(option('--grace') ?? 800);
const freeze = args.includes('--freeze');
const waitMs = Number(option('--wait') ?? 4000);
const snapshotFile = option('--snapshot') ?? '/work/barrier-snapshot.json';
const watchFile = option('--file') ?? '/work/late.log';

async function procList() {
  const entries = await readdir('/proc').catch(() => []);
  const rows = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const match = stat.match(/^(\d+) \((.+)\) (\S) (\d+) (\d+) (\d+)/);
      if (!match) continue;
      const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean).join(' ');
      rows.push({ pid, comm: match[2], state: match[3], ppid: Number(match[4]), pgid: Number(match[5]), sid: Number(match[6]), cmdline });
    } catch { /* 进程在读取时退出 */ }
  }
  return rows;
}

function childrenOf(rows) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.ppid) ?? [];
    list.push(row.pid);
    map.set(row.ppid, list);
  }
  return map;
}

function descendants(rows, root) {
  const children = childrenOf(rows);
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return seen;
}

async function signal(pid, sig) {
  try { process.kill(pid, sig); return true; } catch { return false; }
}

async function hashes() {
  const files = [watchFile, '/work/dev-heartbeat.txt'];
  const result = {};
  for (const file of files) {
    try {
      const data = await readFile(file);
      result[file] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    } catch { result[file] = null; }
  }
  return result;
}

const before = await procList();
const me = process.pid;
const ancestors = new Set([1]);
for (let current = me; current > 1; current = before.find(row => row.pid === current)?.ppid ?? 1) {
  ancestors.add(current);
  if (current === 1) break;
}
const devTree = devPid > 0 ? descendants(before, devPid) : new Set();
const allowed = new Set([...ancestors, ...devTree]);
const allowedRows = before.filter(row => allowed.has(row.pid));

if (freeze) for (const pid of devTree) await signal(pid, 'SIGSTOP');
const stopped = await procList();
const victims = stopped.filter(row => !allowed.has(row.pid) && row.state !== 'Z');
// 先冻结再杀：忽略 TERM 的 shell 会在它的 sleep 子进程被 TERM 后立刻执行下一句 echo。
for (const row of victims) await signal(row.pid, 'SIGSTOP');
const stopAt = Date.now();
let victimsStopped = 0;
while (Date.now() - stopAt < graceMs) {
  const states = new Map((await procList()).map(row => [row.pid, row.state]));
  victimsStopped = victims.filter(row => states.get(row.pid) === 'T' || states.get(row.pid) === undefined).length;
  if (victimsStopped === victims.length) break;
  await new Promise(done => setTimeout(done, 25));
}
for (const row of victims) await signal(row.pid, 'SIGKILL');

let remaining = [];
const deadline = Date.now() + waitMs;
while (Date.now() < deadline) {
  remaining = (await procList()).filter(row => !allowed.has(row.pid) && row.state !== 'Z');
  if (remaining.length === 0) break;
  await new Promise(done => setTimeout(done, 50));
}
const zombieCount = (await procList()).filter(row => row.state === 'Z').length;

const frozenBefore = await hashes();
if (freeze) {
  await new Promise(done => setTimeout(done, 600));
}
const frozenAfter = await hashes();
if (freeze) for (const pid of devTree) await signal(pid, 'SIGCONT');

const result = {
  devPid,
  freeze,
  graceMs,
  ancestorPids: [...ancestors],
  allowedPids: allowedRows.map(row => ({ pid: row.pid, comm: row.comm, cmdline: row.cmdline.slice(0, 120) })),
  victims: victims.map(row => ({ pid: row.pid, comm: row.comm, pgid: row.pgid, sid: row.sid, cmdline: row.cmdline.slice(0, 160) })),
  victimsStopped,
  stubborn: [],
  remaining: remaining.map(row => ({ pid: row.pid, comm: row.comm, cmdline: row.cmdline.slice(0, 120) })),
  zombieCount,
  durationMs: Date.now() - stopAt,
  frozenBefore,
  frozenAfter,
  heartbeatUnchangedWhileFrozen: freeze ? frozenBefore['/work/dev-heartbeat.txt']?.sha256 === frozenAfter['/work/dev-heartbeat.txt']?.sha256 : null,
};
console.log(JSON.stringify(result, null, 2));
