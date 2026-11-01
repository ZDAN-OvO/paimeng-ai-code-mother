'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Descriptions, Form, Input, InputNumber, Select, Table, Tag } from 'antd';
import { api } from '@/client/api';
import {
  adminQuotaStatusLabels, maxMonthlyQuotaCredits, quotaPolicyModeLabels, quotaPolicySourceLabels,
  type AdminCreditOverview, type AdminCreditOverviewItem, type AdminCreditUser,
  type QuotaPolicyAdminView, type QuotaPolicySaveReceipt, type QuotaPolicyView,
} from '@/shared/billing';
import { formatStoredTime } from '@/shared/display';
import { AdminUserIdentity } from './admin-credit-overview';
import { UserSearchSelect } from './user-search-select';
import styles from '@/components/admin-view.module.css';

type PolicyForm = { effectivePeriod: string; mode?: 'inherit' | 'override'; credits?: number; note?: string };

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
  const [saving, setSaving] = useState<'global' | 'user' | null>(null);
  const [globalForm] = Form.useForm<PolicyForm>();
  const [userForm] = Form.useForm<PolicyForm>();
  const userMode = Form.useWatch('mode', userForm);

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

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!overview || !pending || !policy) return <p className={styles.statusHint}>正在读取配额策略…</p>;
  const issued = overview.stats.userCount - pending.stats.pendingCount;
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
