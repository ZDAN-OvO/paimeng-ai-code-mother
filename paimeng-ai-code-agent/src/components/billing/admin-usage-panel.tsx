'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Descriptions, Form, Input, Modal, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api } from '@/client/api';
import { stopReasonLabels } from '@/components/chat/generation-usage';
import {
  chargeStatusColors,
  chargeStatusLabels,
  creditDenominationLabel,
  type AdminCreditUser,
  type AdminUserUsage,
  type BillingChargeView,
  type ChargeReversalReceipt,
  type ChargeStatus,
} from '@/shared/billing';
import { formatStoredTime } from '@/shared/display';
import { AdminUserIdentity } from './credit-identity';
import styles from '@/components/admin-view.module.css';

type ReversalForm = { reason: string };

const percentOf = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

const fetchUsage = (userId: string) =>
  api<AdminUserUsage>('admin/billing/usage?userId=' + encodeURIComponent(userId));

/** 只有还有未冲正分录的账单才允许冲正；待处理/0 Credit 显示「无需冲正」。 */
function reversalStateOf(charge: BillingChargeView): 'ready' | 'reversed' | 'empty' {
  if (charge.status === 'reversed') return 'reversed';
  return charge.entries.length > 0 ? 'ready' : 'empty';
}

/**
 * 选中用户的账单与手工冲正：余额快照 + 最近账单（含售价、USD 成本、估算/未定价标记）。
 * 成本未知一律显示「成本未知」而不是 0；冲正只带理由，服务端复用 90 的 `reverseCharge`。
 */
export function AdminUsagePanel({ user }: { user: AdminCreditUser }) {
  const { message } = App.useApp();
  // 详情连同它所属的用户一起存：切人后旧读数不显示，也不需要先清空的副作用。
  const [usage, setUsage] = useState<{ userId: string; value: AdminUserUsage } | null>(null);
  const [error, setError] = useState<{ userId: string; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [target, setTarget] = useState<BillingChargeView | null>(null);
  const [reversing, setReversing] = useState(false);
  const [form] = Form.useForm<ReversalForm>();

  const load = useCallback(async () => {
    try {
      const value = await fetchUsage(user.userId);
      setUsage({ userId: user.userId, value });
      setError(null);
    } catch (problem) {
      setUsage(null);
      setError({ userId: user.userId, message: (problem as Error).message });
    }
  }, [user.userId]);

  useEffect(() => {
    let live = true;
    fetchUsage(user.userId)
      .then((value) => {
        if (!live) return;
        setUsage({ userId: user.userId, value });
        setError(null);
      })
      .catch((problem: unknown) => {
        if (!live) return;
        setUsage(null);
        setError({ userId: user.userId, message: (problem as Error).message });
      });
    return () => {
      live = false;
    };
  }, [user.userId]);

  const value = usage?.userId === user.userId ? usage.value : null;
  const currentError = error?.userId === user.userId ? error.message : null;
  const loading = refreshing || (!value && !currentError);

  async function submitReversal(values: ReversalForm) {
    if (!target) return;
    setReversing(true);
    try {
      const receipt = await api<ChargeReversalReceipt>(
        `admin/billing/charge/${encodeURIComponent(target.generationId)}/reverse`,
        { reason: values.reason },
      );
      message.success(
        receipt.reversed
          ? '已冲正：反向分录已按原积分种类记入账本'
          : '这笔账单之前已经冲正过，没有重复退款',
      );
      setTarget(null);
      form.resetFields();
      setRefreshing(true);
      try {
        await load();
      } finally {
        setRefreshing(false);
      }
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setReversing(false);
    }
  }

  const columns: ColumnsType<BillingChargeView> = [
    {
      title: '时间',
      dataIndex: 'createTime',
      width: 170,
      render: (value) => formatStoredTime(value),
    },
    {
      title: '应用',
      dataIndex: 'appId',
      width: 160,
      render: (id: string, charge) => (
        <span className={styles.slotName}>{charge.appName ?? id}</span>
      ),
    },
    {
      title: 'Generation',
      dataIndex: 'generationId',
      width: 220,
      render: (id: string) => <span className={styles.slotName}>{id}</span>,
    },
    {
      title: '售价（有效金额）',
      dataIndex: 'effectiveCredits',
      width: 160,
      render: (credits: number, charge) => (
        <span>
          {credits} 积分
          {credits !== charge.credits && (
            <span className={styles.statusHint}>（原扣 {charge.credits}）</span>
          )}
        </span>
      ),
    },
    {
      title: 'USD 成本',
      dataIndex: 'costUsd',
      width: 140,
      render: (cost: string | null | undefined) =>
        cost === null || cost === undefined ? <Tag>成本未知</Tag> : <span>${cost}</span>,
    },
    {
      title: '估算 / 未定价',
      dataIndex: 'estimated',
      width: 140,
      render: (_: boolean, charge) => (
        <div>
          {charge.estimated ? <Tag color="orange">估算</Tag> : null}
          {charge.unpriced ? <Tag>未定价</Tag> : null}
          {!charge.estimated && !charge.unpriced ? (
            <span className={styles.statusHint}>真实用量</span>
          ) : null}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (status: ChargeStatus) => (
        <Tag color={chargeStatusColors[status]}>{chargeStatusLabels[status]}</Tag>
      ),
    },
    {
      title: '结束原因',
      dataIndex: 'stopReason',
      width: 140,
      render: (reason: BillingChargeView['stopReason']) =>
        reason ? stopReasonLabels[reason] : '—',
    },
    {
      title: '操作',
      key: 'reverse',
      fixed: 'right',
      width: 120,
      render: (_, charge) => {
        const state = reversalStateOf(charge);
        return (
          <Button
            size="small"
            danger={state === 'ready'}
            disabled={state !== 'ready'}
            onClick={() => setTarget(charge)}
          >
            {state === 'ready' ? '冲正' : state === 'reversed' ? '已冲正' : '无需冲正'}
          </Button>
        );
      },
    },
  ];

  return (
    <section aria-label="账单与冲正">
      <div className={styles.sectionHeading}>
        <h2>账单与冲正</h2>
        <span className={styles.statusHint}>
          查看选中用户的逐笔成本；冲正需填写理由，复用自动冲正的幂等保护
        </span>
      </div>
      <Descriptions
        bordered
        size="small"
        column={1}
        style={{ marginBottom: 16 }}
        items={[{ key: 'user', label: '用户', children: <AdminUserIdentity user={user} /> }]}
      />
      {currentError && (
        <Alert type="error" showIcon title={currentError} style={{ marginBottom: 12 }} />
      )}
      {value && (
        <>
          <Descriptions
            bordered
            size="small"
            column={{ xs: 1, sm: 2 }}
            items={[
              {
                key: 'total',
                label: '可用积分',
                children: `${value.credit.account.available} 积分`,
              },
              {
                key: 'limited',
                label: '限时积分',
                children: `${value.credit.account.limited} 积分`,
              },
              {
                key: 'lasting',
                label: '长期积分',
                children: `${value.credit.account.lasting} 积分`,
              },
              {
                key: 'purchased',
                label: '近 60 天充值',
                children: `${value.credit.purchasedCredits60d} 积分`,
              },
              { key: 'overdraft', label: '当前透支线', children: `${value.credit.overdraft} 积分` },
            ]}
          />
          <div className={styles.usageLegend}>
            <span>最近 {value.charges.length} 笔账单</span>
            <Tag color={value.estimatedRatio > 0 ? 'orange' : 'default'}>
              含估算 {percentOf(value.estimatedRatio)}
            </Tag>
            <Tag color={value.unpricedRatio > 0 ? 'gold' : 'default'}>
              含未定价 {percentOf(value.unpricedRatio)}
            </Tag>
            <span>比例按账单条数计；{creditDenominationLabel}</span>
          </div>
          <Table
            rowKey="generationId"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={value.charges}
            pagination={false}
            scroll={{ x: 1260 }}
            locale={{ emptyText: '这个用户还没有账单' }}
          />
        </>
      )}
      <Modal
        title="冲正账单"
        open={target !== null}
        destroyOnHidden
        confirmLoading={reversing}
        okText="确认冲正"
        onOk={() => form.submit()}
        onCancel={() => {
          setTarget(null);
          form.resetFields();
        }}
      >
        <p>
          整笔退还这次生成消耗的积分：按原积分种类反向、写入操作人与理由，原账单与扣减记录不会被修改。
        </p>
        {target && (
          <p className={styles.statusHint}>
            Generation {target.generationId}，有效金额 {target.effectiveCredits} 积分
          </p>
        )}
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          onFinish={(value) => void submitReversal(value)}
        >
          <Form.Item
            label="冲正理由"
            name="reason"
            rules={[
              { required: true, message: '请填写冲正理由' },
              { max: 500, message: '冲正理由最多 500 字' },
            ]}
          >
            <Input.TextArea
              aria-label="冲正理由"
              rows={3}
              maxLength={500}
              showCount
              placeholder="例如：模型费率配置错误，按错误价格扣费"
            />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}
