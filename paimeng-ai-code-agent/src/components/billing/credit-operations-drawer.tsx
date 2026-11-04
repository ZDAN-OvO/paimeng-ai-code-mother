'use client';
import { useCallback, useEffect, useState } from 'react';
import { App, Drawer, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api } from '@/client/api';
import {
  creditOperationKindLabels,
  creditOperationStatusLabels,
  type CreditOperationList,
  type CreditOperationView,
} from '@/shared/billing';
import { formatStoredTime } from '@/shared/display';
import styles from './credit-page.module.css';

const statusColors: Record<CreditOperationView['status'], string> = {
  running: 'blue',
  completed: 'green',
  partial: 'gold',
  failed: 'red',
};

/**
 * 最近操作：批量发放与过期扫描的摘要。单笔发放不在这里重复——去那个人的流水里看。
 * 金额与人数可以按 requestId 从账本重算，所以这里只是可读的记录，不是第二份真相。
 */
export function CreditOperationsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const [items, setItems] = useState<CreditOperationView[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<CreditOperationList>('admin/billing/operations?limit=20');
      setItems(data.operations);
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const columns: ColumnsType<CreditOperationView> = [
    {
      title: '时间',
      dataIndex: 'createTime',
      width: 168,
      render: (value) => formatStoredTime(value),
    },
    {
      title: '操作',
      dataIndex: 'kind',
      width: 110,
      render: (value: CreditOperationView['kind']) => creditOperationKindLabels[value],
    },
    {
      title: '操作人',
      dataIndex: 'operatorName',
      width: 130,
      render: (value) => value ?? 'system',
    },
    {
      title: '范围',
      key: 'scope',
      width: 150,
      render: (_, row) => (
        <span>
          {row.period ?? '—'} · {row.targetCount} 人
        </span>
      ),
    },
    {
      title: '结果',
      key: 'result',
      width: 190,
      render: (_, row) => (
        <span>
          <Tag color={statusColors[row.status]}>{creditOperationStatusLabels[row.status]}</Tag>
          {row.issuedCount} 成功 / {row.failedCount} 失败
          {row.credits ? <span className={styles.statusHint}> · +{row.credits}</span> : null}
        </span>
      ),
    },
    {
      title: '失败原因',
      dataIndex: 'detail',
      render: (detail: CreditOperationView['detail']) =>
        detail.length === 0 ? (
          <span className={styles.statusHint}>—</span>
        ) : (
          detail.slice(0, 3).map((item) => (
            <div key={item.userId} className={styles.reasonCell}>
              {item.userId}：{item.reason}
            </div>
          ))
        ),
    },
  ];

  return (
    <Drawer title="最近操作" open={open} onClose={onClose} size={860} destroyOnHidden>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={false}
      />
    </Drawer>
  );
}
