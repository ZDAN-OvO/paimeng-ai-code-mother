import { describe, expect, it } from 'vitest';
import { runtimeShellExecArgs, truncateShellOutput } from '@/server/app-runtime/shell';

const app = { id: '123456789012345678', codeGenType: 'react_project' as const };

describe('App runtime shell 的纯策略', () => {
  it('命令在 /work 里执行，不注入平台环境变量', () => {
    const args = runtimeShellExecArgs({ app, command: 'pnpm add dayjs', timeoutMs: 120_000, pidFile: '/tmp/.paimeng-shell-test.pid' });
    expect(args.slice(0, 5)).toEqual(['exec', '-w', '/work', 'paimeng-app-runtime-react_project_123456789012345678', 'sh']);
    expect(args).not.toContain('--env');
    expect(args.join(' ')).not.toMatch(/DATABASE_URL|REDIS_URL|AI_API_KEY/);
    // 命令本身以位置参数传入，不拼进脚本，避免引号逃逸。
    expect(args.at(-3)).toBe('/tmp/.paimeng-shell-test.pid');
    expect(args.at(-2)).toBe('pnpm add dayjs');
    expect(args.at(-1)).toBe('120');
  });

  it('包装脚本把命令放进独立会话，超时按进程组终止并留下超时标记', () => {
    const args = runtimeShellExecArgs({ app, command: 'true', timeoutMs: 2_000, pidFile: '/tmp/p.pid' });
    const script = args[6];
    expect(script).toContain('setsid');
    expect(script).toContain('echo $$ > "$1"');
    expect(script).toContain('kill -TERM -"$pid"');
    expect(script).toContain('kill -KILL -"$pid"');
    expect(script).toContain('.timedout');
  });

  it('输出按字节截断，保留最后一段并标记截断', () => {
    expect(truncateShellOutput('short', 8192)).toEqual({ text: 'short', truncated: false });
    const long = 'a'.repeat(10_000) + 'tail';
    const cut = truncateShellOutput(long, 64);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.text, 'utf8')).toBeLessThanOrEqual(64);
    expect(cut.text.endsWith('tail')).toBe(true);
  });
});
