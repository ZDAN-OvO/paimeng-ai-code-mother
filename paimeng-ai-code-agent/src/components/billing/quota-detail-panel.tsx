'use client';
import { useEffect, useState } from 'react';
import { Alert, Descriptions, Table, Tag } from 'antd';
import { api } from '@/client/api';
import { formatBeijingTime, formatStoredTime } from '@/shared/display';
import {
  adminQuotaStatusLabels, poolLabels, quotaPolicySourceLabels, sourceLabels,
  type AdminCreditUser, type AdminUserUsage, type CreditGrantView, type QuotaIssueView,
} from '@/shared/billing';
import { AdminUserIdentity } from './admin-credit-overview';
import styles from '@/components/admin-view.module.css';

/** 用户详情里的额度拆解：把「基础 / 调整 / 已用 / 剩余」四件事分开显示，合计可用不吞掉欠款。 */
export function QuotaDetailPanel({ user }: { user: AdminCreditUser }) {
  const [usage, setUsage] = useState<AdminUserUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await api<AdminUserUsage>('admin/billing/usage?limit=20&userId=' + encodeURIComponent(user.userId));
        if (alive) { setUsage(result); setError(null); }
      } catch (problem) {
        if (alive) setError((problem as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [user.userId]);

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!usage) return <p className={styles.statusHint}>正在读取额度详情…</p>;
  const credit = usage.credit;
  return <section aria-label="用户额度概览">
    <div className={styles.sectionHeading}>
      <h2>额度概览</h2>
      <span className={styles.statusHint}>数据时点 {formatStoredTime(credit.asOf)}；金额单位都是 Credit</span>
    </div>
    <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
      { key: 'identity', label: '用户', span: 2, children: <AdminUserIdentity user={credit.user} /> },
      {
        key: 'status', label: '账期与状态', children: <span>
          {credit.period} · <Tag color={credit.quota.issueStatus === 'granted' ? 'green' : 'gold'}>
            {adminQuotaStatusLabels[credit.quota.issueStatus]}
          </Tag> · {quotaPolicySourceLabels[credit.quota.policySource]}
        </span>,
      },
      { key: 'expires', label: '配额到期', children: `北京时间 ${formatBeijingTime(credit.quota.expiresAt)}` },
      {
        key: 'rule', label: '当前 / 下一账期规则',
        children: `${credit.rule.current.credits} Credit（${quotaPolicySourceLabels[credit.rule.current.source]}） / ${credit.rule.next.credits} Credit（${quotaPolicySourceLabels[credit.rule.next.source]}）`,
      },
      { key: 'base', label: '基础已发', children: `${credit.quota.baseCredits} Credit` },
      { key: 'adjust', label: '当月调整净额', children: `${credit.quota.adjustmentCredits} Credit` },
      { key: 'used', label: '当月已用', children: `${credit.quota.usedCredits} Credit` },
      { key: 'remaining', label: '当前有效剩余', children: `${credit.quota.remainingCredits} Credit` },
      { key: 'balance', label: '余额池', children: `${credit.balance} Credit` },
      { key: 'total', label: '合计可用', children: `${credit.total} Credit` },
      { key: 'purchased', label: '累计购买 / 近 60 天购买', children: `${credit.purchasedCredits} / ${credit.purchasedCredits60d} Credit` },
      { key: 'admin', label: '累计管理员补偿', children: `${credit.adminGrantedCredits} Credit` },
      { key: 'debt', label: '欠款 / 透支线', children: `${credit.debt} / ${credit.overdraft} Credit` },
    ]} />
    {credit.snapshotAnomaly && <Alert
      type="warning"
      showIcon
      style={{ marginTop: 12 }}
      title="余额快照与账本事实不一致"
      description={`快照：配额 ${credit.snapshot.quota}、余额 ${credit.snapshot.balance}；事实：配额 ${credit.quota.remainingCredits}、余额 ${credit.balance}。本页只读，不用界面写库；修复按账本事实重建（CLI 的 audit/rebuild）。`}
    />}
    <div className={styles.sectionHeading}>
      <h2>最近基础发放事实</h2>
      <span className={styles.statusHint}>每用户每账期一条；0 配额也会出现，不伪造零金额 grant</span>
    </div>
    <Table<QuotaIssueView>
      rowKey="id"
      size="small"
      dataSource={credit.issues}
      pagination={false}
      scroll={{ x: 860 }}
      locale={{ emptyText: '还没有基础发放事实' }}
      columns={[
        { title: '账期', dataIndex: 'period', width: 100 },
        { title: '基础金额', dataIndex: 'baseCredits', width: 110, render: (value: number) => `${value} Credit` },
        { title: '状态', dataIndex: 'status', width: 90, render: (value: QuotaIssueView['status']) => value === 'granted' ? '已发' : '失败' },
        { title: '来源', dataIndex: 'policySource', width: 110, render: (value: QuotaIssueView['policySource']) => quotaPolicySourceLabels[value] },
        { title: '版本', dataIndex: 'policyVersion', width: 80, render: (value: number | null) => value === null ? '—' : `v${value}` },
        { title: 'Grant ID', dataIndex: 'grantId', width: 220, render: (value: string | null) => value ?? '无（0 配额）' },
        { title: '时间', dataIndex: 'createTime', width: 160, render: (value: string) => formatStoredTime(value) },
      ]}
    />
    <div className={styles.sectionHeading}>
      <h2>最近发放记录</h2>
      <span className={styles.statusHint}>只读流水；月度配额与余额发放分开显示</span>
    </div>
    <Table<CreditGrantView>
      rowKey="id"
      size="small"
      dataSource={credit.grants}
      pagination={false}
      scroll={{ x: 860 }}
      locale={{ emptyText: '这个用户还没有发放记录' }}
      columns={[
        { title: '时间', dataIndex: 'createTime', width: 160, render: value => formatStoredTime(value) },
        { title: '来源', dataIndex: 'source', width: 110, render: (value: CreditGrantView['source']) => sourceLabels[value] },
        { title: '池', dataIndex: 'pool', width: 90, render: (value: CreditGrantView['pool']) => poolLabels[value] },
        { title: '金额', dataIndex: 'credits', width: 100, render: value => `${value} Credit` },
        { title: '账期', dataIndex: 'period', width: 90, render: value => value ?? '—' },
        { title: '操作人', dataIndex: 'grantedBy', width: 140, render: value => value ?? '系统' },
        { title: '备注', dataIndex: 'note', render: value => value ?? '—' },
      ]}
    />
  </section>;
}
