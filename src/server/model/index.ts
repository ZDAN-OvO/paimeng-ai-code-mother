import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/** 仅在服务端解析模型配置；密钥不进入项目、浏览器或 API 响应。 */
export function createConfiguredModel(
  environment: Record<string, string | undefined> = process.env,
  requestedModelId?: string,
) {
  const modelId = requestedModelId?.trim() || environment.AI_MODEL?.trim();
  if (!modelId) throw new Error('AI_MODEL 未设置，请在本地环境配置模型名称');
  const provider = createOpenAICompatible({
    name: 'configured',
    baseURL: environment.AI_BASE_URL?.trim() || 'https://api.openai.com/v1',
    apiKey: environment.AI_API_KEY,
  });
  return provider.chatModel(modelId);
}
