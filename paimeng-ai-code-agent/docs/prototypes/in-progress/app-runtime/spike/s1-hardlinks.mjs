#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S1：pnpm 共享 store 在「Workspace 与 store 分开 bind mount」时还能不能硬链接？
 *
 * 三种布局：
 *   naive       — store 与 workspace 两个挂载，virtual store 留在 workspace 默认位置
 *   workaround  — store 与 workspace 两个挂载，virtual store 放进 store 挂载
 *   same-mount  — workspace 与 store 在同一个父挂载下（对照，证明差异来自挂载边界）
 *
 * 另外验证：两个 App 并发安装、第二份依赖的增量磁盘、宿主 uid 删除。
 */

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(here, '..', 'evidence');
const work = join(process.env.SPIKE_WORK ?? '/tmp/app-runtime-spike-20261103', 's1');
const image = process.env.SPIKE_IMAGE ?? 'paimeng-app-runtime:1894779bd433';
const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const started = Date.now();
const containers = new Set();

const packageJson = {
  name: 'spike-app',
  private: true,
  type: 'module',
  dependencies: { react: '19.1.0', 'react-dom': '19.1.0' },
  devDependencies: { vite: '7.0.0', '@vitejs/plugin-react': '4.6.0', typescript: '5.9.3' },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function docker(args, options = {}) {
  return run('docker', args, options);
}

function container(name, mounts, extra = []) {
  docker(['rm', '-f', name], { allowFailure: true });
  containers.add(name);
  docker([
    'run', '-d', '--name', name,
    '--label', 'paimeng.spike=s1',
    '--user', `${uid}:${gid}`,
    '--pids-limit', '256', '--memory', '1g',
    ...mounts.flatMap(mount => ['--mount', `type=bind,src=${mount.source},dst=${mount.target}${mount.readonly ? ',readonly' : ''}`]),
    ...extra,
    '--entrypoint', 'sh', image, '-lc', 'while :; do sleep 3600; done',
  ]);
  return name;
}

function exec(name, command, options = {}) {
  const startedAt = Date.now();
  const workdir = options.workdir ?? '/work';
  const result = docker(['exec', '-e', 'HOME=/tmp', '-e', 'CI=1', '-w', workdir, name, 'sh', '-lc', command], options);
  return { ...result, durationMs: Date.now() - startedAt };
}

async function measure(name, roots, samples) {
  const args = ['exec', name, 'node', '/spike/measure.mjs', ...roots, ...samples];
  const result = docker(args);
  return JSON.parse(result.stdout);
}

async function install(name, virtualStore) {
  const command = [
    'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--reporter=append-only',
    '--store-dir=/store',
    ...(virtualStore ? [`--virtual-store-dir=${virtualStore}`] : []),
  ].join(' ');
  const result = exec(name, command);
  if (result.status !== 0) throw new Error(`install 失败：\n${result.stdout}\n${result.stderr}`);
  return { command, durationMs: result.durationMs, tail: result.stdout.trim().split('\n').slice(-8) };
}

async function prepareApp(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(packageJson, null, 2));
  await cp(join(work, 'lock', 'pnpm-lock.yaml'), join(directory, 'pnpm-lock.yaml'));
}

async function prepareStore(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

const measureScript = join(here, 'measure.mjs');
const mount = (source, target, readonly = false) => ({ source, target, readonly });
const commonMounts = (...items) => [...items, mount(measureScript, '/spike/measure.mjs', true)];

async function main() {
  await mkdir(join(work, 'lock'), { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(work, 'lock', 'package.json'), JSON.stringify(packageJson, null, 2));
  const lock = run('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--store-dir', join(work, 'host-store')], { cwd: join(work, 'lock') });
  if (lock.status !== 0) throw new Error(`生成锁文件失败\n${lock.stdout}\n${lock.stderr}`);
  const lockText = await readFile(join(work, 'lock', 'pnpm-lock.yaml'), 'utf8');
  const lockVersion = lockText.split('\n').find(line => line.startsWith('lockfileVersion:')) ?? 'unknown';

  const result = {
    generatedAt: new Date().toISOString(),
    environment: {
      image,
      imageId: docker(['image', 'inspect', '--format', '{{.Id}}', image]).stdout.trim(),
      node: docker(['run', '--rm', '--entrypoint', 'node', image, '-v']).stdout.trim(),
      pnpm: docker(['run', '--rm', '--entrypoint', 'pnpm', image, '-v']).stdout.trim(),
      docker: docker(['version', '--format', '{{.Server.Version}}']).stdout.trim(),
      kernel: run('uname', ['-r']).stdout.trim(),
      uid,
      gid,
      lockVersion,
      packageJson,
      durationBeforeLayoutsMs: Date.now() - started,
    },
    layouts: {},
  };

  // 0. 直接证明挂载边界：同一批宿主文件，跨挂载 link 失败，同挂载成功。
  {
    await prepareStore(join(work, 'probe-store'));
    await prepareApp(join(work, 'probe-app'));
    container('spike-s1-probe', commonMounts(mount(join(work, 'probe-app'), '/work'), mount(join(work, 'probe-store'), '/store')));
    const probe = exec('spike-s1-probe', 'echo hi > /store/p.txt; if ln /store/p.txt /work/p.txt 2>/tmp/e; then echo CROSS_MOUNT_LINK_OK; else echo "CROSS_MOUNT_LINK_FAIL: $(cat /tmp/e)"; fi');
    result.layouts.linkProbe = { output: probe.stdout.trim() };
  }

  // 1. naive：两个挂载，virtual store 在 /work/node_modules/.pnpm
  {
    await prepareStore(join(work, 'store-naive'));
    await prepareApp(join(work, 'app-naive'));
    container('spike-s1-naive', commonMounts(mount(join(work, 'app-naive'), '/work'), mount(join(work, 'store-naive'), '/store')));
    const installResult = await install('spike-s1-naive');
    const measurement = await measure(
      'spike-s1-naive',
      ['/store', '/work'],
      ['react=/work/node_modules/react/index.js', 'pnpm-dir=/work/node_modules/.pnpm'],
    );
    const modules = exec('spike-s1-naive', 'readlink node_modules/react; grep -E "virtualStoreDir|packageImportMethod|storeDir" node_modules/.modules.yaml || true; find node_modules/.pnpm -maxdepth 1 -mindepth 1 -type d | wc -l');
    result.layouts.naive = { install: installResult, measurement, modules: modules.stdout.trim().split('\n') };
  }

  // 2. workaround：两个挂载，virtual store 放进 /store/apps/<key>/.paimeng-virtual
  {
    await prepareStore(join(work, 'store-shared'));
    await prepareApp(join(work, 'app-a'));
    await prepareApp(join(work, 'app-b'));
    container('spike-s1-a', commonMounts(mount(join(work, 'app-a'), '/work'), mount(join(work, 'store-shared'), '/store')));
    const installA = await install('spike-s1-a', '/store/apps/a/.paimeng-virtual');
    const measureA = await measure(
      'spike-s1-a',
      ['/store', '/work'],
      ['react=/work/node_modules/react/index.js', 'virtual-a=/store/apps/a/.paimeng-virtual'],
    );
    const linksA = exec('spike-s1-a', 'readlink node_modules/react; grep -E "virtualStoreDir|packageImportMethod|storeDir" node_modules/.modules.yaml || true');
    container('spike-s1-b', commonMounts(mount(join(work, 'app-b'), '/work'), mount(join(work, 'store-shared'), '/store')));
    const installB = await install('spike-s1-b', '/store/apps/b/.paimeng-virtual');
    const measureB = await measure(
      'spike-s1-b',
      ['/store', '/work'],
      ['react=/work/node_modules/react/index.js', 'virtual-b=/store/apps/b/.paimeng-virtual'],
    );
    const share = exec('spike-s1-b', 'stat -c "%d %i %h %n" node_modules/react/index.js /store/apps/a/.paimeng-virtual/react@*/node_modules/react/index.js /store/apps/b/.paimeng-virtual/react@*/node_modules/react/index.js 2>&1 || true');
    result.layouts.workaround = {
      installA, installB, measureA, measureB,
      secondAppDelta: {
        storeBlocks: measureB.roots[0].uniqueBlocks - measureA.roots[0].uniqueBlocks,
        unionBlocks: measureB.union.uniqueBlocks - measureA.union.uniqueBlocks,
      },
      symlinks: linksA.stdout.trim().split('\n'),
      sharedInodes: share.stdout.trim().split('\n'),
    };
  }

  // 3. same-mount 对照：一个父挂载里同时有 workspace 与 store
  {
    await prepareStore(join(work, 'same', 'store'));
    await prepareApp(join(work, 'same', 'work'));
    container('spike-s1-same', commonMounts(mount(join(work, 'same'), '/srv')), []);
    const installResult = await exec('spike-s1-same', 'pnpm install --frozen-lockfile --ignore-scripts --reporter=append-only --store-dir=/srv/store', { workdir: '/srv/work' });
    if (installResult.status !== 0) throw new Error(`same-mount install 失败\n${installResult.stdout}\n${installResult.stderr}`);
    const measurement = await measure(
      'spike-s1-same',
      ['/srv/store', '/srv/work'],
      ['react=/srv/work/node_modules/react/index.js'],
    );
    result.layouts.sameMount = { install: { durationMs: installResult.durationMs, command: 'pnpm install --store-dir=/srv/store' }, measurement };
  }

  // 4. 并发安装：两个 App 同时往同一个 store 装同一批依赖
  {
    await prepareStore(join(work, 'store-concurrent'));
    await prepareApp(join(work, 'conc-a'));
    await prepareApp(join(work, 'conc-b'));
    container('spike-s1-conc-a', commonMounts(mount(join(work, 'conc-a'), '/work'), mount(join(work, 'store-concurrent'), '/store')));
    container('spike-s1-conc-b', commonMounts(mount(join(work, 'conc-b'), '/work'), mount(join(work, 'store-concurrent'), '/store')));
    const spawnInstall = (name, key) => new Promise(resolvePromise => {
      const at = Date.now();
      const child = spawn('docker', ['exec', '-e', 'HOME=/tmp', '-e', 'CI=1', '-w', '/work', name, 'sh', '-lc',
        `pnpm install --frozen-lockfile --ignore-scripts --reporter=append-only --store-dir=/store --virtual-store-dir=/store/apps/${key}/.paimeng-virtual`]);
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('close', code => resolvePromise({ name, code, durationMs: Date.now() - at, tail: output.trim().split('\n').slice(-6) }));
    });
    const concurrent = await Promise.all([spawnInstall('spike-s1-conc-a', 'a'), spawnInstall('spike-s1-conc-b', 'b')]);
    const measurement = await measure('spike-s1-conc-a', ['/store', '/work'], []);
    const other = await measure('spike-s1-conc-b', ['/store', '/work'], []);
    result.layouts.concurrent = { runs: concurrent, measureA: measurement, measureB: other };
  }

  // 5. 宿主 uid 写出的文件，宿主用户能直接删除
  {
    exec('spike-s1-a', 'mkdir -p host-owner && echo made-by-container > host-owner/file.txt');
    const statOut = exec('spike-s1-a', 'stat -c "%u:%g %n" host-owner/file.txt').stdout.trim();
    let removed = true;
    try { await rm(join(work, 'app-a', 'host-owner'), { recursive: true }); } catch { removed = false; }
    result.layouts.ownership = { stat: statOut, removedByHost: removed };
  }

  await writeFile(join(evidenceDir, 's1.json'), JSON.stringify(result, null, 2));
  const summary = [
    '# S1 结果：pnpm store 与 Workspace 的挂载边界',
    '',
    `- 镜像：\`${result.environment.image}\`（\`${result.environment.imageId.slice(0, 19)}\`），pnpm ${result.environment.pnpm}，Node ${result.environment.node}`,
    `- 锁文件：${lockVersion}`,
    `- 跨挂载 link：${result.layouts.linkProbe.output}`,
    '',
    '| 布局 | 安装耗时 | store 分配 | workspace 分配 | 合并分配 | 硬链接文件 | 最大 nlink |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...[
      ['naive', result.layouts.naive.measurement],
      ['workaround A', result.layouts.workaround.measureA],
      ['workaround A+B', result.layouts.workaround.measureB],
      ['same-mount', result.layouts.sameMount.measurement],
    ].map(([label, value]) => {
      const store = value.roots[0];
      const workspace = value.roots[1];
      return `| ${label} | — | ${(store.uniqueBlocks / 1024 / 1024).toFixed(1)} MiB | ${(workspace.uniqueBlocks / 1024 / 1024).toFixed(1)} MiB | ${(value.union.uniqueBlocks / 1024 / 1024).toFixed(1)} MiB | ${workspace.hardlinked} | ${workspace.maxNlink} |`;
    }),
    '',
    `第二份 App 追加 store 分配：${(result.layouts.workaround.secondAppDelta.storeBlocks / 1024 / 1024).toFixed(2)} MiB；合并分配增量：${(result.layouts.workaround.secondAppDelta.unionBlocks / 1024 / 1024).toFixed(2)} MiB。`,
    '',
  ].join('\n');
  await writeFile(join(evidenceDir, 's1-summary.md'), summary + '\n');
  console.log(summary);
  console.log(JSON.stringify({
    naive: result.layouts.naive.measurement.samples,
    workaroundA: result.layouts.workaround.measureA.samples,
    sharedInodes: result.layouts.workaround.sharedInodes,
    concurrent: result.layouts.concurrent.runs,
    ownership: result.layouts.ownership,
  }, null, 2));
}

try {
  await main();
} finally {
  for (const name of containers) docker(['rm', '-f', name], { allowFailure: true });
}
