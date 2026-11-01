import { describe, expect, it } from 'vitest';
import {
  providerModelIdSchema,
  providerModelInputSchema,
  providerModelUpdateSchema,
} from '@/shared/model-config';

const capabilities = { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false };

describe('提供商模型契约', () => {
  it('模型 ID 只接受非零的十进制字符串，并限制在 BIGINT 范围内', () => {
    expect(providerModelIdSchema.parse('1')).toBe('1');
    expect(providerModelIdSchema.parse('9223372036854775807')).toBe('9223372036854775807');
    for (const invalid of ['0', '01', '-1', '1.5', '', '9223372036854775808']) {
      expect(providerModelIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('登记要求显式能力，兼容声明缺省为关闭且不影响请求名原样保存', () => {
    const parsed = providerModelInputSchema.parse({
      providerId: 'primary',
      upstreamModelName: 'Same-Model',
      displayName: '同名模型',
      capabilities,
      enabled: true,
    });
    expect(parsed).toEqual({
      providerId: 'primary',
      upstreamModelName: 'Same-Model',
      displayName: '同名模型',
      capabilities,
      compatibility: { reasoningContentPassthrough: false },
      enabled: true,
    });
    expect(providerModelInputSchema.safeParse({ providerId: 'primary', upstreamModelName: 'm', displayName: 'm', enabled: true }).success).toBe(false);
  });

  it('更新不能改提供商或请求名，未知字段被拒绝', () => {
    const update = {
      displayName: '新展示名',
      capabilities: { ...capabilities, imageInput: true },
      compatibility: { reasoningContentPassthrough: true },
      enabled: false,
    };
    expect(providerModelUpdateSchema.parse(update)).toEqual(update);
    expect(providerModelUpdateSchema.safeParse({ ...update, providerId: 'other' }).success).toBe(false);
    expect(providerModelUpdateSchema.safeParse({ ...update, upstreamModelName: 'renamed' }).success).toBe(false);
    expect(providerModelUpdateSchema.safeParse({ ...update, compatibility: {} }).success).toBe(true);
  });
});
