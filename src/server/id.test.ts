import { describe, expect, it } from 'vitest';
import { newId } from './id';

describe('newId', () => {
  it('keeps the prefix readable and the body unique', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('chat')));
    expect(ids.size).toBe(500);
    expect([...ids].every((id) => /^chat_[0-9a-f]{32}$/.test(id))).toBe(true);
  });
});
