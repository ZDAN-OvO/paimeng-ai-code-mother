'use client';
import { Empty, Input, Segmented, Spin } from 'antd';
import type { AdminCreditOverviewItem, AdminCreditFilter } from '@/shared/billing';
import { adminCreditFilterLabels } from '@/shared/billing';
import styles from './credit-page.module.css';

const filters: AdminCreditFilter[] = ['all', 'debt', 'pending'];

/**
 * 左列用户列表：搜索、全部/欠款/待发筛选、当前选中态与底部计数。
 * 金额是服务端算好的可用额；欠款用红色，待发只说明「本期没有规则条目」。
 */
export function CreditUserList({ items, selectedId, loading, filter, query, onFilter, onQuery, onSelect }: {
  items: AdminCreditOverviewItem[];
  selectedId: string | null;
  loading: boolean;
  filter: AdminCreditFilter;
  query: string;
  onFilter: (filter: AdminCreditFilter) => void;
  onQuery: (query: string) => void;
  onSelect: (userId: string) => void;
}) {
  return <>
    <div className={styles.listHead}>
      <Input.Search
        allowClear
        placeholder="账号、用户名或用户 ID"
        aria-label="搜索用户"
        value={query}
        onChange={event => onQuery(event.target.value)}
        onSearch={value => onQuery(value)}
      />
      <Segmented
        size="small"
        value={filter}
        onChange={value => onFilter(value as AdminCreditFilter)}
        options={filters.map(value => ({ value, label: adminCreditFilterLabels[value] }))}
      />
    </div>
    <div className={styles.listScroll}>
      {loading ? <div className={styles.listState}><Spin size="small" /></div>
        : items.length === 0 ? <div className={styles.listState}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的用户" /></div>
        : items.map(item => <button
          type="button"
          key={item.userId}
          className={`${styles.userRow} ${item.userId === selectedId ? styles.userRowActive : ''}`}
          onClick={() => onSelect(item.userId)}
          aria-pressed={item.userId === selectedId}
        >
          <span className={styles.userMain}>
            <strong>{item.userAccount}</strong>
            <span>{item.userName || '未设置用户名'}</span>
          </span>
          <span className={styles.userAmount}>
            <b className={item.available < 0 ? styles.amountNeg : undefined}>{item.available}</b>
            <span>{item.status === 'pending' ? '待发' : '积分'}</span>
          </span>
        </button>)}
    </div>
  </>;
}
