import { describe, expect, it } from 'vitest';
import { truncateUtf8 } from '@/server/runtime/commands';

describe('命令输出截断', () => {
  it('按 UTF-8 字节截断，不把一个字符劈成两半', () => {
    // 每个汉字 3 字节；上限 7 字节只能放下两个汉字（6 字节），不能留下半个字。
    const { text, truncated } = truncateUtf8('安装失败原因', 7);
    expect(truncated).toBe(true);
    expect(text).toBe('安装');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(7);
  });

  it('未超过上限时原样返回', () => {
    expect(truncateUtf8('ok', 8192)).toEqual({ text: 'ok', truncated: false });
  });

  it('空串与零上限不会抛错', () => {
    expect(truncateUtf8('', 0)).toEqual({ text: '', truncated: false });
    expect(truncateUtf8('abc', 0)).toEqual({ text: '', truncated: true });
  });
});
