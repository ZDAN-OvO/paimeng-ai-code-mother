import 'server-only';
import { docker } from './container';

/**
 * 在 App runtime 里执行一条命令。
 *
 * 返回体按 UTF-8 字节截断（默认 8 KiB）：命令的输出可能是一整个安装日志，直接塞进模型上下文
 * 或界面会把真正有用的诊断挤掉。完整输出留在容器内的日志里，截断只作用于返回值。
 */

export type CommandResult = {
  exitCode: number;
  timedOut: boolean;
  output: string;
  truncated: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** 按字节截断，不把一个多字节字符劈成两半；返回截断后的文本与实际长度。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  for (;;) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
      if (end <= 0) return { text: '', truncated: true };
    }
  }
}

export async function runInRuntime(input: {
  container: string;
  command: readonly string[];
  timeoutMs: number;
  outputBytes?: number;
  workdir?: string;
}): Promise<CommandResult> {
  const args = ['exec'];
  if (input.workdir) args.push('-w', input.workdir);
  args.push(input.container, ...input.command);
  const limit = input.outputBytes ?? 8192;
  try {
    const output = await docker(args, input.timeoutMs);
    const truncated = truncateUtf8(output, limit);
    return { exitCode: 0, timedOut: false, output: truncated.text, truncated: truncated.truncated };
  } catch (error) {
    const detail = (error as Error).message;
    const truncated = truncateUtf8(detail, limit);
    const timedOut = /timed? ?out|ETIMEDOUT/i.test(detail);
    return {
      exitCode: timedOut ? 124 : 1,
      timedOut,
      output: truncated.text,
      truncated: truncated.truncated,
    };
  }
}

/** 后台启动一条长命令（dev server）：`docker exec -d` 立即返回，就绪由 supervisor 探测。 */
export async function startDetached(input: {
  container: string;
  script: string;
  workdir?: string;
}): Promise<void> {
  const args = ['exec', '-d'];
  if (input.workdir) args.push('-w', input.workdir);
  args.push(input.container, 'sh', '-c', input.script);
  await docker(args, 30_000);
}
