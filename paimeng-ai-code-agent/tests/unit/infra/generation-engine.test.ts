import { afterEach, describe, expect, it } from 'vitest';
import { getConfig } from '@/server/infra/config';

const original = process.env.GENERATION_ENGINE;

afterEach(() => {
  if (original === undefined) delete process.env.GENERATION_ENGINE;
  else process.env.GENERATION_ENGINE = original;
});

describe('GENERATION_ENGINE', () => {
  it('默认走 harness，旧路径不受影响', () => {
    delete process.env.GENERATION_ENGINE;
    expect(getConfig().generationEngine).toBe('harness');
  });

  it('接受 agent，大小写与空白不敏感', () => {
    process.env.GENERATION_ENGINE = ' Agent ';
    expect(getConfig().generationEngine).toBe('agent');
  });

  it('未知取值直接报错，不静默回退', () => {
    process.env.GENERATION_ENGINE = 'workflow';
    expect(() => getConfig()).toThrow();
  });
});
