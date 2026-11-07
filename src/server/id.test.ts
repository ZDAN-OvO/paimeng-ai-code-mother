import { describe, expect, it } from 'vitest';
import { newDeployKey, newId } from './id';

describe('newId', () => {
  it('keeps the prefix readable and the body unique', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('chat')));
    expect(ids.size).toBe(500);
    expect([...ids].every((id) => /^chat_[0-9a-f]{32}$/.test(id))).toBe(true);
  });
});

describe('newDeployKey', () => {
  it('is url safe and long enough to guess-proof', () => {
    const keys = new Set(Array.from({ length: 500 }, () => newDeployKey()));
    expect(keys.size).toBe(500);
    expect([...keys].every((key) => /^[A-Za-z0-9_-]{12}$/.test(key))).toBe(true);
  });
});
