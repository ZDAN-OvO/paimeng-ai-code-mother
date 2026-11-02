'use client';
import { useState } from 'react';
import { Tabs } from 'antd';
import { AdminGuard } from '@/components/providers';
import type { AdminCreditUser } from '@/shared/billing';
import { CreditManagementPanel } from './credit-management-panel';
import { QuotaManagementPanel } from './quota-management-panel';
import styles from '@/components/admin-view.module.css';

/**
 * 额度管理：只保留两个主页签。
 * - Credit 管理：全用户总览 + 用户详情里的余额发放/账单冲正 + 单一补结算工具。
 * - 配额管理：月度规则与当月发放；当前是只读阶段，后续接入策略、调整与批量入口。
 */
export function BillingManager() {
  return <AdminGuard><main className={styles.adminPage}><BillingTabs /></main></AdminGuard>;
}

function BillingTabs() {
  const [activeKey, setActiveKey] = useState('credit');
  const [selected, setSelected] = useState<AdminCreditUser | null>(null);
  return <Tabs
    activeKey={activeKey}
    onChange={setActiveKey}
    items={[
      {
        key: 'credit',
        label: 'Credit 管理',
        children: <CreditManagementPanel selected={selected} onSelect={setSelected} onClose={() => setSelected(null)} />,
      },
      {
        key: 'quota',
        label: '配额管理',
        children: <QuotaManagementPanel onSelect={(user) => { setSelected(user); setActiveKey('credit'); }} />,
      },
    ]}
  />;
}
