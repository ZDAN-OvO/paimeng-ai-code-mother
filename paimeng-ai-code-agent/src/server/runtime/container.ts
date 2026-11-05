import 'server-only';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RUNTIME_APP_LABEL, RUNTIME_MANAGED_LABEL, RUNTIME_RUN_LABEL } from './plan';

const run = promisify(execFile);

export const DEFAULT_DOCKER_TIMEOUT = 60_000;

/**
 * Docker CLI 的唯一入口。上层只描述「要什么」，不拼 `docker` 命令。
 *
 * 这里刻意不引 supervisor：container 只负责进程边界，槽位、台账和策略都在 supervisor。
 * 失败一律带上 stderr 的尾部，避免只留下「命令失败」这种无法诊断的错误。
 */
export async function docker(args: string[], timeout = DEFAULT_DOCKER_TIMEOUT): Promise<string> {
  try {
    const result = await run('docker', args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return (result.stdout ?? '').trim();
  } catch (error) {
    const detail =
      (error as { stderr?: string }).stderr?.trim() ||
      (error as { stdout?: string }).stdout?.trim() ||
      (error as Error).message;
    throw new Error(`docker ${args[0]} 失败：${detail.slice(-1200)}`);
  }
}

/** Docker 守护进程是否可用：初始化与测试据此给出可读结论，而不是一串 CLI 错误。 */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(['version', '--format', '{{.Server.Version}}'], 10_000);
    return true;
  } catch {
    return false;
  }
}

export async function imageExists(tag: string): Promise<boolean> {
  try {
    await docker(['image', 'inspect', tag], 20_000);
    return true;
  } catch {
    return false;
  }
}

export async function imageId(tag: string): Promise<string> {
  return docker(['image', 'inspect', '--format', '{{.Id}}', tag], 20_000);
}

/**
 * 构建运行时镜像。构建参数而不是内联 Dockerfile：镜像内容必须是仓库里可审的那一份。
 */
export async function buildImage(input: {
  tag: string;
  context: string;
  dockerfile: string;
  buildArgs: readonly string[];
  timeoutMs: number;
}): Promise<void> {
  await docker(
    ['build', '-t', input.tag, '-f', input.dockerfile, ...input.buildArgs, input.context],
    input.timeoutMs,
  );
}

export type ContainerState = { running: boolean; id: string | null; port: number | null };

/** 容器名或 id 都接受；不存在返回 not running，不抛错。 */
export async function containerState(ref: string, devPort: number): Promise<ContainerState> {
  try {
    const id = await docker(['inspect', '--format', '{{.Id}}', ref], 20_000);
    if (!id) return { running: false, id: null, port: null };
    const running = (await docker(['inspect', '--format', '{{.State.Running}}', ref], 20_000)) === 'true';
    const published = running ? await docker(['port', ref, `${devPort}/tcp`], 20_000).catch(() => '') : '';
    const match = /:(\d+)\s*$/.exec(published);
    return { running, id, port: match ? Number(match[1]) : null };
  } catch {
    return { running: false, id: null, port: null };
  }
}

export async function removeContainer(ref: string): Promise<void> {
  await docker(['rm', '-f', ref], 30_000).catch(() => undefined);
}

/** 必须成功才释放槽位的删除：容量回收只有在容器真的没了之后才能把行标成 stopped。 */
export async function removeContainerStrict(ref: string): Promise<void> {
  await docker(['rm', '-f', ref], 30_000);
}

export type ManagedContainer = { id: string; name: string; appKey: string | null; running: boolean };

/**
 * 按平台标签列出本平台管理的容器。supervisor 重启、或台账与 Docker 不一致时，
 * 只认标签，不按名字前缀猜——别的工具起的容器不能算进来。
 */
export async function listManagedContainers(runId: string): Promise<ManagedContainer[]> {
  const output = await docker(
    [
      'ps',
      '-a',
      '--filter',
      `label=${RUNTIME_MANAGED_LABEL}=paimeng-platform`,
      '--filter',
      `label=${RUNTIME_RUN_LABEL}=${runId}`,
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Labels}}',
    ],
    20_000,
  );
  // 测试与脚本会自己起容器；在没有 Docker 的环境里这里返回空，而不是让调用方崩掉。
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, name, state = '', labels = ''] = line.split('\t');
      const appLabel = labels
        .split(',')
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${RUNTIME_APP_LABEL}=`));
      return {
        id,
        name,
        appKey: appLabel ? appLabel.slice(RUNTIME_APP_LABEL.length + 1) : null,
        running: state === 'running',
      };
    });
}
