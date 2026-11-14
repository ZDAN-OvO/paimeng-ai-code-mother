import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password'

describe('password', () => {
  it('hashes with a random salt and verifies', async () => {
    const first = await hashPassword('password123')
    const second = await hashPassword('password123')
    expect(first).not.toBe(second)
    expect(first.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('password123', first)).toBe(true)
    expect(await verifyPassword('password124', first)).toBe(false)
  })

  it('rejects malformed hashes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$abc$def')).toBe(false)
  })
})
