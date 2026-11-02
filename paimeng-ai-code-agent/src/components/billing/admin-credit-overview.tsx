'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Input, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api } from '@/client/api';
import { formatBeijingTime, formatStoredTime } from '@/shared/display';
import {
  adminCreditFilterLabels, adminCreditFilters, adminCreditSortLabels, adminCreditSorts, adminQuotaStatusLabels, quotaPolicySourceLabels,
  type AdminCreditFilter, type AdminCreditOverview, type AdminCreditOverviewItem, type AdminCreditSort, type AdminCreditUser,
} from '@/shared/billing';
import styles from '@/components/admin-view.module.css';

const pageSizeOptions = [10, 20, 50];

/** 金额的统一展示：负数保留符号，欠款与可用额不混成一个数。 */
const credits = (value: number) => `${value} Credit`;

/**
 * Credit 管理默认页：全用户配额/余额总览。
 * 筛选、排序、统计都在服务端执行；表格只渲染当前页，页脚明确当前范围与全库统计不是一回事。
 */
export function AdminCreditOverviewPanel({ onSelect }: { onSelect: (user: AdminCreditUser) => void }) {
  const [data, setData] = useState<AdminCreditOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<AdminCreditFilter>('all');
  const [sort, setSort] = useState<AdminCreditSort>('id_desc');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), filter, sort });
      if (search) params.set('q', search);
      setData(await api<AdminCreditOverview>('admin/billing/overview?' + params.toString()));
      setError(null);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filter, sort, search]);

  useEffect(() => { void load(); }, [load]);

  function submitSearch(next: string) {
    setQuery(next);
    setSearch(next.trim());
    setPage(1);
  }

  function select(user: AdminCreditOverviewItem) {
    onSelect({ userId: user.userId, userAccount: user.userAccount, userName: user.userName });
  }

  const columns: ColumnsType<AdminCreditOverviewItem> = [
    {
      title: '用户',
      key: 'user',
      width: 300,
      render: (_, row) => <div className={styles.identityCell}>
        <strong>{row.userAccount}</strong>
        <span>{row.userName || '未设置用户名'}</span>
        <span className={styles.slotName}>{row.userId}</span>
      </div>,
    },
    {
      title: '当月配额',
      key: 'quota',
      width: 230,
      render: (_, row) => <div className={styles.identityCell}>
        <span>基础 {credits(row.quotaBase)} · 已用 {credits(row.quotaUsed)}</span>
        <strong>剩余 {credits(row.quotaRemaining)}</strong>
        <span className={styles.statusHint}>月底失效 · {formatBeijingTime(row.expiresAt)}</span>
      </div>,
    },
    {
      title: '余额池',
      key: 'balance',
      width: 150,
      render: (_, row) => <div className={styles.identityCell}>
        <strong>{credits(row.balance)}</strong>
        {row.debt > 0 && <Tag color="red">欠款 {credits(row.debt)}</Tag>}
        {row.snapshotAnomaly && <Tag color="orange">快照异常</Tag>}
      </div>,
    },
    {
      title: '合计可用',
      key: 'total',
      width: 140,
      render: (_, row) => <div className={styles.identityCell}>
        <strong>{credits(row.total)}</strong>
        <span className={styles.statusHint}>配额剩余 + 余额池</span>
      </div>,
    },
    {
      title: '发放状态',
      key: 'issue',
      width: 150,
      render: (_, row) => <div className={styles.identityCell}>
        <Tag color={row.issueStatus === 'granted' ? 'green' : row.issueStatus === 'failed' ? 'red' : 'gold'}>
          {adminQuotaStatusLabels[row.issueStatus]}
        </Tag>
        <span className={styles.statusHint}>{quotaPolicySourceLabels[row.policySource]}</span>
      </div>,
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_, row) => <Button size="small" onClick={() => select(row)}>查看详情</Button>,
    },
  ];

  return <section aria-label="全用户额度总览">
    <div className={styles.sectionHeading}>
      <h2>全用户额度总览</h2>
      <span className={styles.statusHint}>默认按用户 ID 倒序；筛选、排序与统计均覆盖当前筛选范围，不是当前页合计</span>
    </div>
    <div className={styles.filterBar}>
      <Input.Search
        aria-label="搜索用户"
        allowClear
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onSearch={submitSearch}
        placeholder="账号 / 用户名模糊搜索，完整用户 ID 精确搜索"
        style={{ flex: '1 1 320px', minWidth: 240 }}
      />
      <Select
        aria-label="筛选用户"
        value={filter}
        style={{ width: 150 }}
        options={adminCreditFilters.map(value => ({ value, label: adminCreditFilterLabels[value] }))}
        onChange={(value: AdminCreditFilter) => { setFilter(value); setPage(1); }}
      />
      <Select
        aria-label="排序"
        value={sort}
        style={{ width: 190 }}
        options={adminCreditSorts.map(value => ({ value, label: adminCreditSortLabels[value] }))}
        onChange={(value: AdminCreditSort) => { setSort(value); setPage(1); }}
      />
      <Button onClick={() => void load()} loading={loading}>刷新</Button>
    </div>
    {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
    {data && <>
      <div className={styles.overviewStats} aria-label="当前筛选范围统计">
        <Stat label="用户数" value={String(data.stats.userCount)} hint={`当前筛选范围 · 数据时点 ${formatStoredTime(data.asOf)}`} />
        <Stat label="配额待发" value={String(data.stats.pendingCount)} hint="这些用户没有当期基础发放记录" />
        <Stat label="配额剩余总量" value={credits(data.stats.quotaRemainingTotal)} hint="仅当前账期有效配额" />
        <Stat label="余额池净额" value={credits(data.stats.balanceNetTotal)} hint="负数代表净欠款" />
        <Stat label="欠款人数 / 总额" value={`${data.stats.debtorCount} 人 / ${credits(data.stats.debtTotal)}`} hint="按余额池为负统计" />
      </div>
      <Table<AdminCreditOverviewItem>
        rowKey="userId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data.items}
        scroll={{ x: 1070 }}
        pagination={{
          current: page,
          pageSize,
          total: data.total,
          showSizeChanger: true,
          pageSizeOptions,
          showTotal: total => `共 ${total} 人`,
          onChange: (nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); },
        }}
        locale={{ emptyText: '没有符合筛选条件的用户' }}
        onRow={(row) => ({ onClick: () => select(row), style: { cursor: 'pointer' } })}
      />
      <p className={styles.statusHint}>
        当前第 {data.page} 页，每页 {data.pageSize} 人；统计范围与表格使用同一份服务端事实口径。点击任一行打开用户详情。
      </p>
    </>}
  </section>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className={styles.statCard}>
    <span className={styles.statLabel}>{label}</span>
    <strong>{value}</strong>
    <span className={styles.statusHint}>{hint}</span>
  </div>;
}

export function AdminUserIdentity({ user }: { user: AdminCreditUser }) {
  return <Space size={4} wrap>
    <span>{user.userAccount}</span>
    <span className={styles.statusHint}>{user.userName || '未设置用户名'}</span>
    <span className={styles.slotName}>{user.userId}</span>
  </Space>;
}
