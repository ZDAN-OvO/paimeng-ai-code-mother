'use client';
import { useState } from 'react';
import { App, Button, Descriptions, Form, Input, InputNumber, Select, Tag } from 'antd';
import { api } from '@/client/api';
import { formatStoredTime } from '@/shared/display';
import {
  grantSources, maxGrantCredits, poolLabels, sourceLabels,
  type AdminCreditUser, type GrantReceipt, type GrantSource,
} from '@/shared/billing';
import { AdminUserIdentity } from './admin-credit-overview';
import styles from '@/components/admin-view.module.css';

type GrantForm = { source: GrantSource; credits: number; note?: string };

/** 月度配额按账期发放，管理界面的余额入口只允许购买与补偿。 */
const grantOptions = grantSources
  .filter(source => source !== 'monthly_quota')
  .map(source => ({ value: source, label: sourceLabels[source] }));

/**
 * 余额池发放：购买计入透支基数，管理员补偿不计入；两者都进入余额池。
 * 用户身份由外部选择后传入，表单提交仍然只送用户 ID。
 */
export function GrantPanel({ user }: { user: AdminCreditUser }) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<GrantReceipt | null>(null);
  // 幂等键跟着「一次发放意图」走：表单重试与双击复用同一个 requestId，成功入账后才换新的。
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  async function submit(values: GrantForm) {
    setBusy(true);
    try {
      const result = await api<GrantReceipt>('admin/billing/grant', { ...values, userId: user.userId, requestId });
      setReceipt(result);
      setRequestId(crypto.randomUUID());
      message.success(result.created ? '发放成功' : '这次请求之前已经入账，没有重复发放');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label="发放余额">
    <div className={styles.sectionHeading}>
      <h2>发放余额</h2>
      <span className={styles.statusHint}>购买计入透支基数，管理员补偿不计入；两者都进入余额池</span>
    </div>
    <Descriptions bordered size="small" column={1} style={{ marginBottom: 16 }} items={[
      { key: 'user', label: '发放对象', children: <AdminUserIdentity user={user} /> },
    ]} />
    <Form name="billing-grant" layout="vertical" onFinish={submit}>
      <Form.Item label="来源" name="source" initialValue="purchase" rules={[{ required: true, message: '请选择来源' }]}>
        <Select aria-label="来源" options={grantOptions} />
      </Form.Item>
      <Form.Item label="金额（Credit）" name="credits" rules={[{ required: true, message: '请输入发放金额' }]}>
        <InputNumber aria-label="发放金额" min={1} max={maxGrantCredits} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item label="备注" name="note">
        <Input.TextArea aria-label="备注" placeholder="可空，会记入发放记录" maxLength={500} rows={2} showCount />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>发放</Button>
      </Form.Item>
    </Form>
    {receipt && <>
      <div className={styles.sectionHeading}>
        <h2>最近一次发放</h2>
        <Tag color={receipt.created ? 'green' : 'default'}>{receipt.created ? '已入账' : '重放，未重复入账'}</Tag>
      </div>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
        { key: 'id', label: 'Grant ID', children: receipt.grant.id },
        { key: 'createTime', label: '入账时间', children: formatStoredTime(receipt.grant.createTime) },
        { key: 'userId', label: '用户 ID', children: receipt.grant.userId },
        { key: 'grantedBy', label: '操作人', children: receipt.grant.grantedBy ?? '系统' },
        { key: 'source', label: '来源', children: sourceLabels[receipt.grant.source] },
        { key: 'pool', label: '入账池', children: poolLabels[receipt.grant.pool] },
        { key: 'credits', label: '金额', children: `${receipt.grant.credits} Credit` },
        { key: 'note', label: '备注', children: receipt.grant.note ?? '无' },
      ]} />
    </>}
  </section>;
}
