import type { Model } from '@/shared/api/schemas';

export const MODELS: Model[] = [
  {
    id: 'local/qwen3-coder-30b',
    name: 'Qwen3 Coder 30B',
    provider: '本地网关',
    note: '本地 · 零成本',
  },
  {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    note: '前端质量最好',
  },
  { id: 'openai/gpt-5.2', name: 'GPT-5.2', provider: 'OpenAI', note: '长上下文' },
  { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', provider: 'DeepSeek', note: '便宜、快' },
];

export const MODEL_FALLBACK = MODELS[0].id;
