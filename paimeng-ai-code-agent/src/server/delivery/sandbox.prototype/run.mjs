// THROWAWAY PROTOTYPE. No product DB, no harness integration, no production sandbox guarantee.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const runId = randomUUID().slice(0, 8);
const runRoot = join(root, 'runtime', 'sandbox-prototype', runId);
const cacheRoot = join(root, 'runtime', 'sandbox-prototype', 'dependencies');
const image = 'node:24-alpine';
const registry = process.env.BUILD_NPM_REGISTRY || 'https://registry.npmjs.org';
const report = {
  prototype: true,
  runId,
  startedAt: new Date().toISOString(),
  image,
  memoryLimitMiB: 768,
  cpuLimit: 1,
  dependencies: [],
  jobs: [],
  events: [],
};
const containers = new Set();
let active = 0;
let maxActive = 0;
let tail = Promise.resolve();
let blocked = false;
const log = (event, detail = {}) => {
  report.events.push({ at: new Date().toISOString(), event, ...detail });
  console.log(`[prototype] ${event} ${JSON.stringify(detail)}`);
};
const docker = (args, options = {}) =>
  exec('docker', args, { timeout: 180_000, maxBuffer: 2 * 1024 * 1024, ...options });
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const exists = async (path) =>
  readFile(path).then(
    () => true,
    () => false,
  );
const security = [
  '--user',
  `${process.getuid()}:${process.getgid()}`,
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--memory=768m',
  '--memory-swap=768m',
  '--cpus=1',
  '--pids-limit=128',
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,size=128m',
  '--env',
  'HOME=/tmp',
  '--env',
  'npm_config_cache=/tmp/npm',
];

async function removeContainer(name) {
  await docker(['rm', '-f', name], { timeout: 15_000 });
  containers.delete(name);
  log('container-removed', { name });
}

// Trusted, versioned template manifests only. Generated source never enters the online installer.
async function prepareDependencies(template) {
  const templateRoot = join(root, 'templates', template, '1.0.0');
  const lock = await readFile(join(templateRoot, 'package-lock.json'));
  const key = createHash('sha256').update(image).update(lock).digest('hex').slice(0, 16);
  const directory = join(cacheRoot, `${template}-${key}`);
  const ready = join(directory, 'ready.json');
  const start = performance.now();
  const reused = await exists(ready);
  if (!reused) {
    await mkdir(directory, { recursive: true });
    await cp(join(templateRoot, 'package.json'), join(directory, 'package.json'));
    await writeFile(join(directory, 'package-lock.json'), lock);
    const name = `paimeng-prototype-${runId}-install-${template}`;
    containers.add(name);
    log('install-started', { template, name });
    try {
      const output = await docker([
        'run',
        '--name',
        name,
        '--label',
        `paimeng.prototype=${runId}`,
        ...security,
        '--mount',
        `type=bind,src=${directory},dst=/work`,
        '--workdir',
        '/work',
        '--env',
        `npm_config_registry=${registry}`,
        image,
        'npm',
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ]);
      await writeFile(join(runRoot, `install-${template}.log`), output.stdout + output.stderr);
      // Vite's bundled config needs an isolated writable temporary directory under node_modules.
      await mkdir(join(directory, 'node_modules', '.vite-temp'), { recursive: true });
      await writeFile(ready, JSON.stringify({ image, key, template }));
    } finally {
      await removeContainer(name);
    }
  }
  report.dependencies.push({
    template,
    key,
    reused,
    elapsedMs: Math.round(performance.now() - start),
  });
  log('dependencies-ready', report.dependencies.at(-1));
  return directory;
}

async function memory(name) {
  // cgroup peak includes file cache; it is not the Docker stats working-set reading.
  const result = await docker([
    'exec',
    name,
    'node',
    '-e',
    "const f=require('fs'); console.log(JSON.stringify({currentBytes:Number(f.readFileSync('/sys/fs/cgroup/memory.current','utf8')),peakBytes:Number(f.readFileSync('/sys/fs/cgroup/memory.peak','utf8'))}))",
  ]);
  return JSON.parse(result.stdout);
}

function enqueue(spec) {
  const record = {
    id: spec.id,
    template: spec.template,
    kind: spec.kind || 'build',
    status: 'queued',
    queuedAt: Date.now(),
    rounds: [],
  };
  report.jobs.push(record);
  log('queued', { id: spec.id });
  const promise = tail.then(async () => {
    if (blocked) {
      record.status = 'blocked';
      return;
    }
    if (spec.cancelled) {
      record.status = 'cancelled-before-start';
      log('queued-cancelled', { id: spec.id });
      return;
    }
    const directory = join(runRoot, spec.id);
    await cp(join(root, 'templates', spec.template, '1.0.0'), directory, { recursive: true });
    const name = `paimeng-prototype-${runId}-${spec.id.toLowerCase()}`;
    const started = performance.now();
    record.status = 'running';
    record.waitMs = Date.now() - record.queuedAt;
    record.container = name;
    containers.add(name);
    active++;
    maxActive = Math.max(maxActive, active);
    check(active === 1, 'More than one execution owns the slot');
    let forcedStop;
    try {
      await docker([
        'run',
        '-d',
        '--name',
        name,
        '--label',
        `paimeng.prototype=${runId}`,
        ...security,
        '--network=none',
        '--mount',
        `type=bind,src=${directory},dst=/work`,
        '--mount',
        `type=bind,src=${spec.dependencies}/node_modules,dst=/work/node_modules,readonly`,
        '--tmpfs',
        '/work/node_modules/.vite-temp:rw,nosuid,nodev,size=16m,mode=1777',
        '--workdir',
        '/work',
        image,
        'node',
        '-e',
        'setInterval(()=>{}, 1000)',
      ]);
      const live = (
        await docker(['ps', '-q', '--filter', `label=paimeng.prototype=${runId}`])
      ).stdout
        .trim()
        .split('\n')
        .filter(Boolean);
      check(live.length === 1, `Expected one live prototype container, found ${live.length}`);
      record.idleMemory = await memory(name);
      log('started', {
        id: spec.id,
        container: name,
        idleMiB: Math.round(record.idleMemory.currentBytes / 1024 ** 2),
      });
      const probe = JSON.parse(
        (
          await docker([
            'exec',
            name,
            'node',
            '-e',
            `
        const fs=require('fs');
        let sharedWriteBlocked=false;
        try { fs.writeFileSync('/work/node_modules/prototype-write-probe','bad'); } catch { sharedWriteBlocked=true; }
        const interfaces=Object.keys(require('os').networkInterfaces());
        console.log(JSON.stringify({sharedWriteBlocked,interfaces,platformSecretVisible:fs.existsSync('/work/.env'),dockerSocketVisible:fs.existsSync('/var/run/docker.sock')}));
      `,
          ])
        ).stdout,
      );
      record.probe = probe;
      check(
        probe.sharedWriteBlocked &&
          !probe.platformSecretVisible &&
          !probe.dockerSocketVisible &&
          probe.interfaces.every((name) => name === 'lo'),
        'Isolation configuration probe failed',
      );
      if (spec.kind === 'timeout' || spec.kind === 'cancel') {
        // A descendant would keep writing if only the docker exec client were killed.
        const descendant =
          "require('fs').writeFileSync('/work/descendant-started','started');setTimeout(()=>require('fs').writeFileSync('/work/descendant-survived','bad'),2500);setInterval(()=>{},1000)";
        const program = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});console.log('descendant-started');setInterval(()=>{},1000)`;
        const execStarted = performance.now();
        let trigger;
        const stop = new Promise((_, reject) => {
          forcedStop = setTimeout(() => {
            trigger = spec.kind;
            reject(new Error(spec.kind));
          }, 800);
        });
        try {
          await Promise.race([docker(['exec', name, 'node', '-e', program]), stop]);
        } catch (error) {
          if (!trigger) throw error;
        }
        record.stopReason = trigger;
        record.memory = await memory(name);
        record.stopAfterMs = Math.round(performance.now() - execStarted);
        record.status = spec.kind === 'timeout' ? 'timed-out' : 'cancelled-running';
      } else {
        for (let round = 1; round <= (spec.rounds || 1); round++) {
          const start = performance.now();
          const typecheck =
            spec.template === 'react-ts'
              ? 'node_modules/typescript/bin/tsc'
              : 'node_modules/vue-tsc/bin/vue-tsc.js';
          const checked = await docker(['exec', name, 'node', typecheck, '--noEmit']);
          const built = await docker([
            'exec',
            name,
            'node',
            'node_modules/vite/bin/vite.js',
            'build',
            '--base=./',
          ]);
          const index = await readFile(join(directory, 'dist', 'index.html'), 'utf8');
          check(index.includes('<html'), 'Build did not produce HTML');
          await writeFile(
            join(runRoot, `${spec.id}-round-${round}.log`),
            checked.stdout + checked.stderr + built.stdout + built.stderr,
          );
          record.rounds.push({
            round,
            elapsedMs: Math.round(performance.now() - start),
            memory: await memory(name),
          });
          log('build-completed', { id: spec.id, ...record.rounds.at(-1) });
          if (round < (spec.rounds || 1))
            await appendFile(
              join(directory, 'src', 'style.css'),
              '\n/* prototype second edit */\n',
            );
        }
        record.memory = await memory(name);
        record.status = 'succeeded';
      }
    } catch (error) {
      record.status = 'failed';
      record.error = String(error.stderr || error.message).slice(-4000);
      log('job-failed', { id: spec.id, error: record.error });
    } finally {
      clearTimeout(forcedStop);
      // Release only after confirmed deletion. A failed deletion blocks every following task.
      try {
        await removeContainer(name);
      } catch (error) {
        blocked = true;
        record.cleanupError = String(error);
        // eslint-disable-next-line no-unsafe-finally -- 隔离容器清理失败必须覆盖任务结果并阻断队列，避免继续复用未清理资源。
        throw error;
      } finally {
        active--;
        record.elapsedMs = Math.round(performance.now() - started);
      }
      log('settled', { id: spec.id, status: record.status, elapsedMs: record.elapsedMs });
    }
  });
  tail = promise.catch((error) => {
    blocked = true;
    log('slot-blocked', { error: String(error) });
  });
  return {
    record,
    promise,
    cancel: () => {
      spec.cancelled = true;
    },
  };
}

await mkdir(runRoot, { recursive: true });
try {
  await docker(['image', 'inspect', image]); // Do not pull or build images implicitly.
  log('experiment-started', { runId, runRoot, slotLimit: 1 });
  const react = await prepareDependencies('react-ts');
  const vue = await prepareDependencies('vue-ts');
  const first = enqueue({ id: 'A', template: 'react-ts', dependencies: react, rounds: 2 });
  const second = enqueue({ id: 'B', template: 'vue-ts', dependencies: vue });
  const queuedCancel = enqueue({ id: 'C', template: 'react-ts', dependencies: react });
  queuedCancel.cancel();
  const timeout = enqueue({ id: 'D', template: 'react-ts', dependencies: react, kind: 'timeout' });
  const cancel = enqueue({ id: 'E', template: 'react-ts', dependencies: react, kind: 'cancel' });
  const recovery = enqueue({ id: 'F', template: 'react-ts', dependencies: react });
  await Promise.allSettled([
    first.promise,
    second.promise,
    queuedCancel.promise,
    timeout.promise,
    cancel.promise,
    recovery.promise,
  ]);
  const remaining = (
    await docker(['ps', '-aq', '--filter', `label=paimeng.prototype=${runId}`])
  ).stdout.trim();
  report.maxActive = maxActive;
  report.remainingContainers = remaining ? remaining.split('\n') : [];
  report.descendantsStarted =
    (await exists(join(runRoot, 'D', 'descendant-started'))) &&
    (await exists(join(runRoot, 'E', 'descendant-started')));
  report.descendantSurvived =
    (await exists(join(runRoot, 'D', 'descendant-survived'))) ||
    (await exists(join(runRoot, 'E', 'descendant-survived')));
  report.passed =
    maxActive === 1 &&
    !remaining &&
    report.descendantsStarted &&
    !report.descendantSurvived &&
    first.record.status === 'succeeded' &&
    first.record.rounds.length === 2 &&
    second.record.status === 'succeeded' &&
    queuedCancel.record.status === 'cancelled-before-start' &&
    !queuedCancel.record.container &&
    timeout.record.status === 'timed-out' &&
    cancel.record.status === 'cancelled-running' &&
    recovery.record.status === 'succeeded';
  log('experiment-finished', {
    passed: report.passed,
    maxActive,
    report: join(runRoot, 'report.json'),
  });
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.error = String(error.stderr || error.message).slice(-4000);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  for (const name of containers)
    await removeContainer(name).catch((error) => {
      report.cleanupError = String(error);
    });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`REPORT_PATH=${join(runRoot, 'report.json')}`);
}
