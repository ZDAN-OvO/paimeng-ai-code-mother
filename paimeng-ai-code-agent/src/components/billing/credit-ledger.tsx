'use client';
import { Button, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  creditEntryKindLabels, creditEntryOriginLabels,
  type CreditLedgerEntryView,
} from '@/shared/billing';
import { formatStoredTime } from '@/shared/display';
import styles from './credit-page.module.css';

const kindColors: Record<CreditLedgerEntryView['kind'], string> = {
  quota: 'blue',
  topup: 'cyan',
  grant: 'green',
  consume: 'default',
  refund: 'gold',
  expire: 'default',
};

const amountClass = (credits: number) => credits > 0 ? styles.amountPos : credits < 0 ? styles.amountNeg : styles.amountZero;
const signed = (credits: number) => credits > 0 ? `+${credits}` : String(credits);

/**
 * 一个人的流水：每条都是账本事实，按时间倒序。过期行置灰，0 积分回执行也保留（灰字）。
 * 结余由服务端按「create_time, id」的正序累计给出，界面不自己加。
 */
export function CreditLedger({ entries, loading, hasMore, onLoadMore }: {
  entries: CreditLedgerEntryView[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const columns: ColumnsType<CreditLedgerEntryView> = [
    {
      title: '时间',
      dataIndex: 'createTime',
      width: 168,
      render: (value: string) => <span className={styles.timeCell}>{formatStoredTime(value)}</span>,
    },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 116,
      render: (kind: CreditLedgerEntryView['kind'], row) => <Tag color={kindColors[kind]}>
        {kind === 'quota' && row.origin === 'rule' ? '每月发放' : creditEntryKindLabels[kind]}
      </Tag>,
    },
    {
      title: '积分',
      dataIndex: 'credits',
      width: 100,
      align: 'right',
      render: (credits: number) => <b className={amountClass(credits)}>{signed(credits)}</b>,
    },
    {
      title: '结余',
      dataIndex: 'balanceAfter',
      width: 100,
      align: 'right',
      render: (value: number | undefined) => value === undefined ? '—' : <span className={amountClass(value)}>{value}</span>,
    },
    {
      title: '说明',
      key: 'reason',
      render: (_, row) => <span className={styles.reasonCell}>
        {row.credits === 0 ? '本月规则发放 0（暂停发放）' : row.reason || creditEntryOriginLabels[row.origin]}
        {row.period && row.kind === 'quota' ? <span className={styles.statusHint}> · 账期 {row.period}</span> : null}
      </span>,
    },
  ];
  return <>
    <Table
      rowKey="id"
      size="small"
      sticky
      loading={loading}
      columns={columns}
      dataSource={entries}
      pagination={false}
      rowClassName={(row) => row.kind === 'expire' || row.credits === 0 ? styles.expiredRow : ''}
    />
    {hasMore && <div className={styles.loadMore}>
      <Button size="small" onClick={onLoadMore} loading={loading}>加载更早</Button>
    </div>}
  </>;
}
