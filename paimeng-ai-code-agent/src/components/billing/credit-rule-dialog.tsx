'use client';
import { useCallback, useState } from 'react';
import { App, Form, Input, InputNumber, Modal, Radio, Select } from 'antd';
import { api } from '@/client/api';
import {
  maxMonthlyQuotaCredits,
  quotaPolicySourceLabels,
  type AdminCreditUser,
  type QuotaPolicyAdminView,
  type QuotaPolicySaveReceipt,
  type QuotaPolicyView,
} from '@/shared/billing';
import styles from './credit-page.module.css';

type RuleForm = {
  scope: 'global' | 'user';
  effectivePeriod: string;
  mode: 'inherit' | 'override';
  credits: number;
  note: string;
};

function nextMonths(count: number): string[] {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return Array.from({ length: count }, (_, index) => {
    // 北京时间每月 1 号 00:00 是 UTC 上个月最后一天 16:00；这里只要「下一个月」的标签，按 UTC 月份加一即可。
    const date = new Date(Date.UTC(year, month + index + 1, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

function revisionFor(
  versions: QuotaPolicyView[],
  scope: 'global' | 'user',
  period: string,
): number | null {
  const matching = versions.filter(
    (version) => version.effectivePeriod === period && version.scope === scope,
  );
  return matching.length ? Math.max(...matching.map((version) => version.revision)) : null;
}

/**
 * 改规则：只影响从选定账期开始的每月自动发放，不改已发的月份。
 * 当月要改某个人，用发放弹窗追加条目——规则不追溯。
 */
function RuleFormBody({
  form,
  policy,
  user,
}: {
  form: ReturnType<typeof Form.useForm<RuleForm>>[0];
  policy: QuotaPolicyAdminView | null;
  user: AdminCreditUser | null;
}) {
  const scope = Form.useWatch('scope', form) ?? 'global';
  const mode = Form.useWatch('mode', form) ?? 'override';
  return (
    <>
      <p className={styles.hint}>
        这是一条规则，不是一次发放：保存只影响从这里选的账期开始，不改已发的月份。
      </p>
      <Form form={form} layout="vertical" initialValues={{ scope: 'global', mode: 'override' }}>
        <Form.Item name="scope" label="范围">
          <Radio.Group optionType="button">
            <Radio.Button value="global">全局默认</Radio.Button>
            <Radio.Button value="user" disabled={!user}>
              该用户
            </Radio.Button>
          </Radio.Group>
        </Form.Item>
        {scope === 'user' && (
          <Form.Item name="mode" label="用户规则">
            <Radio.Group optionType="button">
              <Radio.Button value="inherit">继承全局</Radio.Button>
              <Radio.Button value="override">覆盖金额</Radio.Button>
            </Radio.Group>
          </Form.Item>
        )}
        {!(scope === 'user' && mode === 'inherit') && (
          <Form.Item
            name="credits"
            label="每月发放（积分）"
            rules={[{ required: true, message: '请填写金额' }]}
          >
            <InputNumber
              min={0}
              max={maxMonthlyQuotaCredits}
              precision={0}
              style={{ width: '100%' }}
            />
          </Form.Item>
        )}
        <Form.Item
          name="effectivePeriod"
          label="生效账期"
          rules={[{ required: true, message: '请选择生效账期' }]}
        >
          <Select
            options={(policy ? [...new Set([policy.nextPeriod, ...nextMonths(4)])] : []).map(
              (period) => ({ value: period, label: period }),
            )}
          />
        </Form.Item>
        <Form.Item name="note" label="备注（可选）">
          <Input maxLength={500} />
        </Form.Item>
      </Form>
      {user && policy?.user && (
        <p className={styles.hint}>
          该用户当前：{policy.user.current.credits} 积分/月（
          {quotaPolicySourceLabels[policy.user.current.source]}）
        </p>
      )}
    </>
  );
}

export function CreditRuleDialog({
  open,
  user,
  onClose,
  onDone,
}: {
  open: boolean;
  user: AdminCreditUser | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<RuleForm>();
  const [policy, setPolicy] = useState<QuotaPolicyAdminView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const suffix = user ? `?userId=${encodeURIComponent(user.userId)}` : '';
    try {
      const data = await api<QuotaPolicyAdminView>('admin/billing/quota/policy' + suffix);
      setPolicy(data);
      form.setFieldsValue({
        scope: 'global',
        effectivePeriod: data.nextPeriod,
        mode: 'override',
        credits: data.global.next.credits,
        note: '',
      });
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user, form, message]);

  async function submit() {
    if (!policy) return;
    let values: RuleForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    try {
      const versions =
        values.scope === 'global' ? policy.global.versions : (policy.user?.versions ?? []);
      await api<QuotaPolicySaveReceipt>('admin/billing/quota/policy', {
        scope: values.scope,
        userId: values.scope === 'user' ? user?.userId : undefined,
        effectivePeriod: values.effectivePeriod,
        mode: values.scope === 'user' ? values.mode : 'override',
        credits: values.scope === 'user' && values.mode === 'inherit' ? null : values.credits,
        expectedRevision: revisionFor(versions, values.scope, values.effectivePeriod),
        note: values.note || null,
      });
      message.success(`规则已保存，从 ${values.effectivePeriod} 开始生效`);
      onDone();
      onClose();
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="改「每月自动发放的限时积分」"
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={busy || loading}
      okText="保存规则"
      cancelText="取消"
      destroyOnHidden
      afterOpenChange={(next) => {
        // 打开后再取当前规则并回填：一次打开就是一次表单会话，不靠 open 值的副作用。
        if (next) void load();
      }}
    >
      {open && <RuleFormBody form={form} policy={policy} user={user} />}
    </Modal>
  );
}
