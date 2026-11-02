'use client';
import { useState } from 'react';
import { Button, Drawer, Tabs } from 'antd';
import type { AdminCreditUser } from '@/shared/billing';
import { AdminCreditOverviewPanel, AdminUserIdentity } from './admin-credit-overview';
import { AdminUsagePanel } from './admin-usage-panel';
import { CreditBalance } from './credit-balance';
import { GrantPanel } from './grant-panel';
import { QuotaDetailPanel } from './quota-detail-panel';
import { ReconcilePanel } from './reconcile-panel';
import { UserSearchSelect } from './user-search-select';
import styles from '@/components/admin-view.module.css';

/**
 * Credit 管理：默认是全用户总览；用户详情、余额发放、账单冲正都从选中用户进入。
 * 补结算是唯一工具入口，按需打开抽屉；不挂在页签外，也不在配额管理里重复出现。
 */
export function CreditManagementPanel({ selected, onSelect, onClose }: {
  selected: AdminCreditUser | null;
  onSelect: (user: AdminCreditUser) => void;
  onClose: () => void;
}) {
  const [reconcileOpen, setReconcileOpen] = useState(false);

  return <>
    <section aria-label="Credit 管理">
      <div className={styles.sectionHeading}>
        <h1>Credit 管理</h1>
        <span className={styles.statusHint}>全用户配额池与余额池；本人额度条只显示自己，不参与下方全库统计</span>
        <div className={styles.headingActions}>
          <Button onClick={() => setReconcileOpen(true)}>补结算</Button>
        </div>
      </div>
      <div className={styles.ownBalance} aria-label="管理员本人余额">
        <span className={styles.statusHint}>我的余额（仅本人，不参与全库统计）</span>
        <CreditBalance />
      </div>
      <div className={styles.userJump}>
        <span className={styles.statusHint}>按账号、用户名或完整用户 ID 直达</span>
        <UserSearchSelect value={selected?.userId} onChange={(_userId, user) => { if (user) onSelect(user); }} />
      </div>
      <AdminCreditOverviewPanel onSelect={onSelect} />
    </section>
    <Drawer
      title={selected ? <AdminUserIdentity user={selected} /> : '用户详情'}
      open={selected !== null}
      onClose={onClose}
      size={980}
      destroyOnHidden
      styles={{ body: { paddingTop: 8 } }}
    >
      {selected && <Tabs items={[
        { key: 'quota', label: '额度概览', children: <QuotaDetailPanel user={selected} /> },
        { key: 'grant', label: '发放余额', children: <GrantPanel user={selected} /> },
        { key: 'usage', label: '账单与冲正', children: <AdminUsagePanel user={selected} /> },
      ]} />}
    </Drawer>
    <Drawer
      title="补结算与核对"
      open={reconcileOpen}
      onClose={() => setReconcileOpen(false)}
      size={1200}
      destroyOnHidden
    >
      {/* destroyOnHidden 是这里的关键：没打开抽屉就不会挂载，也就不会在浏览总览时发补结算请求。 */}
      <ReconcilePanel embedded />
    </Drawer>
  </>;
}
