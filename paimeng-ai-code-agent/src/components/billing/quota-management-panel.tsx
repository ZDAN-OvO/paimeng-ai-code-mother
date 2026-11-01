'use client';
import { useEffect, useState } from 'react';
import { Alert, Table, Tag } from 'antd';
import { api } from '@/client/api';
import {
  adminQuotaStatusLabels,
  type AdminCreditOverview, type AdminCreditOverviewItem, type AdminCreditUser,
} from '@/shared/billing';
import { AdminUserIdentity } from './admin-credit-overview';
import styles from '@/components/admin-view.module.css';

/**
 * 配额管理（C1 只读视图）：当前仍是固定 500 Credit / 北京自然月，展示待发与本月已发规模。
 * 策略版本、单用户调整与批量发放会在后续提交接入；这里不提供任何写入口，避免出现兑现不了的按钮。
 */
export function QuotaManagementPanel({ onSelect }: { onSelect: (user: AdminCreditUser) => void }) {
  const [all, setAll] = useState<AdminCreditOverview | null>(null);
  const [pending, setPending] = useState<AdminCreditOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [allUsers, pendingUsers] = await Promise.all([
          api<AdminCreditOverview>('admin/billing/overview?page=1&pageSize=1&filter=all&sort=id_desc'),
          api<AdminCreditOverview>('admin/billing/overview?page=1&pageSize=20&filter=pending&sort=id_desc'),
        ]);
        if (alive) { setAll(allUsers); setPending(pendingUsers); setError(null); }
      } catch (problem) {
        if (alive) setError((problem as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!all || !pending) return <p className={styles.statusHint}>正在读取本月配额状态…</p>;
  const issued = all.stats.userCount - pending.stats.pendingCount;
  return <section aria-label="配额管理">
    <div className={styles.sectionHeading}>
      <h2>本月配额</h2>
      <span className={styles.statusHint}>
        当前规则：每用户每北京自然月 500 Credit，月底失效、不结转；发放是惰性的，可由 CLI 批量补发
      </span>
    </div>
    <div className={styles.overviewStats} aria-label="本月配额统计">
      <Stat label="账期" value={all.period} hint="北京时间自然月" />
      <Stat label="已发人数" value={String(issued)} hint={`全库未删除用户 ${all.stats.userCount} 人`} />
      <Stat label="待发人数" value={String(pending.stats.pendingCount)} hint="没有当期基础发放记录" />
      <Stat label="配额剩余总量" value={`${all.stats.quotaRemainingTotal} Credit`} hint="仅当前账期有效配额" />
      <Stat label="余额池净额" value={`${all.stats.balanceNetTotal} Credit`} hint="负数代表净欠款" />
    </div>
    <div className={styles.sectionHeading}>
      <h2>待发用户</h2>
      <span className={styles.statusHint}>最多展示前 20 人；完整名单在 Credit 管理里按「配额待发」筛选</span>
    </div>
    <Table<AdminCreditOverviewItem>
      rowKey="userId"
      size="small"
      dataSource={pending.items}
      pagination={false}
      scroll={{ x: 760 }}
      locale={{ emptyText: '当前没有待发用户' }}
      onRow={(row) => ({ onClick: () => onSelect({ userId: row.userId, userAccount: row.userAccount, userName: row.userName }), style: { cursor: 'pointer' } })}
      columns={[
        { title: '用户', key: 'user', width: 320, render: (_, row) => <AdminUserIdentity user={row} /> },
        { title: '账期', dataIndex: 'period', width: 100 },
        { title: '配额状态', dataIndex: 'issueStatus', width: 120, render: (value: AdminCreditOverviewItem['issueStatus']) => <Tag color={value === 'granted' ? 'green' : 'gold'}>{adminQuotaStatusLabels[value]}</Tag> },
        { title: '基础已发', dataIndex: 'quotaBase', width: 110, render: value => `${value} Credit` },
        { title: '当前剩余', dataIndex: 'quotaRemaining', width: 110, render: value => `${value} Credit` },
        { title: '余额池', dataIndex: 'balance', width: 110, render: value => `${value} Credit` },
      ]}
    />
  </section>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className={styles.statCard}>
    <span className={styles.statLabel}>{label}</span>
    <strong>{value}</strong>
    <span className={styles.statusHint}>{hint}</span>
  </div>;
}
