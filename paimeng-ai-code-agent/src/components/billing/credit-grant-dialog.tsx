'use client';
import { useEffect, useState } from 'react';
import { App, Button, Form, Input, InputNumber, Modal } from 'antd';
import { api } from '@/client/api';
import {
  issueKindLabels, maxIssueCredits,
  type AdminCreditUser, type AdminIssueReceipt, type IssueKind,
} from '@/shared/billing';
import styles from './credit-page.module.css';

const quickAmounts = [100, 500, 1000, 5000];

type GrantForm = { credits: number; reason: string };

/**
 * 发放弹窗：限时与长期共用一套表单，管理员只填数量与理由。
 * 确认后账本追加一条条目——没有预览批次，也没有第二步。
 */
export function CreditGrantDialog({ open, kind, user, onClose, onDone }: {
  open: boolean;
  kind: IssueKind;
  user: AdminCreditUser | null;
  onClose: () => void;
  onDone: (receipt: AdminIssueReceipt) => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<GrantForm>();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRequestId(crypto.randomUUID());
    form.resetFields();
    form.setFieldsValue({ credits: kind === 'limited' ? 500 : 100, reason: '' });
  }, [open, kind, form]);

  async function submit() {
    if (!user) return;
    let values: GrantForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    try {
      const receipt = await api<AdminIssueReceipt>('admin/billing/issue', {
        userId: user.userId,
        kind,
        credits: values.credits,
        reason: values.reason.trim(),
        requestId,
      });
      message.success(`已发放 ${values.credits} ${issueKindLabels[kind]}给 ${user.userAccount}`);
      onDone(receipt);
      onClose();
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <Modal
    open={open}
    title={`发放${issueKindLabels[kind]}`}
    onCancel={onClose}
    onOk={() => void submit()}
    confirmLoading={busy}
    okText="确认发放"
    cancelText="取消"
    destroyOnHidden
  >
    <p className={styles.dialogSubject}>{user ? `${user.userAccount}（${user.userName || '未设置用户名'}）` : ''}</p>
    <Form form={form} layout="vertical" onFinish={() => void submit()}>
      <Form.Item name="credits" label="数量（积分）" rules={[{ required: true, message: '请填写数量' }]}>
        <InputNumber
          min={1}
          max={maxIssueCredits}
          precision={0}
          style={{ width: '100%' }}
          onPressEnter={() => void submit()}
          autoFocus
        />
      </Form.Item>
      <div className={styles.quick}>
        {quickAmounts.map(value => <Button key={value} size="small" onClick={() => form.setFieldValue('credits', value)}>{value.toLocaleString()}</Button>)}
      </div>
      <Form.Item name="reason" label="理由（写进流水）" rules={[{ required: true, message: '请填写理由' }]} style={{ marginTop: 16 }}>
        <Input maxLength={500} placeholder="例如：客诉补偿 / 活动赠送" onPressEnter={() => void submit()} />
      </Form.Item>
      <p className={styles.hint}>
        {kind === 'limited'
          ? '记在当前账期，月底（北京时间 1 号 00:00）随账期一起过期，不结转。'
          : '长期积分不过期，扣减时先扣限时积分，扣完才动这里。'}
      </p>
    </Form>
  </Modal>;
}
