'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Drawer, Space, Tag, Tooltip } from 'antd';
import { api } from '@/client/api';
import {
  adminCreditFilterLabels,
  adminQuotaStatusLabels,
  creditDenominationLabel,
  issueKindLabels,
  type AdminCreditFilter,
  type AdminCreditOverview,
  type AdminCreditOverviewItem,
  type AdminUserCreditDetail,
  type CreditLedgerPage,
  type IssueKind,
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
  // 列表/详情都连同「属于哪次查询、哪个人」一起存：旧响应不显示，也不需要先清空的副作用。
  const [overview, setOverview] = useState<{ key: string; data: AdminCreditOverview } | null>(null);
  const [listFailed, setListFailed] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminCreditOverview['stats'] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ userId: string; value: AdminUserCreditDetail } | null>(
    null,
  );
  const [detailFailed, setDetailFailed] = useState<string | null>(null);
  const [ledger, setLedger] = useState<{ userId: string; page: CreditLedgerPage } | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [grantKind, setGrantKind] = useState<IssueKind | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [chargesOpen, setChargesOpen] = useState(false);
  const [issuing, setIssuing] = useState(false);

  const listKey = `${page}|${filter}|${search}`;

  const loadStats = useCallback(async () => {
    const data = await api<AdminCreditOverview>(
      'admin/billing/overview?page=1&pageSize=1&filter=all',
    );
    setStats(data.stats);
  }, []);

  const loadList = useCallback(async () => {
    const token = ++listRequest.current;
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      filter,
    });
    if (search) params.set('q', search);
    const data = await api<AdminCreditOverview>('admin/billing/overview?' + params.toString());
    // 快速输入会并发多个请求：只让最后一次生效，避免旧结果盖住新筛选。
    if (token === listRequest.current) {
      setOverview({ key: listKey, data });
      setListFailed(null);
    }
  }, [page, filter, search, listKey]);

  const loadDetail = useCallback(async (userId: string) => {
    const token = ++detailRequest.current;
    const [data, pageOne] = await Promise.all([
      api<AdminUserCreditDetail>(`admin/billing/user/${encodeURIComponent(userId)}`),
      api<CreditLedgerPage>(`admin/billing/ledger?userId=${encodeURIComponent(userId)}&limit=50`),
    ]);
    if (token === detailRequest.current) {
      setDetail({ userId, value: data });
      setLedger({ userId, page: pageOne });
      setDetailFailed(null);
    }
  }, []);

  useEffect(() => {
    let live = true;
    api<AdminCreditOverview>('admin/billing/overview?page=1&pageSize=1&filter=all')
      .then((data) => {
        if (live) setStats(data.stats);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    // 输入停顿 250ms 再查，避免每个字符都打一次接口。
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const token = ++listRequest.current;
    let live = true;
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      filter,
    });
    if (search) params.set('q', search);
    api<AdminCreditOverview>('admin/billing/overview?' + params.toString())
      .then((data) => {
        if (!live || token !== listRequest.current) return;
        setOverview({ key: listKey, data });
        setListFailed(null);
      })
      .catch((problem: unknown) => {
        if (!live || token !== listRequest.current) return;
        message.error((problem as Error).message);
        setListFailed(listKey);
      });
    return () => {
      live = false;
    };
  }, [listKey, page, filter, search, message]);

  // 选中的人优先保留；他不在当前页时退回到第一个——由渲染期推导，不再用副作用改状态。
  const listData = overview?.key === listKey ? overview.data : null;
  const items: AdminCreditOverviewItem[] = listData?.items ?? [];
  const activeId =
    selectedId && items.some((item) => item.userId === selectedId)
      ? selectedId
      : (items[0]?.userId ?? null);
  const detailValue = activeId && detail?.userId === activeId ? detail.value : null;
  const ledgerPage =
    activeId && ledger?.userId === activeId ? ledger.page : { entries: [], hasMore: false };
  const listPending = listLoading || (!listData && listFailed !== listKey);
  const detailPending = activeId !== null && !detailValue && detailFailed !== activeId;

  useEffect(() => {
    if (!activeId) return;
    const token = ++detailRequest.current;
    let live = true;
    Promise.all([
      api<AdminUserCreditDetail>(`admin/billing/user/${encodeURIComponent(activeId)}`),
      api<CreditLedgerPage>(`admin/billing/ledger?userId=${encodeURIComponent(activeId)}&limit=50`),
    ])
      .then(([data, pageOne]) => {
        if (!live || token !== detailRequest.current) return;
        setDetail({ userId: activeId, value: data });
        setLedger({ userId: activeId, page: pageOne });
        setDetailFailed(null);
      })
      .catch((problem: unknown) => {
        if (!live || token !== detailRequest.current) return;
        message.error((problem as Error).message);
        setDetailFailed(activeId);
      });
    return () => {
      live = false;
    };
  }, [activeId, message]);

  async function reloadAll() {
    setListLoading(true);
    try {
      await Promise.all([
        loadList(),
        loadStats(),
        activeId ? loadDetail(activeId) : Promise.resolve(),
      ]);
    } finally {
      setListLoading(false);
    }
  }

  async function loadMoreLedger() {
    const userId = activeId;
    if (!userId || ledgerPage.entries.length === 0) return;
    setLedgerLoading(true);
    try {
      const before = ledgerPage.entries[ledgerPage.entries.length - 1]?.id;
      const next = await api<CreditLedgerPage>(
        `admin/billing/ledger?userId=${encodeURIComponent(userId)}&limit=50&beforeId=${encodeURIComponent(before ?? '')}`,
      );
      // 迟到的翻页只能追加到它自己的用户：切人后旧页不能混进新流水。
      setLedger((current) =>
        current?.userId === userId
          ? {
              userId,
              page: {
                entries: [...current.page.entries, ...next.entries],
                hasMore: next.hasMore,
              },
            }
          : current,
      );
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setLedgerLoading(false);
    }
  }

  async function issuePending() {
    setIssuing(true);
    try {
      const receipt = await api<{
        operationId: string | null;
        scanned: number;
        issued: number;
        granted: number;
        zero: number;
        credits: number;
      }>('admin/billing/issue-pending', { requestId: crypto.randomUUID() });
      message.success(
        `补发完成：${receipt.issued} 人（正数 ${receipt.granted}，0 积分 ${receipt.zero}），合计 ${receipt.credits} 积分`,
      );
      await reloadAll();
    } catch (problem) {
      message.error((problem as Error).message);
    } finally {
      setIssuing(false);
    }
  }

  const selected = detailValue?.user ?? items.find((item) => item.userId === activeId) ?? null;
  const pages = listData ? Math.max(1, Math.ceil(listData.total / listData.pageSize)) : 1;

  function switchFilter(next: AdminCreditFilter) {
    setFilter(next);
    setPage(1);
  }

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <div>
          <h1>积分管理</h1>
          <p>
            积分是唯一账本：发放、消费、过期、冲正都在一个人的流水里。{creditDenominationLabel}。
          </p>
        </div>
        <Space wrap className={styles.headActions}>
          <Button onClick={() => setOperationsOpen(true)}>最近操作</Button>
          <Button onClick={() => setReconcileOpen(true)}>补结算</Button>
          <Button type="primary" onClick={() => void issuePending()} loading={issuing}>
            补发待发
          </Button>
        </Space>
      </header>

      <section className={styles.statStrip} aria-label="全库概览">
        <button type="button" className={styles.statButton} onClick={() => switchFilter('all')}>
          <span>全库用户</span>
          <b>{stats?.userCount ?? '—'}</b>
        </button>
        <button type="button" className={styles.statButton} onClick={() => switchFilter('pending')}>
          <span>待发</span>
          <b>{stats?.pendingCount ?? '—'}</b>
        </button>
        <button type="button" className={styles.statButton} onClick={() => switchFilter('debt')}>
          <span>欠款</span>
          <b>{stats?.debtorCount ?? '—'}</b>
        </button>
        <div className={styles.statButton}>
          <span>全库可用（限时 / 长期）</span>
          <b>
            {stats
              ? `${stats.limitedTotal + stats.lastingTotal}（${stats.limitedTotal} / ${stats.lastingTotal}）`
              : '—'}
          </b>
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
            selectedId={activeId}
            loading={listPending}
            filter={filter}
            query={query}
            onFilter={switchFilter}
            onQuery={setQuery}
            onSelect={setSelectedId}
          />
          <footer className={styles.listFoot}>
            <span>
              共 {listData?.total ?? 0} 人
              {filter !== 'all' ? `（${adminCreditFilterLabels[filter]}）` : ''}
            </span>
            <span className={styles.pager}>
              <Button
                size="small"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <span>
                {page} / {pages}
              </span>
              <Button
                size="small"
                disabled={page >= pages}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </Button>
            </span>
          </footer>
        </aside>

        <section className={styles.detailPane} aria-label="用户积分详情">
          {!selected ? (
            <div className={styles.empty}>
              <strong>先从左边选一个人</strong>
              <span>流水会解释他的可用积分是怎么来的。</span>
            </div>
          ) : (
            <>
              <div className={styles.detailHead}>
                <div className={styles.detailIdentity}>
                  <div>
                    <strong>{selected.userAccount}</strong>
                    <span>
                      {selected.userName || '未设置用户名'} · {selected.userId}
                    </span>
                  </div>
                  <Tag color={detailValue?.account.status === 'pending' ? 'gold' : 'green'}>
                    {adminQuotaStatusLabels[detailValue?.account.status ?? 'pending']}
                  </Tag>
                </div>

                <div className={styles.balanceRow}>
                  <div className={styles.balanceMain}>
                    <span className={styles.hint}>可用积分</span>
                    <b
                      className={
                        detailValue && detailValue.account.available < 0
                          ? styles.amountNeg
                          : undefined
                      }
                    >
                      {detailValue?.account.available ?? '—'}
                    </b>
                  </div>
                  <div className={styles.metrics}>
                    <span>
                      <i>限时积分</i>
                      <b>{detailValue?.account.limited ?? '—'}</b>
                    </span>
                    <span>
                      <i>到期</i>
                      <b>
                        {detailValue?.account.limitedExpiresAt
                          ? formatBeijingTime(detailValue.account.limitedExpiresAt)
                          : '—'}
                      </b>
                    </span>
                    <span>
                      <i>长期积分</i>
                      <b>{detailValue?.account.lasting ?? '—'}</b>
                    </span>
                    <span>
                      <i>本期已发</i>
                      <b>{detailValue?.account.issued ?? '—'}</b>
                    </span>
                    <span>
                      <i>本期已用</i>
                      <b>{detailValue?.account.spent ?? '—'}</b>
                    </span>
                    <span>
                      <i>近 60 天充值</i>
                      <b>{detailValue?.purchasedCredits60d ?? '—'}</b>
                    </span>
                    <span>
                      <i>透支线</i>
                      <b>{detailValue?.overdraft ?? '—'}</b>
                    </span>
                  </div>
                </div>

                <div className={styles.detailActions}>
                  <Button type="primary" onClick={() => setGrantKind('limited')}>
                    发放{issueKindLabels.limited}
                  </Button>
                  <Button onClick={() => setGrantKind('lasting')}>
                    发放{issueKindLabels.lasting}
                  </Button>
                  <Button onClick={() => setRuleOpen(true)}>改规则</Button>
                  <Button onClick={() => setChargesOpen(true)}>账单与冲正</Button>
                  {detailValue?.snapshotAnomaly && (
                    <Tooltip
                      title={`快照 ${detailValue.snapshot.available}，账本 ${detailValue.account.available}`}
                    >
                      <Tag color="red">快照与账本不一致</Tag>
                    </Tooltip>
                  )}
                </div>
                {detailValue?.account.status === 'pending' && (
                  <p className={styles.hint}>
                    本月还没有规则发放。规则：每月 {detailValue.rule.current.credits} 积分（
                    {detailValue.rule.current.source}）。
                  </p>
                )}
              </div>

              <div className={styles.ledgerHead}>
                <strong>流水</strong>
                <span className={styles.statusHint}>按时间倒序，结余是这一行之后的可用积分</span>
                {detailValue && (
                  <span className={styles.statusHint}>
                    最近更新 {formatStoredTime(detailValue.asOf)}
                  </span>
                )}
              </div>
              <div className={styles.ledgerScroll}>
                <CreditLedger
                  entries={ledgerPage.entries}
                  loading={detailPending}
                  hasMore={ledgerPage.hasMore}
                  onLoadMore={() => void loadMoreLedger()}
                />
                {ledgerLoading && <div className={styles.listState}>加载中…</div>}
              </div>
            </>
          )}
        </section>
      </section>

      <CreditGrantDialog
        open={grantKind !== null}
        kind={grantKind ?? 'limited'}
        user={selected}
        onClose={() => setGrantKind(null)}
        onDone={() => {
          void reloadAll();
        }}
      />
      <CreditRuleDialog
        open={ruleOpen}
        user={selected}
        onClose={() => setRuleOpen(false)}
        onDone={() => {
          void reloadAll();
        }}
      />
      <CreditOperationsDrawer open={operationsOpen} onClose={() => setOperationsOpen(false)} />
      <Drawer
        title="补结算与核对"
        open={reconcileOpen}
        onClose={() => setReconcileOpen(false)}
        size={1200}
        destroyOnHidden
      >
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
    </main>
  );
}
