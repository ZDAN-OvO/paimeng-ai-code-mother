'use client';
import type { AdminCreditUser } from '@/shared/billing';
import styles from './credit-page.module.css';

/** 管理面用户身份：账号、用户名、ID。用户名为空时给占位，不留空白。 */
export function AdminUserIdentity({ user }: { user: AdminCreditUser }) {
  return (
    <div className={styles.identity}>
      <strong>{user.userAccount}</strong>
      <span>
        {user.userName || '未设置用户名'} · {user.userId}
      </span>
    </div>
  );
}
