import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';

export type AgentModelSlot = 'fixture' | 'codegen.default';

type AgentModelResolver = (slot: AgentModelSlot) => Promise<LanguageModelV4>;

let resolve: AgentModelResolver | null = null;

/**
 * 由 step 侧在模块加载时安装。workflow VM 里没有解析器，也不需要解析：
 * 跨边界只带槽位，实例在 step 进程内重建时才会用到它。
 */
export function setAgentModelResolver(resolver: AgentModelResolver) {
  resolve = resolver;
}

/**
 * 模型实例不能作为 step 参数穿过边界：序列化只保留字符串、数字、布尔，
 * 函数（baseURL 的 url、fetch、headers）会被过滤掉（官方 custom providers 文档）。
 * 本模块不依赖 infra 与 models，否则会连同 pg 一起被编进 workflow VM。
 */
export class AgentModelRef implements LanguageModelV4 {
  static [WORKFLOW_SERIALIZE](model: AgentModelRef) {
    return { slot: model.slot };
  }

  static [WORKFLOW_DESERIALIZE](data: { slot: AgentModelSlot }) {
    return new AgentModelRef(data.slot);
  }

  readonly specificationVersion = 'v4' as const;
  readonly provider = 'paimeng';
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  private resolved?: Promise<LanguageModelV4>;

  constructor(readonly slot: AgentModelSlot) {
    this.modelId = slot;
  }

  private async resolveModel(): Promise<LanguageModelV4> {
    if (!resolve) throw new Error('模型解析器未安装，AgentModelRef 只能在 step 进程内解析');
    this.resolved ??= resolve(this.slot);
    return this.resolved;
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    return (await this.resolveModel()).doGenerate(options);
  }

  async doStream(options: LanguageModelV4CallOptions) {
    return (await this.resolveModel()).doStream(options);
  }
}
