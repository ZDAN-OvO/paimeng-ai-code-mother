'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Drawer, Segmented, Space, Tag, Tooltip } from 'antd';
import { api } from '@/client/api';
import {
  adminCreditFilterLabels, adminQuotaStatusLabels, creditDenominationLabel, issueKindLabels,
  type AdminCreditFilter, type AdminCreditOverview, type AdminCreditOverviewItem,
  type AdminUserCreditDetail, type CreditLedgerPage, type IssueKind,
} from '@/shared/billing';
import { formatBeijingTime, formatStoredTime } from '@/shared/display';
import { CreditGrantDialog } from './credit-grant-dialog';
import { CreditLedger } from './credit-ledger';
import { CreditOperationsDrawer } from './credit-operations-drawer';
import { CreditRuleDialog } from './credit-rule-dialog';
import { CreditUserList } from './credit-user-list';
import { AdminUsagePanel } from './admin-usage-panel';
import { ReconcilePanel } from './reconcile-panel';
import styles from './credit-page.module.css';

const pageSize = 50;

/**
 * 积分管理（原型 A：主从账本）。
 *
 * 左边选人，右边回答「这个人为什么是这个数」：余额口径、本期发放与已用、逐条流水。
 * 发放只有两个弹窗，改规则只影响未来账期；批量补发直接幂等执行，没有预览批次。
 */
export function CreditPage() {
  const { message } = App.useApp();
  const [filter, setFilter] = useState<AdminCreditFilter>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const [overview, setOverview] = useState<AdminCreditOverview | null>(null);
  const [stats, setStats] = useState<AdminCreditOverview['stats'] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminUserCreditDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [ledger, setLedger] = useState<CreditLedgerPage>({ entries: [], hasMore: false });
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [grantKind, setGrantKind] = useState<IssueKind | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [chargesOpen, setChargesOpen] = useState(false);
  const [issuing, setIssuing] = useState(false);

  const loadStats = useCallback(async () => {
    const data = await api<AdminCreditOverview>('admin/billing/overview?page=1&pageSize=1&filter=all');
    setStats(data.stats);
  }, []);

  const loadList = useCallback(async () => {
    const token = ++listRequest.current;
    setListLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), filter });
      if (search) params.set('q', search);
      const data = await api<AdminCreditOverview>('admin/billing/overview?' + params.toString());
      // 快速输入会并发多个请求：只让最后一次生效，避免旧结果盖住新筛选。
      if (token === listRequest.current) setOverview(data);
    } catch (problem) {
      if (token === listRequest.current) message.error((problem as Error).message);
    } finally {
      if (token === listRequest.current) setListLoading(false);
    }
  }, [page, filter, search, message]);

  const loadDetail = useCallback(async (userId: string) => {
    const token = ++detailRequest.current;
    setDetailLoading(true);
    try {
      const [data, pageOne] = await Promise.all([
        api<AdminUserCreditDetail>(`admin/billing/user/${encodeURIComponent(userId)}`),
        api<CreditLedgerPage>(`admin/billing/ledger?userId=${encodeURIComponent(userId)}&limit=50`),
      ]);
      if (token !== detailRequest.current) return;
      setDetail(data);
      setLedger(pageOne);
    } catch (problem) {
      if (token === detailRequest.current) {
        message.error((problem as Error).message);
        setDetail(null);
      }
    } finally {
      if (token === detailRequest.current) setDetailLoading(false);
    }
  }, [message]);

  useEffect(() => { void loadStats().catch(() => undefined); }, [loadStats]);
  useEffect(() => {
    // 输入停顿 250ms 再查，避免每个字符都打一次接口。
    const timer = setTimeout(() => { setSearch(query.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    // 列表变了但选中的人不在当前页：优先保留选中，找不到就选第一个。
    if (selectedId && overview?.items.some(item => item.userId === selectedId)) return;
    setSelectedId(overview?.items[0]?.userId ?? null);
  }, [overview, selectedId]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); else setDetail(null); }, [selectedId, loadDetail]);

  async function reloadAll() {
    await Promise.all([loadList(), loadStats(), selectedId ? loadDetail(selectedId) : Promise.resolve()]);
  }

  async function loadMoreLedger() {
    if (!selectedId || ledger.entries.length === 0) return;
    setLedgerLoading(true);
    try {
      const before = ledger.entries[ledger.entries.length - 1]?.id;
      const next = await api<CreditLedgerPage>(
        `admin/billing/ledger?userId=${encodeURIComponent(selectedId)}&limit=50&beforeId=${encodeURIComponent(before ?? '')}`,
      );
      setLedger(current => ({ entries: [...current.entries, ...next.entries], hasMore: next.hasMore }));
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setLedgerLoading(false);
    }
  }

  async function issuePending() {
    setIssuing(true);
    try {
      const receipt = await api<{ operationId: string | null; scanned: number; issued: number; granted: number; zero: number; credits: number }>(
        'admin/billing/issue-pending', { requestId: crypto.randomUUID() },
      );
      message.success(`补发完成：${receipt.issued} 人（正数 ${receipt.granted}，0 积分 ${receipt.zero}），合计 ${receipt.credits} 积分`);
      await reloadAll();
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setIssuing(false);
    }
  }

  const items: AdminCreditOverviewItem[] = overview?.items ?? [];
  const selected = detail?.user ?? items.find(item => item.userId === selectedId) ?? null;
  const pages = overview ? Math.max(1, Math.ceil(overview.total / overview.pageSize)) : 1;

  function switchFilter(next: AdminCreditFilter) {
    setFilter(next);
    setPage(1);
  }

  return <main className={styles.page}>
    <header className={styles.head}>
      <div>
        <h1>积分管理</h1>
        <p>积分是唯一账本：发放、消费、过期、冲正都在一个人的流水里。{creditDenominationLabel}。</p>
      </div>
      <Space wrap className={styles.headActions}>
        <Button onClick={() => setOperationsOpen(true)}>最近操作</Button>
        <Button onClick={() => setReconcileOpen(true)}>补结算</Button>
        <Button type="primary" onClick={() => void issuePending()} loading={issuing}>补发待发</Button>
      </Space>
    </header>

    <section className={styles.statStrip} aria-label="全库概览">
      <button type="button" className={styles.statButton} onClick={() => switchFilter('all')}>
        <span>全库用户</span><b>{stats?.userCount ?? '—'}</b>
      </button>
      <button type="button" className={styles.statButton} onClick={() => switchFilter('pending')}>
        <span>待发</span><b>{stats?.pendingCount ?? '—'}</b>
      </button>
      <button type="button" className={styles.statButton} onClick={() => switchFilter('debt')}>
        <span>欠款</span><b>{stats?.debtorCount ?? '—'}</b>
      </button>
      <div className={styles.statButton}>
        <span>全库可用（限时 / 长期）</span>
        <b>{stats ? `${stats.limitedTotal + stats.lastingTotal}（${stats.limitedTotal} / ${stats.lastingTotal}）` : '—'}</b>
      </div>
      <div className={styles.statButton}>
        <span>本期已发 / 已用</span>
        <b>{stats ? `${stats.issuedTotal} / ${stats.spentTotal}` : '—'}</b>
      </div>
    </section>

    <section className={styles.split}>
      <aside className={styles.listPane} aria-label="用户列表">
        <CreditUserList
          items={items}
          selectedId={selectedId}
          loading={listLoading}
          filter={filter}
          query={query}
          onFilter={switchFilter}
          onQuery={setQuery}
          onSelect={setSelectedId}
        />
        <footer className={styles.listFoot}>
          <span>共 {overview?.total ?? 0} 人{filter !== 'all' ? `（${adminCreditFilterLabels[filter]}）` : ''}</span>
          <span className={styles.pager}>
            <Button size="small" disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>上一页</Button>
            <span>{page} / {pages}</span>
            <Button size="small" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>下一页</Button>
          </span>
        </footer>
      </aside>

      <section className={styles.detailPane} aria-label="用户积分详情">
        {!selected ? <div className={styles.empty}>
          <strong>先从左边选一个人</strong>
          <span>流水会解释他的可用积分是怎么来的。</span>
        </div> : <>
          <div className={styles.detailHead}>
            <div className={styles.detailIdentity}>
              <div>
                <strong>{selected.userAccount}</strong>
                <span>{selected.userName || '未设置用户名'} · {selected.userId}</span>
              </div>
              <Tag color={detail?.account.status === 'pending' ? 'gold' : 'green'}>
                {adminQuotaStatusLabels[detail?.account.status ?? 'pending']}
              </Tag>
            </div>

            <div className={styles.balanceRow}>
              <div className={styles.balanceMain}>
                <span className={styles.hint}>可用积分</span>
                <b className={detail && detail.account.available < 0 ? styles.amountNeg : undefined}>
                  {detail?.account.available ?? '—'}
                </b>
              </div>
              <div className={styles.metrics}>
                <span><i>限时积分</i><b>{detail?.account.limited ?? '—'}</b></span>
                <span><i>到期</i><b>{detail?.account.limitedExpiresAt ? formatBeijingTime(detail.account.limitedExpiresAt) : '—'}</b></span>
                <span><i>长期积分</i><b>{detail?.account.lasting ?? '—'}</b></span>
                <span><i>本期已发</i><b>{detail?.account.issued ?? '—'}</b></span>
                <span><i>本期已用</i><b>{detail?.account.spent ?? '—'}</b></span>
                <span><i>近 60 天充值</i><b>{detail?.purchasedCredits60d ?? '—'}</b></span>
                <span><i>透支线</i><b>{detail?.overdraft ?? '—'}</b></span>
              </div>
            </div>

            <div className={styles.detailActions}>
              <Button type="primary" onClick={() => setGrantKind('limited')}>发放{issueKindLabels.limited}</Button>
              <Button onClick={() => setGrantKind('lasting')}>发放{issueKindLabels.lasting}</Button>
              <Button onClick={() => setRuleOpen(true)}>改规则</Button>
              <Button onClick={() => setChargesOpen(true)}>账单与冲正</Button>
              {detail?.snapshotAnomaly && <Tooltip title={`快照 ${detail.snapshot.available}，账本 ${detail.account.available}`}>
                <Tag color="red">快照与账本不一致</Tag>
              </Tooltip>}
            </div>
            {detail?.account.status === 'pending' && <p className={styles.hint}>
              本月还没有规则发放。规则：每月 {detail.rule.current.credits} 积分（{detail.rule.current.source}）。
            </p>}
          </div>

          <div className={styles.ledgerHead}>
            <strong>流水</strong>
            <span className={styles.statusHint}>按时间倒序，结余是这一行之后的可用积分</span>
            {detail && <span className={styles.statusHint}>最近更新 {formatStoredTime(detail.asOf)}</span>}
          </div>
          <div className={styles.ledgerScroll}>
            <CreditLedger
              entries={ledger.entries}
              loading={detailLoading}
              hasMore={ledger.hasMore}
              onLoadMore={() => void loadMoreLedger()}
            />
            {ledgerLoading && <div className={styles.listState}>加载中…</div>}
          </div>
        </>}
      </section>
    </section>

    <CreditGrantDialog
      open={grantKind !== null}
      kind={grantKind ?? 'limited'}
      user={selected}
      onClose={() => setGrantKind(null)}
      onDone={() => { void reloadAll(); }}
    />
    <CreditRuleDialog open={ruleOpen} user={selected} onClose={() => setRuleOpen(false)} onDone={() => { void reloadAll(); }} />
    <CreditOperationsDrawer open={operationsOpen} onClose={() => setOperationsOpen(false)} />
    <Drawer title="补结算与核对" open={reconcileOpen} onClose={() => setReconcileOpen(false)} size={1200} destroyOnHidden>
      <ReconcilePanel embedded />
    </Drawer>
    <Drawer
      title="账单与冲正"
      open={chargesOpen && selected !== null}
      onClose={() => setChargesOpen(false)}
      size={1080}
      destroyOnHidden
    >
      {selected && <AdminUsagePanel user={selected} />}
    </Drawer>
  </main>;
}

