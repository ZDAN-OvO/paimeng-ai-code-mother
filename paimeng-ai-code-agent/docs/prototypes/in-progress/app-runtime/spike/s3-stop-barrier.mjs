#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S3：Generation 收束时，shell 留下的后台进程能不能在提交源码之前真正停住？
 *
 * 每个场景用独立的文件，避免上一个场景的迟到写入污染下一个结论。
 * 关键对照：
 *   detached            — 命令 setsid + 重定向 stdio，docker exec 立即返回
 *   wrapper             — 现有 setsid + 进程组看门狗，命令正常返回
 *   wrapper + barrier   — 返回后枚举 /proc，冻结 dev server，杀非白名单
 *   pipe                — 后台进程继承 stdout，docker exec 被管道拖住
 *   timeout             — 看门狗按进程组 TERM/KILL
 *   term-ignore         — 忽略 TERM，必须 KILL
 *   freeze              — 冻结 dev server 时心跳不变，CONT 后恢复
 *   docker kill/start   — 整容器停止/重启的代价
 */

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(here, '..', 'evidence');
const work = join(process.env.SPIKE_WORK ?? '/tmp/app-runtime-spike-20261103', 's3');
const image = process.env.SPIKE_IMAGE ?? 'paimeng-app-runtime:1894779bd433';
const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const name = 'spike-s3';
const initName = 'spike-s3-init';
const noInitName = 'spike-s3-noinit';
const containers = new Set([name, initName, noInitName]);

const sleep = ms => new Promise(done => setTimeout(done, ms));
let currentDevPid = 0;
let scenarioNumber = 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function docker(args, options = {}) {
  const result = run('docker', args, options);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker ${args.join(' ')} 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function exec(name, command, options = {}) {
  return docker(['exec', '-e', 'HOME=/tmp', '-w', '/work', name, 'sh', '-lc', command], options);
}

function createContainer(containerName, { init = false } = {}) {
  docker(['rm', '-f', containerName], { allowFailure: true });
  docker([
    'run', '-d', '--name', containerName,
    '--label', 'paimeng.spike=s3',
    ...(init ? ['--init'] : []),
    '--user', `${uid}:${gid}`,
    '--pids-limit', '256', '--memory', '512m',
    '--mount', `type=bind,src=${join(work, 'workspace')},dst=/work`,
    '--mount', `type=bind,src=${here},dst=/spike,readonly`,
    '--entrypoint', 'sleep', image, '3600',
  ]);
}

async function startDev() {
  docker(['exec', '-d', '-e', 'HOME=/tmp', name, 'sh', '-c', 'echo $$ > /tmp/dev.pid; exec node /spike/s3-dev-server.mjs']);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ping = exec(name, 'node -e "fetch(\'http://127.0.0.1:5173/ping\').then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))"', { allowFailure: true });
    if (ping.status === 0 && ping.stdout.includes('pong')) break;
    await sleep(100);
  }
  const pid = Number(exec(name, 'cat /tmp/dev.pid').stdout.trim());
  currentDevPid = pid;
  const ping = exec(name, 'node -e "fetch(\'http://127.0.0.1:5173/ping\').then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(e);process.exit(1)})"');
  return { pid, ping: ping.stdout.trim() };
}

function barrier({ freeze = false, graceMs = 800, devPid = currentDevPid, file = '/work/late.log' } = {}) {
  const args = ['exec', name, 'node', '/spike/s3-barrier.mjs', '--grace', String(graceMs), '--wait', '4000', '--file', file];
  if (devPid) args.push('--dev', String(devPid));
  if (freeze) args.push('--freeze');
  const result = docker(args);
  return JSON.parse(result.stdout);
}

async function readText(file) {
  try { return await readFile(join(work, 'workspace', file.replace('/work/', '')), 'utf8'); } catch { return ''; }
}

async function reset(devPid = currentDevPid, file = '/work/late.log') {
  barrier({ devPid, file });
  await rm(join(work, 'workspace', file.replace('/work/', '')), { force: true });
  await sleep(120);
}

const wrapperSource = [
  `setsid sh -c 'echo $$ > "$1"; exec sh -lc "$2"' paimeng-shell "$1" "$2" &`,
  'child=$!',
  '(',
  '  remaining=$(( $3 * 2 ))',
  '  while [ "$remaining" -gt 0 ]; do',
  '    kill -0 "$child" 2>/dev/null || exit 0',
  '    sleep 0.5',
  '    remaining=$(( remaining - 1 ))',
  '  done',
  '  : > "$1.timedout"',
  '  pid=$(cat "$1" 2>/dev/null)',
  '  [ -n "$pid" ] && kill -TERM -"$pid" 2>/dev/null',
  '  sleep 1',
  '  [ -n "$pid" ] && kill -KILL -"$pid" 2>/dev/null',
  ') &',
  'watchdog=$!',
  'wait "$child"',
  'code=$?',
  'kill "$watchdog" 2>/dev/null',
  'exit "$code"',
].join('\n');

function wrapper(command, timeoutSeconds = 5) {
  const startedAt = Date.now();
  const result = docker(['exec', '-e', 'HOME=/tmp', '-w', '/work', name, 'sh', '-c', wrapperSource, 'paimeng-shell', `/tmp/spike-shell-${Date.now()}.pid`, command, String(timeoutSeconds)], { allowFailure: true });
  return { ...result, durationMs: Date.now() - startedAt };
}

function zombieCount(containerName) {
  const script = "const fs=require('fs');let z=0;for(const d of fs.readdirSync('/proc')){if(!/^\\d+$/.test(d))continue;try{const s=fs.readFileSync('/proc/'+d+'/stat','utf8');if(/^\\d+ \\(.+\\) Z /.test(s))z++}catch{}}console.log(z)";
  return Number(exec(containerName, `node -e "${script.replaceAll('"', '\\"')}"`, { allowFailure: true }).stdout.trim() || 0);
}

async function scenario(label, { mode, commandTemplate, waitMs = 2600, freeze = false, timeoutSeconds = 5 }) {
  scenarioNumber += 1;
  const file = `/work/s${scenarioNumber}-${label.replace(/[^\w\u4e00-\u9fa5]+/g, '-').slice(0, 24)}.log`;
  const command = commandTemplate.replaceAll('{file}', file);
  await reset(currentDevPid, file);
  const startedAt = Date.now();
  let barrierResult = null;
  let wrapperReturn = null;
  if (mode === 'detached' || mode === 'wrapper' || mode === 'wrapper+barrier' || mode === 'daemon+barrier') {
    if (mode === 'detached') exec(name, command, { allowFailure: true });
    else if (mode === 'daemon+barrier') {
      wrapperReturn = wrapper(command, timeoutSeconds);
      await sleep(300);
      barrierResult = barrier({ devPid: currentDevPid, file, freeze });
    } else if (mode === 'wrapper') {
      wrapperReturn = wrapper(command, timeoutSeconds);
    } else {
      wrapperReturn = wrapper(command, timeoutSeconds);
      await sleep(300);
      barrierResult = barrier({ devPid: currentDevPid, file, freeze });
    }
  }
  const afterBarrier = barrierResult ? await readText(file) : '';
  await sleep(waitMs);
  const late = await readText(file);
  return {
    label, mode, command, file, late, leaked: late.includes('leak'),
    afterBarrier,
    stableAfterBarrier: barrierResult ? afterBarrier === late : null,
    wrapperReturnMs: wrapperReturn?.durationMs ?? null,
    barrier: barrierResult,
    durationMs: Date.now() - startedAt,
  };
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, 'workspace'), { recursive: true });
  await writeFile(join(work, 'workspace', 'seed.txt'), 'seed\n');
  createContainer(name);
  const dev = await startDev();
  const result = {
    generatedAt: new Date().toISOString(),
    environment: {
      image,
      imageId: docker(['image', 'inspect', '--format', '{{.Id}}', image]).stdout.trim(),
      node: exec(name, 'node -v').stdout.trim(),
      pnpm: exec(name, 'pnpm -v').stdout.trim(),
      docker: docker(['version', '--format', '{{.Server.Version}}']).stdout.trim(),
      uid, gid,
      devPid: dev.pid,
      devPing: dev.ping,
      wrapperSource: 'src/server/app-runtime/shell.ts#runtimeShellScript（远端 agent/app-runtime-136-144）',
    },
    scenarios: [],
  };

  const detached = 'setsid sh -c "sleep 1.5; echo leak-$RANDOM >> {file}" >/dev/null 2>&1 & echo started';
  const pipe = 'sh -c "(sleep 1.5; echo leak-pipe >> {file}) & echo started"';

  result.scenarios.push(await scenario('detached 后台写者，无屏障', { mode: 'detached', commandTemplate: detached }));
  result.scenarios.push(await scenario('现有 wrapper，detached 后台写者，无屏障', { mode: 'wrapper', commandTemplate: detached }));
  result.scenarios.push(await scenario('现有 wrapper + 轮末屏障，detached', { mode: 'wrapper+barrier', commandTemplate: detached }));
  result.scenarios.push(await scenario('现有 wrapper，后台进程继承 stdout', { mode: 'wrapper', commandTemplate: pipe }));
  result.scenarios.push(await scenario('现有 wrapper，后台进程继承 stdout + 2s 超时', { mode: 'wrapper', commandTemplate: 'sh -c "(sleep 20; echo leak-timeout >> {file}) & echo started"', timeoutSeconds: 2, waitMs: 1200 }));
  result.scenarios.push(await scenario('双 fork daemon + 屏障', { mode: 'daemon+barrier', commandTemplate: 'node /spike/s3-spawn-daemon.mjs {file}' }));
  result.scenarios.push(await scenario('忽略 TERM + 屏障', {
    mode: 'wrapper+barrier',
    commandTemplate: 'setsid sh -c "trap \'\' TERM; sleep 1.5; echo leak-term >> {file}" >/dev/null 2>&1 & echo started',
  }));
  result.scenarios.push(await scenario('50 个 detached 写者 + 屏障', {
    mode: 'wrapper+barrier',
    commandTemplate: 'i=0; while [ $i -lt 50 ]; do setsid sh -c "sleep 1.5; echo leak-$i >> {file}" >/dev/null 2>&1 & i=$((i+1)); done; echo started',
  }));
  result.scenarios.push(await scenario('连续写入进程 + 屏障', {
    mode: 'wrapper+barrier',
    commandTemplate: 'setsid sh -c "i=0; while :; do echo leak-loop-$i >> {file}; i=$((i+1)); sleep 0.01; done" >/dev/null 2>&1 & echo started',
    waitMs: 1200,
  }));

  // 冻结 dev server：心跳在 barrier 的 600ms 冻结窗口内不应变化
  const freeze = await scenario('冻结 dev server + 屏障', {
    mode: 'wrapper+barrier',
    commandTemplate: detached,
    freeze: true,
  });
  const heartbeatAfter = await readText('/work/dev-heartbeat.txt');
  await sleep(700);
  const heartbeatLater = await readText('/work/dev-heartbeat.txt');
  const pingAfter = exec(name, 'node -e "fetch(\'http://127.0.0.1:5173/ping\').then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(e);process.exit(1)})"', { allowFailure: true });
  freeze.heartbeatAfter = heartbeatAfter;
  freeze.heartbeatLater = heartbeatLater;
  freeze.resumedWrites = heartbeatAfter !== heartbeatLater;
  freeze.pingAfter = { status: pingAfter.status, stdout: pingAfter.stdout.trim() };
  result.scenarios.push(freeze);

  // 整容器 kill/start：最强但会丢失 dev server
  await reset(currentDevPid, '/work/kill-test.log');
  exec(name, 'setsid sh -c "sleep 1.5; echo leak-kill >> /work/kill-test.log" >/dev/null 2>&1 & echo started');
  const killAt = Date.now();
  docker(['kill', name]);
  const killedMs = Date.now() - killAt;
  const startAt = Date.now();
  docker(['start', name]);
  const startedMs = Date.now() - startAt;
  await sleep(2000);
  const lateAfterKill = await readText('/work/kill-test.log');
  const devAfterRestart = exec(name, 'node -e "fetch(\'http://127.0.0.1:5173/ping\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"', { allowFailure: true });
  result.containerKill = {
    killMs: killedMs, startMs: startedMs, late: lateAfterKill, leaked: lateAfterKill.includes('leak'),
    devAlive: devAfterRestart.status === 0,
  };
  currentDevPid = 0;

  // 僵尸：两个全新容器，一个普通 PID 1，一个 docker --init
  for (const [containerName, init] of [[noInitName, false], [initName, true]]) {
    createContainer(containerName, { init });
    exec(containerName, 'i=0; while [ $i -lt 20 ]; do setsid sh -c "sleep 30" >/dev/null 2>&1 & i=$((i+1)); done; echo spawned');
    await sleep(200);
    docker(['exec', containerName, 'node', '/spike/s3-barrier.mjs', '--grace', '300', '--wait', '2000'], { allowFailure: true });
    if (init) result.zombies = { ...(result.zombies ?? {}), withInit: zombieCount(containerName) };
    else result.zombies = { ...(result.zombies ?? {}), withoutInit: zombieCount(containerName) };
  }

  await writeFile(join(evidenceDir, 's3.json'), JSON.stringify(result, null, 2));
  const lines = [
    '# S3 结果：shell 后台写入与轮末停止屏障',
    '',
    `- 镜像：\`${result.environment.image}\`，Node ${result.environment.node}，pnpm ${result.environment.pnpm}`,
    `- 假 dev server PID：${result.environment.devPid}（${result.environment.devPing}）`,
    '',
    '| 场景 | 结果 | 屏障后稳定 | wrapper 返回 | 屏障耗时 | 剩余进程 | 僵尸 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...result.scenarios.map(item => `| ${item.label} | ${item.leaked ? '**仍然迟到写入**' : '无迟到写入'} | ${item.stableAfterBarrier === null ? '—' : item.stableAfterBarrier ? '是' : '**否**'} | ${item.wrapperReturnMs ?? '—'} ms | ${item.barrier ? `${item.barrier.durationMs} ms` : '—'} | ${item.barrier ? item.barrier.remaining.length : '—'} | ${item.barrier ? item.barrier.zombieCount : '—'} |`),
    '',
    `- 冻结 dev server：心跳在冻结窗口内不变=${freeze.barrier?.heartbeatUnchangedWhileFrozen}；CONT 后恢复写入=${freeze.resumedWrites}；ping=${JSON.stringify(freeze.pingAfter)}`,
    `- 僵尸：无 init=${result.zombies.withoutInit}；有 init=${result.zombies.withInit}`,
    `- 整容器 kill/start：kill ${result.containerKill.killMs} ms，start ${result.containerKill.startMs} ms；迟到写入=${result.containerKill.leaked}；dev server 自动恢复=${result.containerKill.devAlive}`,
    '',
  ];
  await writeFile(join(evidenceDir, 's3-summary.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

try {
  await main();
} finally {
  for (const containerName of containers) docker(['rm', '-f', containerName], { allowFailure: true });
}
