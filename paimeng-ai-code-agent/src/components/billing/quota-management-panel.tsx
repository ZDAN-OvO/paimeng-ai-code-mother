'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Descriptions, Form, Input, InputNumber, Modal, Select, Table, Tag } from 'antd';
import { api } from '@/client/api';
import {
  adminQuotaStatusLabels, maxMonthlyQuotaCredits, quotaAdjustmentModeLabels, quotaPolicyModeLabels, quotaPolicySourceLabels,
  type AdminCreditOverview, type AdminCreditOverviewItem, type AdminCreditUser, type QuotaAdjustmentMode, type QuotaAdjustmentReceipt,
  type QuotaPolicyAdminView, type QuotaPolicySaveReceipt, type QuotaPolicyView,
} from '@/shared/billing';
import { formatStoredTime } from '@/shared/display';
import { AdminUserIdentity } from './admin-credit-overview';
import { UserSearchSelect } from './user-search-select';
import styles from '@/components/admin-view.module.css';

type PolicyForm = { effectivePeriod: string; mode?: 'inherit' | 'override'; credits?: number; note?: string };
type AdjustForm = { mode: QuotaAdjustmentMode; amount: number; reason: string };

/** 同一账期已有版本时取最大 revision；没有则 null，服务端据此判断「新建」还是「替换」。 */
function revisionFor(versions: QuotaPolicyView[], effectivePeriod: string): number | null {
  const matching = versions.filter(version => version.effectivePeriod === effectivePeriod);
  return matching.length ? Math.max(...matching.map(version => version.revision)) : null;
}

function effectiveText(effective: { credits: number; source: keyof typeof quotaPolicySourceLabels; version: number | null }) {
  return `${effective.credits} Credit（${quotaPolicySourceLabels[effective.source]}${effective.version === null ? '' : ` · v${effective.version}`}）`;
}

/**
 * 配额管理：全局默认与用户覆盖的未来策略、当前账期发放状态、待发名单。
 * 策略只改未来账期；当月改剩余属于 C3 的单用户调整，本页不提供追溯修改。
 */
export function QuotaManagementPanel({ onSelect }: { onSelect: (user: AdminCreditUser) => void }) {
  const { message } = App.useApp();
  const [overview, setOverview] = useState<AdminCreditOverview | null>(null);
  const [pending, setPending] = useState<AdminCreditOverview | null>(null);
  const [policy, setPolicy] = useState<QuotaPolicyAdminView | null>(null);
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'global' | 'user' | 'adjust' | null>(null);
  const [globalForm] = Form.useForm<PolicyForm>();
  const [userForm] = Form.useForm<PolicyForm>();
  const [adjustForm] = Form.useForm<AdjustForm>();
  const userMode = Form.useWatch('mode', userForm);
  const adjustMode = Form.useWatch('mode', adjustForm);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [adjustReceipt, setAdjustReceipt] = useState<QuotaAdjustmentReceipt | null>(null);
  const [pendingAdjust, setPendingAdjust] = useState<AdjustForm | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const suffix = userId ? `?userId=${encodeURIComponent(userId)}` : '';
      const [allUsers, pendingUsers, policyView] = await Promise.all([
        api<AdminCreditOverview>('admin/billing/overview?page=1&pageSize=1&filter=all&sort=id_desc'),
        api<AdminCreditOverview>('admin/billing/overview?page=1&pageSize=20&filter=pending&sort=id_desc'),
        api<QuotaPolicyAdminView>('admin/billing/quota/policy' + suffix),
      ]);
      setOverview(allUsers);
      setPending(pendingUsers);
      setPolicy(policyView);
      setError(null);
      globalForm.setFieldsValue({
        effectivePeriod: policyView.nextPeriod,
        credits: policyView.global.next.credits,
        note: '',
      });
      if (policyView.user) {
        userForm.setFieldsValue({
          effectivePeriod: policyView.nextPeriod,
          mode: policyView.user.next.source === 'user' ? 'override' : 'inherit',
          credits: policyView.user.next.source === 'user' ? policyView.user.next.credits : policyView.global.next.credits,
          note: '',
        });
      }
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setLoading(false);
    }
  }, [globalForm, userForm, userId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // 换用户就换一次调整意图键，避免把上一个用户的 requestId 带进新载荷。
    setRequestId(crypto.randomUUID());
    setAdjustReceipt(null);
    setPendingAdjust(null);
    adjustForm.resetFields();
  }, [adjustForm, userId]);

  async function submitGlobal(values: PolicyForm) {
    if (!policy) return;
    setSaving('global');
    try {
      const receipt = await api<QuotaPolicySaveReceipt>('admin/billing/quota/policy', {
        scope: 'global',
        effectivePeriod: values.effectivePeriod,
        mode: 'override',
        credits: values.credits,
        expectedRevision: revisionFor(policy.global.versions, values.effectivePeriod),
        note: values.note ?? null,
      });
      message.success(`已保存全局策略 v${receipt.policy.revision}，${values.effectivePeriod} 起生效`);
      await load();
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setSaving(null);
    }
  }

  async function submitUser(values: PolicyForm) {
    if (!policy?.user) return;
    setSaving('user');
    try {
      const receipt = await api<QuotaPolicySaveReceipt>('admin/billing/quota/policy', {
        scope: 'user',
        userId: policy.user.userId,
        effectivePeriod: values.effectivePeriod,
        mode: values.mode ?? 'inherit',
        credits: values.mode === 'inherit' ? null : values.credits,
        expectedRevision: revisionFor(policy.user.versions, values.effectivePeriod),
        note: values.note ?? null,
      });
      message.success(`已保存用户策略 v${receipt.policy.revision}；${receipt.effective.credits} Credit（${quotaPolicySourceLabels[receipt.effective.source]}）`);
      await load();
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setSaving(null);
    }
  }

  function calcAdjust(before: number, values: AdjustForm): { before: number; delta: number; after: number } {
    const delta = values.mode === 'increase' ? values.amount : values.mode === 'decrease' ? -values.amount : values.amount - before;
    return { before, delta, after: before + delta };
  }

  function submitAdjust(values: AdjustForm) {
    if (!policy?.user) return;
    const preview = calcAdjust(policy.user.quota.remainingCredits, values);
    if (preview.after < 0) {
      message.error(`扣回后配额会变成 ${preview.after}，不能超过当前有效剩余 ${preview.before}`);
      return;
    }
    if (preview.delta === 0) {
      message.error('调整后剩余与当前相同，无需调整');
      return;
    }
    setPendingAdjust(values);
    setAdjustReceipt(null);
  }

  async function confirmAdjust() {
    if (!policy?.user || !pendingAdjust) return;
    setSaving('adjust');
    try {
      const receipt = await api<QuotaAdjustmentReceipt>('admin/billing/quota/adjust', {
        userId: policy.user.userId,
        mode: pendingAdjust.mode,
        amount: pendingAdjust.amount,
        reason: pendingAdjust.reason,
        requestId,
      });
      setAdjustReceipt(receipt);
      setPendingAdjust(null);
      setRequestId(crypto.randomUUID());
      adjustForm.resetFields();
      message.success(receipt.created
        ? `已调整：${receipt.beforeCredits} → ${receipt.afterCredits} Credit`
        : '这次请求之前已经调整过，没有重复变更');
      await load();
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setSaving(null);
    }
  }

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!overview || !pending || !policy) return <p className={styles.statusHint}>正在读取配额策略…</p>;
  const issued = overview.stats.userCount - pending.stats.pendingCount;
  const pendingPreview = policy.user && pendingAdjust
    ? calcAdjust(policy.user.quota.remainingCredits, pendingAdjust)
    : null;
  return <section aria-label="配额管理">
    <div className={styles.sectionHeading}>
      <h2>月度配额策略</h2>
      <span className={styles.statusHint}>
        策略只从未来账期生效；当月改剩余请走单用户调整。没有保存过全局策略时按 500 Credit 兜底
      </span>
    </div>
    <div className={styles.overviewStats} aria-label="策略概览">
      <Stat label="当前账期默认" value={effectiveText(policy.global.current)} hint={`${policy.period} · 当前用户实际领取标准`} />
      <Stat label="下一账期默认" value={effectiveText(policy.global.next)} hint={`${policy.nextPeriod} 起生效`} />
      <Stat label="本月已发人数" value={String(issued)} hint={`全库未删除用户 ${overview.stats.userCount} 人`} />
      <Stat label="本月配额剩余总量" value={`${overview.stats.quotaRemainingTotal} Credit`} hint="仅当前账期有效配额" />
      <Stat label="余额池净额" value={`${overview.stats.balanceNetTotal} Credit`} hint="负数代表净欠款" />
    </div>

    <div className={styles.sectionHeading}>
      <h2>全局默认策略</h2>
      <span className={styles.statusHint}>保存后只影响目标账期及以后，不改已发月份</span>
    </div>
    <Form form={globalForm} layout="vertical" onFinish={submitGlobal} className={styles.policyForm}>
      <Form.Item label="生效账期" name="effectivePeriod" rules={[
        { required: true, message: '请填写生效账期' },
        { pattern: /^\d{4}-(0[1-9]|1[0-2])$/u, message: '账期必须形如 2026-12' },
      ]}>
        <Input aria-label="全局生效账期" placeholder="2026-12" />
      </Form.Item>
      <Form.Item label="每月基础配额（Credit）" name="credits" rules={[{ required: true, message: '请填写配额' }]}>
        <InputNumber aria-label="全局每月基础配额" min={0} max={maxMonthlyQuotaCredits} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item label="备注" name="note">
        <Input aria-label="全局策略备注" maxLength={500} placeholder="可空，会记入版本记录" />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={saving === 'global'}>保存全局策略</Button>
      </Form.Item>
    </Form>

    <div className={styles.sectionHeading}>
      <h2>单用户覆盖</h2>
      <span className={styles.statusHint}>覆盖为 0 与「继承全局」是两种事实；清除覆盖后回落全局默认</span>
    </div>
    <div className={styles.policyUserPicker}>
      <UserSearchSelect value={userId} onChange={(next) => setUserId(next)} ariaLabel="选择配额策略用户" placeholder="搜索账号、用户名或粘贴用户 ID" />
      {policy.user && <AdminUserIdentity user={policy.user} />}
    </div>
    {policy.user && <>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} style={{ marginBottom: 12 }} items={[
        { key: 'current', label: '当前账期有效规则', children: effectiveText(policy.user.current) },
        { key: 'next', label: '下一账期有效规则', children: effectiveText(policy.user.next) },
        { key: 'remaining', label: '当前有效剩余', children: `${policy.user.quota.remainingCredits} Credit（基础 ${policy.user.quota.baseCredits} + 调整 ${policy.user.quota.adjustmentCredits} − 已用 ${policy.user.quota.usedCredits}）` },
        { key: 'expires', label: '配额到期', children: policy.user.quota.expiresAt },
      ]} />
      <Form form={userForm} layout="vertical" onFinish={submitUser} className={styles.policyForm}>
        <Form.Item label="生效账期" name="effectivePeriod" rules={[
          { required: true, message: '请填写生效账期' },
          { pattern: /^\d{4}-(0[1-9]|1[0-2])$/u, message: '账期必须形如 2026-12' },
        ]}>
          <Input aria-label="用户生效账期" placeholder="2026-12" />
        </Form.Item>
        <Form.Item label="规则" name="mode" rules={[{ required: true, message: '请选择规则' }]}>
          <Select aria-label="用户规则" options={[
            { value: 'inherit', label: quotaPolicyModeLabels.inherit },
            { value: 'override', label: quotaPolicyModeLabels.override },
          ]} />
        </Form.Item>
        {userMode !== 'inherit' && <Form.Item label="每月基础配额（Credit）" name="credits" rules={[{ required: true, message: '请填写配额' }]}>
          <InputNumber aria-label="用户每月基础配额" min={0} max={maxMonthlyQuotaCredits} style={{ width: '100%' }} />
        </Form.Item>}
        <Form.Item label="备注" name="note">
          <Input aria-label="用户策略备注" maxLength={500} placeholder="可空，例如：VIP 客户 / 暂停发放" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving === 'user'}>保存用户策略</Button>
        </Form.Item>
      </Form>
      <div className={styles.sectionHeading}>
        <h2>当月剩余调整</h2>
        <span className={styles.statusHint}>只改当前月有效剩余，不改下月标准；理由必填，支持同键重试幂等</span>
      </div>
      <Form form={adjustForm} layout="vertical" onFinish={submitAdjust} className={styles.policyForm}>
        <Form.Item label="调整方式" name="mode" initialValue="increase" rules={[{ required: true, message: '请选择调整方式' }]}>
          <Select aria-label="调整方式" options={[
            { value: 'increase', label: '增加当月剩余' },
            { value: 'decrease', label: '扣回当月剩余' },
            { value: 'target', label: '设为目标剩余' },
          ]} />
        </Form.Item>
        <Form.Item label={adjustMode === 'target' ? '目标剩余（Credit）' : '调整金额（Credit）'} name="amount" rules={[{ required: true, message: '请填写金额' }]}>
          <InputNumber aria-label="调整金额" min={adjustMode === 'target' ? 0 : 1} max={policy.limits.maxQuotaAdjustmentCredits} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="调整理由" name="reason" rules={[{ required: true, message: '请填写调整理由' }, { max: 500, message: '理由最多 500 字' }]}>
          <Input aria-label="调整理由" maxLength={500} placeholder="例如：按投诉补偿 / 修正误发" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving === 'adjust'}>确认调整</Button>
        </Form.Item>
      </Form>
      {adjustReceipt && <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} style={{ marginTop: 12 }} items={[
        { key: 'created', label: '是否本次新增', children: adjustReceipt.created ? '是' : '否（重放，未重复变更）' },
        { key: 'period', label: '账期', children: adjustReceipt.period },
        { key: 'before', label: '调整前剩余', children: `${adjustReceipt.beforeCredits} Credit` },
        { key: 'delta', label: '调整差额', children: `${adjustReceipt.adjustment.credits} Credit` },
        { key: 'after', label: '调整后剩余', children: `${adjustReceipt.afterCredits} Credit` },
        { key: 'expires', label: '到期', children: adjustReceipt.expiresAt },
        { key: 'reason', label: '理由', children: adjustReceipt.adjustment.reason },
        { key: 'operator', label: '操作人', children: adjustReceipt.adjustment.operatorId },
      ]} />}
      <PolicyVersions versions={policy.user.versions} title="这个用户的未来策略版本" />
    </>}
    {!policy.user && <p className={styles.statusHint}>先搜索并选中一个用户，才能查看或设置单用户覆盖。</p>}

    <PolicyVersions versions={policy.global.versions} title="全局未来策略版本" />

    <div className={styles.sectionHeading}>
      <h2>本月发放与待发</h2>
      <span className={styles.statusHint}>已发/待发按 issue 事实判断；0 配额发放成功也显示为已发</span>
    </div>
    <Table<AdminCreditOverviewItem>
      rowKey="userId"
      size="small"
      loading={loading}
      dataSource={pending.items}
      pagination={false}
      scroll={{ x: 820 }}
      locale={{ emptyText: '当前没有待发用户' }}
      onRow={(row) => ({ onClick: () => onSelect({ userId: row.userId, userAccount: row.userAccount, userName: row.userName }), style: { cursor: 'pointer' } })}
      columns={[
        { title: '用户', key: 'user', width: 320, render: (_, row) => <AdminUserIdentity user={row} /> },
        { title: '账期', dataIndex: 'period', width: 100 },
        { title: '配额状态', dataIndex: 'issueStatus', width: 120, render: (value: AdminCreditOverviewItem['issueStatus']) => <Tag color={value === 'granted' ? 'green' : value === 'failed' ? 'red' : 'gold'}>{adminQuotaStatusLabels[value]}</Tag> },
        { title: '基础已发', dataIndex: 'quotaBase', width: 110, render: (value: number) => `${value} Credit` },
        { title: '当前剩余', dataIndex: 'quotaRemaining', width: 110, render: (value: number) => `${value} Credit` },
        { title: '余额池', dataIndex: 'balance', width: 110, render: (value: number) => `${value} Credit` },
      ]}
    />
    <Modal
      title="确认调整当月配额"
      open={pendingAdjust !== null}
      onCancel={() => setPendingAdjust(null)}
      onOk={() => void confirmAdjust()}
      okText="确认调整"
      cancelText="取消"
      confirmLoading={saving === 'adjust'}
      okButtonProps={{ disabled: !pendingPreview || pendingPreview.after < 0 || pendingPreview.delta === 0 }}
      destroyOnHidden
    >
      {policy.user && pendingAdjust && pendingPreview && <>
        <Descriptions bordered size="small" column={1} items={[
          { key: 'user', label: '用户', children: <AdminUserIdentity user={policy.user} /> },
          { key: 'period', label: '账期', children: policy.period },
          { key: 'mode', label: '调整方式', children: quotaAdjustmentModeLabels[pendingAdjust.mode] },
          { key: 'before', label: '当前有效剩余', children: `${pendingPreview.before} Credit` },
          { key: 'delta', label: '调整差额', children: `${pendingPreview.delta} Credit` },
          { key: 'after', label: '调整后剩余', children: `${pendingPreview.after} Credit` },
          { key: 'expires', label: '到期', children: policy.user.quota.expiresAt },
          { key: 'reason', label: '理由', children: pendingAdjust.reason },
        ]} />
        <p className={styles.statusHint}>只改当前月剩余，不改下月标准；结束时以服务端重算结果为准。</p>
      </>}
    </Modal>
  </section>;
}

function PolicyVersions({ versions, title }: { versions: QuotaPolicyView[]; title: string }) {
  return <>
    <div className={styles.sectionHeading}>
      <h2>{title}</h2>
      <span className={styles.statusHint}>只追加版本；相同账期 revision 越大越新</span>
    </div>
    <Table<QuotaPolicyView>
      rowKey="id"
      size="small"
      dataSource={versions}
      pagination={false}
      scroll={{ x: 860 }}
      locale={{ emptyText: '还没有保存过未来策略版本' }}
      columns={[
        { title: '账期', dataIndex: 'effectivePeriod', width: 100 },
        { title: '规则', dataIndex: 'mode', width: 130, render: (value: QuotaPolicyView['mode']) => quotaPolicyModeLabels[value] },
        { title: '金额', dataIndex: 'credits', width: 110, render: (value: number | null) => value === null ? '继承全局' : `${value} Credit` },
        { title: '版本', dataIndex: 'revision', width: 80, render: (value: number) => `v${value}` },
        { title: '操作人', dataIndex: 'createdBy', width: 140, render: (value: string | null) => value ?? '系统' },
        { title: '时间', dataIndex: 'createTime', width: 160, render: (value: string) => formatStoredTime(value) },
        { title: '备注', dataIndex: 'note', render: (value: string | null) => value ?? '—' },
      ]}
    />
  </>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className={styles.statCard}>
    <span className={styles.statLabel}>{label}</span>
    <strong>{value}</strong>
    <span className={styles.statusHint}>{hint}</span>
  </div>;
}
