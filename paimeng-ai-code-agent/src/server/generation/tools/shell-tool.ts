import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ConversationId, type ToolRegistration } from '@earendil-works/pi-durable';
import { getConfig } from '../../infra/config';
import { readAppRuntime } from '../../app-runtime/store';
import { runRuntimeShell } from '../../app-runtime/shell';
import type { AppRef } from './app-ref';

/**
 * 模型在 App runtime 里执行命令的唯一入口。文件工具仍在宿主上写 Workspace；
 * 这条工具只负责「在同一个容器里跑工程自己的命令」（安装依赖、跑检查、看目录）。
 *
 * 写权限与终止边界和文件工具一致：harness 的 effect gate 在执行前检查这次执行是否仍能写，
 * 超时/取消由执行器按进程组终止。输出截断后返回，完整输出留在运行时日志。
 */
export function createShellTool(deps: { appRefFor: (conversationId: ConversationId) => Promise<AppRef | undefined> }): ToolRegistration {
  return defineTool({
    name: 'shell',
    description: '在你的 App runtime 容器里执行一条 shell 命令，工作目录就是应用工程根 /work（持久 Workspace，node_modules 也在里面）。用来安装依赖（pnpm add 包名@版本）、跑工程检查或查看目录。网络是开放的；依赖只能来自 npm registry 的包名与版本范围，git:/file:/link:/http(s):/workspace: 与 .npmrc 会被平台拒绝。工作区和容器里都没有 .git，版本历史由平台负责。优先复用模板里已有的组件、布局和设计令牌，不要重写设计系统。命令默认 120 秒超时，返回的输出会截断，完整输出留在运行时日志。',
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 4000 }) }),
    replay: 'unsafe',
    execute: async (args, api, context) => {
      const app = await deps.appRefFor(api.conversationId);
      if (!app) throw new Error(`会话 ${api.conversationId} 没有关联应用，拒绝执行命令`);
      const runtime = await readAppRuntime(app);
      if (!runtime || runtime.status !== 'ready' || !runtime.containerId) {
        throw new Error('App runtime 还没有就绪，现在不能执行命令。先把需求写成文件；需要预览时调用 buildPreview。');
      }
      const config = getConfig();
      const result = await runRuntimeShell({ app, command: args.command, signal: context.abortSignal });
      const header = result.cancelled
        ? '命令已取消：这一轮已停止，进程组已终止。'
        : result.timedOut
          ? `命令超时（${Math.round(config.appRuntime.shell.timeoutMs / 1000)} 秒），已按进程组终止，没有继续修改源码的进程。`
          : `退出码 ${result.exitCode}`;
      const body = result.output.trimEnd();
      const truncatedNote = result.truncated ? `\n…输出已截断（完整输出留在运行时日志，${Buffer.byteLength(result.output, 'utf8')} 字节）` : '';
      const text = [`${header}${result.cancelled || result.timedOut || result.exitCode !== 0 ? '（命令失败）' : ''}`, body, truncatedNote]
        .filter(part => part.length > 0)
        .join('\n');
      return {
        output: [{ type: 'text', text }],
        details: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          truncated: result.truncated,
          logPath: result.logPath,
          durationMs: result.durationMs,
        },
      };
    },
  });
}
