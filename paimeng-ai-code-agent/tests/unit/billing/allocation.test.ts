import { describe, expect, it } from 'vitest';
import {
  allocate, periodsOf, pendingExpiryOf, remainderOfPeriod, splitOf, type LedgerLike,
} from '@/server/billing/allocation';

/**
 * 账本算术：把一个用户的流水折叠成账期剩余，再按到期顺序分配扣减。
 * 这里只测纯函数；SQL 与写入路径见 tests/integration/billing/{quota,expiry,settlement}。
 */

let nextId = 1;
function row(input: Partial<LedgerLike> & Pick<LedgerLike, 'kind' | 'credits'>): LedgerLike {
  return {
    id: nextId++,
    origin: input.kind === 'quota' ? 'rule' : 'charge',
    period: null,
    expiresAt: null,
    createTime: '2026-10-01 00:00:00.000',
    ...input,
  } as LedgerLike;
}

const october = { period: '2026-10', expiresAt: '2026-10-31 16:00:00.000' };
const november = { period: '2026-11', expiresAt: '2026-11-30 16:00:00.000' };
const december = { period: '2026-12', expiresAt: '2026-12-31 16:00:00.000' };
const now = new Date('2026-11-15T00:00:00.000Z');

describe('账期折叠', () => {
  it('发放、消费、退回、过期各归各的账期', () => {
    const rows = [
      row({ kind: 'quota', credits: 500, ...november }),
      row({ kind: 'consume', credits: -120, ...november }),
      row({ kind: 'refund', credits: 20, ...november }),
      row({ kind: 'quota', credits: 300, ...october }),
      row({ kind: 'expire', origin: 'expiry', credits: -300, ...october }),
    ];
    const facts = periodsOf(rows, now);
    expect(facts.get('2026-11')).toMatchObject({ issued: 500, consumed: 100, expired: 0, remaining: 400, swept: false });
    expect(facts.get('2026-10')).toMatchObject({ issued: 300, consumed: 0, expired: 300, remaining: 0, swept: true });
  });

  it('越过到期时刻但还没写过期行：剩余按 0 计入，pending 列出真实余量', () => {
    const rows = [row({ kind: 'quota', credits: 500, ...october })];
    expect(remainderOfPeriod(rows, '2026-10')).toBe(500);
    expect(pendingExpiryOf(rows, now)).toEqual([{ period: '2026-10', remainder: 500 }]);
  });
});

describe('可用额与两种口径', () => {
  it('可用 = 所有条目之和 − 未写出的过期余量；限时 = 未到期账期的剩余', () => {
    const rows = [
      row({ kind: 'quota', credits: 500, ...october }),
      row({ kind: 'quota', credits: 300, ...november }),
      row({ kind: 'grant', credits: 120 }),
      row({ kind: 'consume', credits: -100, ...november }),
      row({ kind: 'consume', credits: -40 }),
    ];
    const split = splitOf(rows, now);
    // 原始和 = 780；十月剩下的 500 还没写过期行，被读修正扣掉。
    expect(split.available).toBe(280);
    expect(split.limited).toBe(200);
    expect(split.lasting).toBe(80);
    expect(split.nextExpiryAt).toBe('2026-11-30 16:00:00.000');
  });

  it('写过过期行后不再重复扣减', () => {
    const rows = [
      row({ kind: 'quota', credits: 500, ...october }),
      row({ kind: 'expire', origin: 'expiry', credits: -500, ...october }),
      row({ kind: 'quota', credits: 300, ...november }),
    ];
    const split = splitOf(rows, now);
    expect(split.available).toBe(300);
    expect(split.limited).toBe(300);
    expect(split.lasting).toBe(0);
  });

  it('负数可用额保留符号（欠款），限时永远不为负', () => {
    const rows = [row({ kind: 'consume', credits: -60 })];
    const split = splitOf(rows, now);
    expect(split).toMatchObject({ available: -60, limited: 0, lasting: -60, nextExpiryAt: null });
  });
});

describe('按到期顺序分配', () => {
  it('先扣最早到期的账期，跨两个账期时返回两段', () => {
    const rows = [
      row({ kind: 'quota', credits: 100, ...november }),
      row({ kind: 'quota', credits: 200, ...december }),
    ];
    expect(allocate(rows, 150, now)).toEqual({
      slices: [
        { period: '2026-11', expiresAt: '2026-11-30 16:00:00.000', credits: 100 },
        { period: '2026-12', expiresAt: '2026-12-31 16:00:00.000', credits: 50 },
      ],
      lasting: 0,
    });
  });

  it('扣完限时积分后溢出到长期积分', () => {
    const rows = [
      row({ kind: 'quota', credits: 100, ...november }),
      row({ kind: 'grant', credits: 30 }),
    ];
    expect(allocate(rows, 150, now)).toEqual({
      slices: [{ period: '2026-11', expiresAt: '2026-11-30 16:00:00.000', credits: 100 }],
      lasting: 50,
    });
  });

  it('已过期的账期不参与分配', () => {
    const rows = [
      row({ kind: 'quota', credits: 500, ...october }),
      row({ kind: 'quota', credits: 80, ...december }),
    ];
    expect(allocate(rows, 200, now)).toEqual({
      slices: [{ period: '2026-12', expiresAt: '2026-12-31 16:00:00.000', credits: 80 }],
      lasting: 120,
    });
  });

  it('同一到期时刻按账期排序，金额精确到分不四舍五入', () => {
    const rows = [
      row({ kind: 'quota', credits: 7, period: '2026-12', expiresAt: '2026-12-31 16:00:00.000' }),
      row({ kind: 'quota', credits: 3, period: '2026-11', expiresAt: '2026-12-31 16:00:00.000' }),
    ];
    expect(allocate(rows, 5, now).slices).toEqual([
      { period: '2026-11', expiresAt: '2026-12-31 16:00:00.000', credits: 3 },
      { period: '2026-12', expiresAt: '2026-12-31 16:00:00.000', credits: 2 },
    ]);
  });
});
