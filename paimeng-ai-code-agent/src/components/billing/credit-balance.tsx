'use client';
import { useEffect, useState } from 'react';
import { App } from 'antd';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import { formatBeijingTime } from '@/shared/display';
import type { AccountSummary } from '@/shared/billing';
import styles from './credit-balance.module.css';

/**
 * 额度条：Owner 自己的可用积分，以及它由哪两种积分组成。
 * 永远只读自己的——管理员看他人余额走 admin 接口，这里不接受 userId。
 * `refreshToken` 变化时重取，用来在发放或结算之后刷新。
 */
export function CreditBalance({ refreshToken }: { refreshToken?: string }) {
  const { user } = useAuth();
  const { message } = App.useApp();
  // 余额与它所属的用户一起存：切账号后旧响应既不会显示，也不需要额外的清空副作用。
  const [loaded, setLoaded] = useState<{ userId: string; summary: AccountSummary } | null>(null);

  useEffect(() => {
    if (!user) return;
    let live = true;
    api<AccountSummary>('billing/summary')
      .then((summary) => {
        if (live) setLoaded({ userId: user.id, summary });
      })
      .catch((error: unknown) => {
        if (live) message.error((error as Error).message);
      });
    return () => {
      live = false;
    };
  }, [user, refreshToken, message]);

  const summary = user && loaded?.userId === user.id ? loaded.summary : null;
  if (!user || !summary) return null;
  return (
    <section className={styles.creditBalance} aria-label="我的积分概览">
      <p className={styles.pools}>
        <span>
          可用<strong>{summary.available}</strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          限时<strong>{summary.limited}</strong>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          长期<strong>{summary.lasting}</strong>
        </span>
      </p>
      <p className={styles.detail}>
        <span>
          {summary.limitedExpiresAt
            ? `限时积分在北京时间 ${formatBeijingTime(summary.limitedExpiresAt)} 到期，不累积、不折现`
            : '当前没有会过期的限时积分'}
        </span>
        <span aria-hidden="true">·</span>
        <span>长期积分不过期</span>
      </p>
      <p className={styles.detail}>
        <span>透支线 {summary.overdraft} 积分</span>
        <span aria-hidden="true">·</span>
        <span>近 60 天充值 {summary.purchasedCredits60d} 积分</span>
      </p>
    </section>
  );
}
