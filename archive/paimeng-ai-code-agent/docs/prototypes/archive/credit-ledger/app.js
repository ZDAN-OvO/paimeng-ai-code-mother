'use strict';

/*
 * 原型：额度管理（积分单账本 / A 主从账本）。
 * 口径：限时积分 = 会月底过期的积分（原「月度配额」）；发放积分 = 长期、不过期。
 * 演示数据固定在北京时间 2026-11-02；状态只在内存里，刷新即重置，不发请求、不写存储。
 */

const PERIOD = '2026-11';
const PERIOD_END = '2026-12-01 00:00';
/** 10 月那条规则发放额固定 500：改规则不回写历史。 */
const LAST_RULE = 500;

const VARIANTS = [
  { key: 'A', name: '主从账本' },
  { key: 'B', name: '待办收件箱' },
  { key: 'C', name: '规则 + 例外' },
];

/** 全库口径。演示表格只渲染 12 条，其余人数留在这些数里，和现状截图一致。 */
const stats = {
  users: 212,
  pending: 11,
  quotaRemaining: 100500,
  balanceNet: 1000000,
  debtUsers: 1,
  debtTotal: 120,
};

const state = {
  variant: 'A',
  selected: '473911000000000001',
  drawerUserId: null,
  search: { A: '', B: '', C: '' },
  filterA: 'all',
  filterC: 'all',
  checked: new Set(),
  grant: null,
  rule: { current: 500, next: 800, nextPeriod: '2026-12' },
};

const USERS = [
  { id: '1', account: 'paimeng666', name: '管理员', issue: 'granted', seed: { lastLeft: 12, topup: 1000000 } },
  { id: '473911000000000001', account: 'chenxi', name: '陈曦', issue: 'granted', seed: { lastLeft: 12, topup: 4800, manualLimited: 200, spent: 320 } },
  { id: '473911000000000002', account: 'lxh_studio', name: '李小海', issue: 'granted', seed: { lastLeft: 12, spent: 37 } },
  { id: '473911000000000003', account: 'zhaolei', name: '赵磊', issue: 'granted', seed: { lastLeft: 0, topup: 20000 } },
  { id: '473911000000000004', account: 'sunqi', name: '孙琪', issue: 'granted', seed: { lastLeft: 40, spent: 380 } },
  { id: '473911000000000005', account: 'hejing', name: '何静', issue: 'granted', seed: { lastLeft: 8, spent: 462 } },
  { id: '473911000000000006', account: 'wangyu', name: '王宇', issue: 'granted', seed: { lastLeft: 0, spent: 620 } },
  { id: '473911000000000007', account: 'zhangfan', name: '张帆', issue: 'paused', seed: { lastLeft: 500 } },
  { id: '473986153914040320', account: 'ts_composer_0b966c6c', name: '', issue: 'pending', seed: {} },
  { id: '473985828717068288', account: 'ts_composer_bec72202', name: '', issue: 'pending', seed: {} },
  { id: '473985437699003904', account: 'ts_composer_bd4bb427', name: '', issue: 'pending', seed: {} },
  { id: '473985112233445566', account: 'ts_composer_a1c0e4', name: '', issue: 'pending', seed: {} },
];

const AUDIT = [
  { time: '11-02 15:20', text: '<b>paimeng666</b> 给 <b>陈曦</b> 发放 <b>+200</b> 限时积分（理由：按投诉补偿）' },
  { time: '11-02 10:04', text: '<b>系统</b> 发现 2 笔账单缺费率，标记为未定价' },
  { time: '11-01 00:00', text: '<b>账期切换</b>：201 人发放本月限时积分，4 人上月剩余清零' },
  { time: '10-31 23:59', text: '<b>账期结束</b>：10 月没用完的限时积分按规则过期' },
  { time: '10-20 14:05', text: '<b>系统</b> 收到充值 <b>+4,800</b> 积分（支付单 TOP-20261020-7781）' },
];

/* ---------- 条目：唯一事实 ---------- */

function buildEntries(user) {
  const seed = user.seed || {};
  const rows = [];
  if (user.issue === 'pending') return rows;

  const lastLeft = seed.lastLeft ?? 12;
  const lastSpent = LAST_RULE - lastLeft;

  rows.push({ at: '10-01 00:00', kind: 'quota', limited: true, label: '发放限时积分', note: `月度规则 ${LAST_RULE} · 11-01 00:00 到期`, delta: LAST_RULE });
  if (lastSpent > 0) rows.push({ at: '10-02 09:12', kind: 'consume', label: '生成消费', note: '应用「咖啡店落地页」', delta: -lastSpent });
  if (seed.topup) rows.push({ at: '10-20 14:05', kind: 'topup', label: '充值到账', note: '支付单 TOP-20261020-7781 · 不过期', delta: seed.topup });
  if (lastLeft > 0) rows.push({ at: '11-01 00:00', kind: 'expire', limited: true, label: '限时积分过期', note: `到期没用完的 ${lastLeft} 积分清零`, delta: -lastLeft });

  if (user.issue !== 'paused') {
    rows.push({ at: '11-01 00:00', kind: 'quota', limited: true, label: '发放限时积分', note: `月度规则 ${LAST_RULE} · ${PERIOD_END} 到期`, delta: LAST_RULE });
    if (seed.manualLimited) {
      rows.push({ at: '11-02 08:40', kind: 'quota', limited: true, label: '发放限时积分', note: `理由：按投诉补偿 · ${PERIOD_END} 到期`, delta: seed.manualLimited });
    }
    if (seed.spent) {
      const over = seed.spent > LAST_RULE + (seed.manualLimited || 0);
      rows.push({
        at: '11-02 09:12', kind: 'consume', label: '生成消费',
        note: over ? '应用「课程报名后台」· 限时积分用尽，超出部分从长期积分扣' : '应用「课程报名后台」',
        delta: -seed.spent,
      });
    }
  }
  return rows;
}

for (const user of USERS) user.entries = buildEntries(user);

/** 可用额 = 条目之和；扣减先扣限时积分，不够再扣长期。 */
function balances(entries) {
  let limited = 0;
  let lasting = 0;
  for (const entry of entries) {
    const delta = entry.delta;
    if (entry.kind === 'consume') {
      const need = -delta;
      const fromLimited = Math.min(Math.max(limited, 0), need);
      limited -= fromLimited;
      lasting -= need - fromLimited;
    } else if (entry.limited) {
      limited += delta;
    } else {
      lasting += delta;
    }
  }
  return { limited, lasting, total: limited + lasting };
}

function spentThisMonth(user) {
  return user.entries.filter((entry) => entry.kind === 'consume' && entry.at.startsWith('11-')).reduce((sum, entry) => sum - entry.delta, 0);
}

function issuedThisMonth(user) {
  return user.entries.filter((entry) => entry.kind === 'quota' && entry.at.startsWith('11-')).reduce((sum, entry) => sum + entry.delta, 0);
}

function userById(id) {
  return USERS.find((user) => user.id === id) || USERS[0];
}

function statusOf(user) {
  if (user.issue === 'paused') return { key: 'paused', label: '暂停发放' };
  if (user.issue === 'pending') return { key: 'pending', label: '待发' };
  if (balances(user.entries).total < 0) return { key: 'debt', label: '欠款' };
  return { key: 'ok', label: '正常' };
}

/* ---------- 格式化 ---------- */

const nf = new Intl.NumberFormat('zh-CN');
const fmt = (value) => nf.format(value);
const signed = (value) => (value > 0 ? '+' : value < 0 ? '−' : '') + fmt(Math.abs(value));
const amt = (value) => (value < 0 ? '−' + fmt(-value) : fmt(value));
const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const shortId = (id) => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

function tagOf(entry) {
  const map = {
    quota: ['限时', 'tag-quota'],
    topup: ['充值', 'tag-topup'],
    grant: ['长期', 'tag-grant'],
    consume: ['消费', 'tag-consume'],
    expire: ['过期', 'tag-expire'],
  };
  const [label, cls] = map[entry.kind] || ['其他', 'tag-consume'];
  return `<span class="tag ${cls}">${label}</span>`;
}

/* ---------- 共用片段 ---------- */

function ledgerTable(user) {
  const rows = user.entries;
  if (!rows.length) {
    return `<div class="empty">
      这个人本月还没有任何条目。<br />
      可用 0 积分不是「积分花完了」，而是「本月限时积分还没发」——发放后会出现一条 +${fmt(state.rule.current)} 的条目。
      <div style="margin-top:12px"><button class="btn primary" data-action="grant" data-kind="limited" data-id="${user.id}">发放限时积分</button></div>
    </div>`;
  }
  let running = 0;
  const body = rows.map((entry) => {
    running += entry.delta;
    return `<tr class="${entry.kind === 'expire' ? 'is-expire' : ''}">
      <td class="when">${entry.at}</td>
      <td>${tagOf(entry)}<span class="entry-label">${entry.label}</span><div class="entry-note">${entry.note}</div></td>
      <td class="num ${entry.delta > 0 ? 'pos' : entry.delta < 0 ? 'neg' : 'dim'}">${signed(entry.delta)}</td>
      <td class="num running ${running < 0 ? 'neg' : ''}">${amt(running)}</td>
    </tr>`;
  }).join('');
  return `<table class="ledger-table">
    <thead><tr><th style="width:118px">时间</th><th>事项</th><th class="num" style="width:92px">变化</th><th class="num" style="width:96px">结余</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function balanceBlock(user) {
  const { limited, lasting, total } = balances(user.entries);
  const status = statusOf(user);
  return `<div class="balance-hero">
      <div class="label">可用额度${status.key === 'debt' ? '（欠款）' : ''}</div>
      <div class="value">${amt(total)}<small>积分</small></div>
    </div>
    <div class="split-bar">
      <span><span class="k">限时积分</span><b>${amt(limited)}</b> · ${PERIOD_END.slice(5, 10)} 失效</span>
      <span><span class="k">长期积分</span><b>${amt(lasting)}</b> · 不过期</span>
      <span><span class="k">本月已用</span><b>${fmt(spentThisMonth(user))}</b></span>
    </div>`;
}

function identityBlock(user) {
  const status = statusOf(user);
  return `<div class="ledger-id">
    <strong>${esc(user.account)}${user.name ? `<span class="dim" style="font-weight:400"> · ${esc(user.name)}</span>` : ''}</strong>
    <div class="meta"><span class="mono">${user.id}</span> · <span class="state ${status.key}">${status.label}</span></div>
  </div>`;
}

function grantButtons(user) {
  return `<button class="btn primary" data-action="grant" data-kind="limited" data-id="${user.id}">发放限时积分</button>
    <button class="btn" data-action="grant" data-kind="lasting" data-id="${user.id}">发放积分</button>`;
}

/* ---------- 变体 A：主从账本 ---------- */

function visibleUsersA() {
  const query = state.search.A.trim().toLowerCase();
  return USERS.filter((user) => {
    if (query && !user.account.toLowerCase().includes(query) && !user.name.toLowerCase().includes(query) && !user.id.includes(query)) return false;
    const status = statusOf(user).key;
    if (state.filterA === 'debt') return status === 'debt';
    if (state.filterA === 'pending') return status === 'pending';
    return true;
  });
}

function renderA() {
  const visible = visibleUsersA();
  const list = visible.map((user) => {
    const { total } = balances(user.entries);
    const pending = user.issue === 'pending';
    return `<li class="user-item ${user.id === state.selected ? 'is-active' : ''}" data-action="select-user" data-id="${user.id}">
      <span class="acct">${esc(user.account)}</span>
      <span class="amt ${pending ? 'is-pending' : total < 0 ? 'is-bad' : ''}">${pending ? '待发' : amt(total)}</span>
      <span class="sub">${user.name ? esc(user.name) : '未设置用户名'} · ${shortId(user.id)}</span>
    </li>`;
  }).join('');

  const selected = userById(state.selected);
  const debtChip = stats.debtUsers > 0
    ? `<button class="link is-bad" data-action="filter-a" data-filter="debt">${stats.debtUsers} 人欠款 ${fmt(stats.debtTotal)}</button>`
    : '<span>0 人欠款</span>';
  const pendingChip = stats.pending > 0
    ? `<button class="link is-warn" data-action="filter-a" data-filter="pending">${stats.pending} 人本月限时积分未发</button>`
    : '<span>本月限时积分已全部发放</span>';

  return `<section class="page-fill">
    <div class="page-head">
      <div>
        <h1>额度管理</h1>
        <p class="hint">一个人一本账。限时积分、长期积分、充值、消费、过期都是同一张流水里的条目，可用额就是这些条目的和。</p>
      </div>
      <div class="spacer"></div>
      <button class="btn" data-action="bills">补结算</button>
    </div>
    <div class="summary-line">
      <span><b>${fmt(stats.users)}</b> 人</span><span class="dot">·</span>
      <span>可用合计 <b>${fmt(stats.quotaRemaining + stats.balanceNet)}</b> 积分</span><span class="dot">·</span>
      ${pendingChip}<span class="dot">·</span>
      ${debtChip}
      <span class="grow"></span>
      ${stats.pending > 0 ? '<button class="link" data-action="issue-all">处理待发 →</button>' : ''}
    </div>

    <div class="split">
      <aside class="user-pane">
        <div class="user-search">
          <input id="search-a" type="search" placeholder="搜索账号 / 用户名 / 用户 ID" value="${esc(state.search.A)}" />
          <div class="list-filters">
            <button class="chip ${state.filterA === 'all' ? 'is-on' : ''}" data-action="filter-a" data-filter="all">全部</button>
            <button class="chip ${state.filterA === 'debt' ? 'is-on' : ''}" data-action="filter-a" data-filter="debt">欠款</button>
            <button class="chip ${state.filterA === 'pending' ? 'is-on' : ''}" data-action="filter-a" data-filter="pending">待发</button>
          </div>
        </div>
        <ul class="user-list">${list || '<li class="empty" style="border:0">这个筛选下没有用户</li>'}</ul>
        <div class="user-list-foot">演示数据 ${visible.length} / ${fmt(stats.users)} 人</div>
      </aside>

      <section class="ledger">
        <div class="ledger-head">
          ${identityBlock(selected)}
          <div class="ledger-actions">
            ${grantButtons(selected)}
            <button class="btn ghost" data-action="bills">账单与冲正</button>
          </div>
        </div>
        ${balanceBlock(selected)}
        <div class="section-title"><h2>流水</h2><span>按时间正序，结余是这一行的累计值</span></div>
        <div class="ledger-scroll">${ledgerTable(selected)}</div>
      </section>
    </div>
  </section>`;
}

/* ---------- 变体 B：待办收件箱 ---------- */

function renderB() {
  const query = state.search.B.trim().toLowerCase();
  const matches = query
    ? USERS.filter((user) => user.account.toLowerCase().includes(query) || user.name.toLowerCase().includes(query) || user.id.includes(query)).slice(0, 5)
    : [];
  const results = matches.map((user) => `<button data-action="open-user" data-id="${user.id}">
      <strong>${esc(user.account)}</strong>${user.name ? ` <span class="dim">· ${esc(user.name)}</span>` : ''}
      <div class="sub">${fmt(balances(user.entries).total)} 积分 · ${statusOf(user).label}</div>
    </button>`).join('');

  const pendingTask = stats.pending > 0
    ? `<li class="task is-action">
        <div>
          <h2>本月还有 ${stats.pending} 人没发限时积分</h2>
          <p>${PERIOD} 账期 · 每人 ${fmt(state.rule.current)} 积分 · 合计 ${fmt(stats.pending * state.rule.current)} · 月底失效</p>
        </div>
        <div class="task-actions"><button class="btn primary" data-action="issue-all">现在发</button></div>
      </li>`
    : `<li class="task is-done">
        <div><h2>本月限时积分已全部发放</h2><p>${PERIOD} 账期 · ${fmt(stats.users)} 人 · 刚刚完成</p></div>
        <div class="task-actions"><span class="done-mark">✓ 已发放 ${fmt(stats.users * state.rule.current)} 积分</span></div>
      </li>`;

  return `<section class="narrow">
    <div class="page-head">
      <div>
        <h1>额度</h1>
        <p class="hint">这个页面只回答两件事：今天要发什么、要补什么；某个人现在还能用多少。查人用右上角搜索。</p>
      </div>
      <div class="spacer"></div>
      <div class="inbox-search">
        <input id="search-b" type="search" placeholder="搜一个人：账号 / 用户名 / 用户 ID" value="${esc(state.search.B)}" autocomplete="off" />
        ${results ? `<div class="results">${results}</div>` : ''}
      </div>
    </div>

    <ul class="tasks">
      ${pendingTask}
      <li class="task is-action">
        <div>
          <h2>2 笔账单缺费率，没有定价</h2>
          <p>补齐费率后会自动补记差额；在那之前这两笔账单是 unpriced，不扣积分。</p>
        </div>
        <div class="task-actions"><button class="btn" data-action="bills">查看</button></div>
      </li>
      <li class="task ${stats.debtUsers ? 'is-action' : 'is-idle'}">
        <div>
          <h2>${stats.debtUsers ? `${stats.debtUsers} 人欠款 ${fmt(stats.debtTotal)} 积分` : '没有人欠款'}</h2>
          <p>欠款超过透支线会中止正在跑的生成。透支线 = 近 60 天充值 × 2%，封顶 500。</p>
        </div>
        <div class="task-actions">${stats.debtUsers ? '<button class="btn" data-action="open-debt">看是谁</button>' : ''}</div>
      </li>
      <li class="task">
        <div>
          <h2>下月规则待生效：每月 ${fmt(state.rule.next)} 限时积分 / 人</h2>
          <p>${state.rule.nextPeriod} 起生效，只影响新账期；当月已经发出去的不追溯。</p>
        </div>
        <div class="task-actions"><button class="btn ghost" data-action="edit-rule">改规则</button></div>
      </li>
      <li class="task is-idle">
        <div><h2>没有待补的账单</h2><p>终态生成都已有账单；补结算每天在启动屏障跑一次。</p></div>
      </li>
    </ul>

    <div class="section-title"><h2>最近操作</h2><span>审计用，不需要在这一页看用户表</span></div>
    <ol class="audit">
      ${AUDIT.map((item) => `<li><span class="time">${item.time}</span>${item.text}</li>`).join('')}
    </ol>

    <div class="rule-strip">
      <span>规则：每月自动发放 <b>${fmt(state.rule.current)}</b> 限时积分，月底失效</span>
      <span>透支线 <b>2% / 500</b></span>
      <span class="grow"></span>
      <button class="link" data-action="edit-rule">改规则</button>
    </div>
  </section>`;
}

/* ---------- 变体 C：规则 + 例外 ---------- */

function renderC() {
  const query = state.search.C.trim().toLowerCase();
  const rows = USERS.filter((user) => {
    if (query && !user.account.toLowerCase().includes(query) && !user.name.toLowerCase().includes(query) && !user.id.includes(query)) return false;
    const status = statusOf(user).key;
    if (state.filterC === 'pending') return status === 'pending';
    if (state.filterC === 'debt') return status === 'debt';
    if (state.filterC === 'extra') return issuedThisMonth(user) > state.rule.current;
    return true;
  });

  const allChecked = rows.length > 0 && rows.every((user) => state.checked.has(user.id));

  const body = rows.map((user) => {
    const status = statusOf(user);
    const pending = user.issue === 'pending';
    const checked = state.checked.has(user.id);
    const issued = issuedThisMonth(user);
    const extra = issued > state.rule.current;
    const { total, limited } = balances(user.entries);
    return `<tr class="${checked ? 'is-selected' : ''} ${status.key === 'debt' ? 'is-debt' : ''}">
      <td class="col-check"><input type="checkbox" data-action="check" data-id="${user.id}" ${checked ? 'checked' : ''} aria-label="选择 ${esc(user.account)}" /></td>
      <td class="user-cell">
        <strong>${esc(user.account)}</strong>
        <span>${user.name ? esc(user.name) : '未设置用户名'} · <span class="mono">${shortId(user.id)}</span></span>
      </td>
      <td class="amount ${extra ? 'is-exception' : ''}">
        ${pending || !issued ? '<span class="dim">—</span>' : `<span class="edit-cell">${fmt(issued)}
          <span class="badge ${extra ? 'is-exception' : ''}">${extra ? '额外' : '规则'}</span>
        </span>`}
      </td>
      <td class="amount">${pending ? '<span class="dim">—</span>' : fmt(spentThisMonth(user))}</td>
      <td class="amount ${total < 0 ? 'neg' : ''}">${pending ? '<span class="dim">—</span>' : amt(total)}
        ${!pending && limited !== issued ? `<span class="dim" style="font-size:11px"> · 剩 ${fmt(limited)}</span>` : ''}
      </td>
      <td><span class="state ${status.key}">${status.label}</span></td>
      <td class="num"><button class="link" data-action="open-user" data-id="${user.id}">账本</button></td>
    </tr>`;
  }).join('');

  const checkedCount = state.checked.size;
  return `<section>
    <div class="grid-head">
      <div>
        <h1>额度管理</h1>
        <p class="hint">这一页只有两种事：一条规则（每月发多少限时积分），以及规则之外的额外发放。全库统计和理解成本都在这一张表上。</p>
      </div>
    </div>

    <div class="rule-strip" style="margin-top:16px">
      <span>每月自动发放 <b>${fmt(state.rule.current)}</b> 限时积分</span>
      <span>月底失效、不累积</span>
      <span>${state.rule.nextPeriod} 起 <b>${fmt(state.rule.next)}</b></span>
      <span class="grow"></span>
      <button class="link" data-action="edit-rule">改规则</button>
    </div>

    <div class="grid-toolbar">
      <input id="search-c" type="search" placeholder="搜索账号 / 用户名 / 用户 ID" value="${esc(state.search.C)}" />
      <button class="btn sm ${state.filterC === 'all' ? 'primary' : ''}" data-action="filter" data-filter="all">全部</button>
      <button class="btn sm ${state.filterC === 'pending' ? 'primary' : ''}" data-action="filter" data-filter="pending">待发</button>
      <button class="btn sm ${state.filterC === 'debt' ? 'primary' : ''}" data-action="filter" data-filter="debt">欠款</button>
      <button class="btn sm ${state.filterC === 'extra' ? 'primary' : ''}" data-action="filter" data-filter="extra">额外发放</button>
      <span class="grow"></span>
      <span class="dim" style="font-size:12px">额外发放只追加一条限时积分条目，不改规则、不改上月</span>
    </div>

    <div class="grid-wrap">
      <table class="grid">
        <thead><tr>
          <th class="col-check"><input type="checkbox" data-action="check-all" ${allChecked ? 'checked' : ''} aria-label="全选当前范围" /></th>
          <th>用户</th>
          <th style="width:160px">本月限时积分</th>
          <th style="width:100px">已用</th>
          <th style="width:170px">可用合计</th>
          <th style="width:110px">状态</th>
          <th style="width:70px"></th>
        </tr></thead>
        <tbody>${body || '<tr><td colspan="7"><div class="empty" style="border:0">当前筛选下没有用户</div></td></tr>'}</tbody>
      </table>
    </div>

    <div class="grid-foot">
      <span>当前筛选 ${rows.length} 条（演示数据）· 全库 ${fmt(stats.users)} 人</span>
      <span>本月发放 ${stats.pending > 0 ? fmt(stats.users - stats.pending) : fmt(stats.users)} / ${fmt(stats.users)}</span>
      <span>可用合计 ${fmt(stats.quotaRemaining + stats.balanceNet)} 积分</span>
    </div>

    ${checkedCount ? `<div class="bulk-bar">
      <span>已选 ${checkedCount} 人</span>
      <button class="btn sm" data-action="bulk-grant" data-kind="limited">发放限时积分</button>
      <button class="btn sm" data-action="bulk-grant" data-kind="lasting">发放积分</button>
      <button class="bulk-close" data-action="clear-check" aria-label="清除选择">✕</button>
    </div>` : ''}
  </section>`;
}

/* ---------- 抽屉 ---------- */

function renderDrawer() {
  const drawer = document.getElementById('drawer');
  const scrim = document.getElementById('drawer-scrim');
  if (!state.drawerUserId) {
    drawer.hidden = true;
    scrim.hidden = true;
    return;
  }
  const user = userById(state.drawerUserId);
  drawer.innerHTML = `
    <div class="drawer-head">
      <div>${identityBlock(user)}</div>
      <button class="icon-btn" data-action="close-drawer" aria-label="关闭">✕</button>
    </div>
    ${user.issue === 'pending'
      ? `<div class="empty" style="margin-top:16px">本月条目还没有生成，可用 0 积分。
          <div style="margin-top:12px"><button class="btn primary" data-action="grant" data-kind="limited" data-id="${user.id}">发放限时积分</button></div>
        </div>`
      : `${balanceBlock(user)}
         <div class="section-title"><h2>流水</h2><span>最近 20 条</span></div>
         ${ledgerTable(user)}`}
    <div class="section-title"><h2>操作</h2></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap">
      ${grantButtons(user)}
      <button class="btn ghost" data-action="bills">账单与冲正</button>
    </div>`;
  drawer.hidden = false;
  scrim.hidden = false;
}

/* ---------- 发放弹窗 ---------- */

const GRANT_KINDS = {
  lasting: {
    title: '发放积分',
    hint: '长期积分：不过期、不随账期清零，直接加进可用额。',
  },
  limited: {
    title: '发放限时积分',
    hint: `限时积分：${PERIOD_END} 到期，没用完会直接过期；只影响本月。`,
  },
};

function openGrant(userIds, kind) {
  const meta = GRANT_KINDS[kind];
  state.grant = { userIds, kind };
  const one = userIds.length === 1 ? userById(userIds[0]) : null;
  document.getElementById('grant-title').textContent = meta.title;
  document.getElementById('grant-subject').innerHTML = one
    ? `${esc(one.account)}${one.name ? ` · ${esc(one.name)}` : ''}<span class="dim">　当前可用 ${amt(balances(one.entries).total)} 积分</span>`
    : `已选 ${userIds.length} 人<span class="dim">　每人发放相同数量</span>`;
  const amount = document.getElementById('grant-amount');
  amount.value = kind === 'limited' ? String(state.rule.current) : '100';
  document.getElementById('grant-reason').value = '';
  document.getElementById('grant-hint').textContent = meta.hint;
  document.getElementById('grant-modal').hidden = false;
  amount.focus();
  amount.select();
}

function closeGrant() {
  state.grant = null;
  document.getElementById('grant-modal').hidden = true;
}

function saveGrant() {
  if (!state.grant) return;
  const { userIds, kind } = state.grant;
  const amount = Number(document.getElementById('grant-amount').value);
  const reason = document.getElementById('grant-reason').value.trim();
  if (!Number.isInteger(amount) || amount <= 0) {
    toast('数量必须是大于 0 的整数', true);
    return;
  }
  const at = '11-02 15:53';
  const reasonNote = reason ? `理由：${reason} · ` : '';
  let pendingHint = false;
  for (const id of userIds) {
    const user = userById(id);
    const before = balances(user.entries).total;
    if (kind === 'lasting') {
      user.entries.push({ at, kind: 'grant', label: '发放积分', note: `${reasonNote}不过期`, delta: amount });
      stats.balanceNet += amount;
    } else {
      user.entries.push({ at, kind: 'quota', limited: true, label: '发放限时积分', note: `${reasonNote}${PERIOD_END} 到期`, delta: amount });
      stats.quotaRemaining += amount;
    }
    // 欠款只按演示用户这一份重算：补到正数就从欠款统计里移除。
    if (before < 0 && balances(user.entries).total >= 0) {
      stats.debtUsers = Math.max(0, stats.debtUsers - 1);
      stats.debtTotal = Math.max(0, stats.debtTotal + before);
    }
    if (kind === 'limited' && user.issue === 'pending') pendingHint = true;
  }
  state.checked.clear();
  const label = kind === 'lasting' ? '长期积分' : '限时积分';
  const who = userIds.length === 1 ? userById(userIds[0]).account : `${userIds.length} 人`;
  toast(`已给 ${who} 发放 ${fmt(amount)} ${label}${kind === 'limited' ? `（${PERIOD_END} 到期）` : '（不过期）'}${pendingHint ? '；本月规则额度仍未发，仍在待发名单里' : ''}`);
  closeGrant();
  render();
}

/* ---------- 渲染入口 ---------- */

function render() {
  const view = document.getElementById('view');
  view.classList.toggle('is-fill', state.variant === 'A');
  view.innerHTML = state.variant === 'A' ? renderA() : state.variant === 'B' ? renderB() : renderC();
  document.getElementById('proto-label').textContent = `${state.variant} · ${VARIANTS.find((item) => item.key === state.variant).name}`;
  renderDrawer();
}

/* ---------- 交互 ---------- */

let toastTimer = null;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

function issueAll() {
  if (stats.pending === 0) {
    toast('本月已经全部发放过了');
    return;
  }
  const count = stats.pending;
  for (const user of USERS) {
    if (user.issue !== 'pending') continue;
    user.issue = 'granted';
    user.entries.push({ at: '11-01 00:00', kind: 'quota', limited: true, label: '发放限时积分', note: `月度规则 ${state.rule.current} · ${PERIOD_END} 到期`, delta: state.rule.current });
  }
  stats.pending = 0;
  stats.quotaRemaining += count * state.rule.current;
  toast(`已发放 ${count} 人，每人 ${fmt(state.rule.current)} 限时积分；每人账本多一条条目`);
}

function setFilterA(filter) {
  state.filterA = filter;
  const list = visibleUsersA();
  if (list.length && !list.some((user) => user.id === state.selected)) state.selected = list[0].id;
  render();
}

function openRule() {
  document.getElementById('rule-credits').value = String(state.rule.next);
  document.getElementById('rule-period').value = state.rule.nextPeriod;
  document.getElementById('rule-modal').hidden = false;
}

function saveRule() {
  const credits = Number(document.getElementById('rule-credits').value);
  const period = document.getElementById('rule-period').value;
  if (!Number.isInteger(credits) || credits < 0) {
    toast('数量必须是不小于 0 的整数', true);
    return;
  }
  state.rule.next = credits;
  state.rule.nextPeriod = period;
  document.getElementById('rule-modal').hidden = true;
  toast(`规则已保存：${period} 起每月自动发放 ${fmt(credits)} 限时积分`);
  render();
}

function setVariant(key) {
  state.variant = key;
  const url = new URL(window.location.href);
  url.searchParams.set('variant', key);
  window.history.replaceState(null, '', url);
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function cycle(delta) {
  const index = VARIANTS.findIndex((item) => item.key === state.variant);
  setVariant(VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length].key);
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id, filter, kind } = target.dataset;

  switch (action) {
    case 'select-user':
      state.selected = id;
      state.drawerUserId = null;
      render();
      break;
    case 'open-user':
      state.drawerUserId = id;
      state.search.B = '';
      render();
      break;
    case 'open-debt':
      state.drawerUserId = '473911000000000006';
      render();
      break;
    case 'close-drawer':
      state.drawerUserId = null;
      renderDrawer();
      break;
    case 'grant':
      openGrant([id], kind);
      break;
    case 'bulk-grant':
      openGrant([...state.checked], kind);
      break;
    case 'issue-all':
      issueAll();
      render();
      break;
    case 'filter-a':
      setFilterA(filter);
      break;
    case 'filter':
      state.filterC = filter;
      render();
      break;
    case 'clear-check':
      state.checked.clear();
      render();
      break;
    case 'check':
      if (state.checked.has(id)) state.checked.delete(id);
      else state.checked.add(id);
      render();
      break;
    case 'check-all': {
      const rows = USERS.filter((user) => {
        const status = statusOf(user).key;
        if (state.filterC === 'pending') return status === 'pending';
        if (state.filterC === 'debt') return status === 'debt';
        if (state.filterC === 'extra') return issuedThisMonth(user) > state.rule.current;
        return true;
      });
      const all = rows.every((user) => state.checked.has(user.id));
      state.checked.clear();
      if (!all) for (const user of rows) state.checked.add(user.id);
      render();
      break;
    }
    case 'edit-rule':
      openRule();
      break;
    case 'bills':
      toast('这一步不在本轮原型里：账单与补结算已有实现，先只对齐额度这一页');
      break;
    default:
      break;
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  const map = { 'search-a': ['A', renderA], 'search-b': ['B', renderB], 'search-c': ['C', renderC] };
  const entry = map[target.id];
  if (!entry) return;
  const [key, render] = entry;
  state.search[key] = target.value;
  document.getElementById('view').innerHTML = render();
  const input = document.getElementById(target.id);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!document.getElementById('model-modal').hidden) { document.getElementById('model-modal').hidden = true; return; }
    if (!document.getElementById('rule-modal').hidden) { document.getElementById('rule-modal').hidden = true; return; }
    if (!document.getElementById('grant-modal').hidden) { closeGrant(); return; }
    if (state.drawerUserId) { state.drawerUserId = null; renderDrawer(); return; }
  }
  if (event.key === 'Enter' && !document.getElementById('grant-modal').hidden && event.target.id === 'grant-amount') {
    event.preventDefault();
    saveGrant();
    return;
  }
  if (event.target.matches('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); cycle(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); cycle(1); }
});

/* 抽屉与浮条 */

document.getElementById('prev').addEventListener('click', () => cycle(-1));
document.getElementById('next').addEventListener('click', () => cycle(1));
document.getElementById('drawer-scrim').addEventListener('click', () => { state.drawerUserId = null; renderDrawer(); });

document.getElementById('model-btn').addEventListener('click', () => { document.getElementById('model-modal').hidden = false; });
document.getElementById('model-close').addEventListener('click', () => { document.getElementById('model-modal').hidden = true; });
document.getElementById('model-modal').addEventListener('click', (event) => {
  if (event.target.id === 'model-modal') document.getElementById('model-modal').hidden = true;
});

document.getElementById('rule-close').addEventListener('click', () => { document.getElementById('rule-modal').hidden = true; });
document.getElementById('rule-cancel').addEventListener('click', () => { document.getElementById('rule-modal').hidden = true; });
document.getElementById('rule-save').addEventListener('click', saveRule);
document.getElementById('rule-modal').addEventListener('click', (event) => {
  if (event.target.id === 'rule-modal') document.getElementById('rule-modal').hidden = true;
});

document.getElementById('grant-close').addEventListener('click', closeGrant);
document.getElementById('grant-cancel').addEventListener('click', closeGrant);
document.getElementById('grant-save').addEventListener('click', saveGrant);
document.getElementById('grant-modal').addEventListener('click', (event) => {
  if (event.target.id === 'grant-modal') closeGrant();
});
document.getElementById('grant-quick').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-amount]');
  if (!button) return;
  const input = document.getElementById('grant-amount');
  input.value = button.dataset.amount;
  input.focus();
});

/* 启动 */

const initial = new URL(window.location.href).searchParams.get('variant');
if (VARIANTS.some((item) => item.key === initial)) state.variant = initial;
render();
