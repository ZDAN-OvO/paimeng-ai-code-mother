/* 原型脚本：一份演示数据，三个结构不同的折叠方案。
   没有框架、没有网络、不写 localStorage —— 刷新即回到默认。 */

const VARIANTS = [
  { key: 'A', name: '一行折叠组' },
  { key: 'B', name: '左侧时间线' },
  { key: 'C', name: '摘要行 + 侧栏过程' },
];

/* ---------------- 演示数据（写死） ---------------- */

const PROSE_DONE = `
  <p><strong>预约页已经能用。</strong>收割机与拖拉机各一张卡片，按亩/按天两套报价，空闲档期做成可点的表格，选中后填电话就算提交。</p>
  <p class="muted">你之前说不接数据库，所以预约只在页面里回显，刷新会丢；要真的收单我下一步可以接。</p>`;

const PROSE_FAILED = `
  <p>这一轮没跑通：类型检查报了两处错误，我先停在这里，没有继续改别的东西。</p>
  <p class="muted">诊断在上面那段过程的末尾，已经展开了，能直接看到文件和行号。</p>`;

const PROSE_RUNNING = '';

const STEPS = [
  {
    kind: 'reason',
    title: '先确认模板与现有文件',
    meta: '',
    ms: '0.6s',
    body: { type: 'code', text: '单页还是多文件？预约表单要落库吗？用户说「只在前端反馈」，那就不接数据库，\n只做前端校验 + 页面内回显。先看 templates/html 里有什么。' },
  },
  {
    kind: 'list', title: '列出文件', meta: '12 个文件', ms: '0.1s',
    body: { type: 'list', items: ['index.html', 'style.css', 'assets/', 'assets/tractor.jpg', 'assets/harvester.jpg', '…'] },
  },
  {
    kind: 'read', title: '读取文件 templates/html/style.css', meta: '210 行', ms: '0.3s',
    body: { type: 'code', text: ':root{--ink:#1b1f1a;--line:#e7e5db;--accent:#1f3d2b}\n.hero{padding:64px 56px 40px}\n.row{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}' },
  },
  {
    kind: 'search', title: '联网搜索「农机 空闲档期 展示」', meta: '3 条结果', ms: '2.4s',
    body: { type: 'search', items: [
      { title: '农机共享平台的档期表怎么做', text: '按天粒度 + 状态色标（空闲/已约满/少量）' },
      { title: '预约表单的字段取舍', text: '姓名、电话、作物亩数、租几天' },
    ] },
  },
  {
    kind: 'write', title: '写入文件 index.html', meta: '124 行', ms: '0.4s', diff: { added: 118, removed: 0 },
    body: { type: 'code', text: '<section class="hero">\n  <h1>田边儿合作社农机预约</h1>\n  <p>附近农户 · 就近安排 · 机器来帮忙</p>\n</section>\n<div class="row">…收割机 / 拖拉机 两张卡…</div>\n<table class="slots">…今天 / 周一 / 周二 …</table>' },
  },
  {
    kind: 'edit', title: '修改文件 style.css', meta: '1 处替换', ms: '0.2s', diff: { added: 14, removed: 3 },
    body: { type: 'diff', old: ['--accent:#1f3d2b;'], next: ['--accent:#1f3d2b;', '.slots td[data-free]{color:#237804}', '.slot-picked{background:#f3f8f0}'] },
  },
  {
    kind: 'build', title: '阶段构建：预约页可用', meta: '通过', ms: '19.3s',
    body: { type: 'stages', items: [
      { name: '写入文件', ms: '0.4s', ok: true },
      { name: '源码校验', ms: '0.2s', ok: true },
      { name: '打包', ms: '18.7s', ok: true },
      { name: '预览就绪', ms: '—', ok: true },
    ] },
  },
];

const STEPS_FAILED = STEPS.slice(0, 6).concat([{
  kind: 'build', err: true, title: '阶段构建：预约页可用', meta: '类型检查未通过', ms: '6.1s',
  body: { type: 'stages', items: [
    { name: '写入文件', ms: '0.3s', ok: true },
    { name: '源码校验', ms: '5.4s', ok: false },
    { name: '打包', ms: '未执行', ok: false },
  ], note: '诊断：src/App.vue:42 找不到名称 slots；style.css:118 未知属性 grid-tamplate。' },
}]);

const STEPS_RUNNING = STEPS.slice(0, 6).concat([{
  kind: 'build', running: true, title: '阶段构建：预约页可用', meta: '正在打包…', ms: '',
  body: { type: 'stages', items: [
    { name: '写入文件', ms: '0.4s', ok: true },
    { name: '源码校验', ms: '0.2s', ok: true },
    { name: '打包', ms: '进行中', ok: false, running: true },
  ] },
}]);

function scenario(state) {
  const active = state === 'thinking' || state === 'running';
  const steps = state === 'thinking'
    ? [{ ...STEPS[0], running: true, ms: '1.2s', elapsedSeconds: 1.2 }]
    : state === 'failed' ? STEPS_FAILED : state === 'running' ? STEPS_RUNNING : STEPS;
  return {
    state,
    turns: [
      { role: 'user', time: '今天 23:06', text: '我们合作社有收割机和拖拉机，农忙时想租给附近农户。做个页面能看机器、哪些天有空、按亩或按天大概多少钱，农户留电话预约。别搞成普通产品官网。' },
      {
        role: 'assistant', state, time: '今天 23:06', steps,
        tokens: active ? null : { up: 8120, out: 2043, delta: 3997 },
        credits: active ? null : '0.011',
        total: active ? null : state === 'failed' ? '41s' : '23s',
        liveBase: state === 'thinking' ? 1.2 : 12,
        prose: state === 'failed' ? PROSE_FAILED : active ? PROSE_RUNNING : PROSE_DONE,
        note: state === 'done' ? '2 个文件 · 3 处修改' : null,
      },
    ],
  };
}

/* ---------------- 小工具 ---------------- */

const esc = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const count = (steps, ...kinds) => steps.filter(step => kinds.includes(step.kind)).length;

/** 折叠组头上那句确定性摘要：由步骤类型计数得出，不需要模型参与。 */
function summaryOf(steps) {
  const parts = [];
  if (count(steps, 'read')) parts.push(`读了 ${count(steps, 'read')} 个文件`);
  if (count(steps, 'list')) parts.push('列了目录');
  if (count(steps, 'search', 'page')) parts.push(`联网 ${count(steps, 'search', 'page')} 次`);
  if (count(steps, 'image')) parts.push(`导入 ${count(steps, 'image')} 张图`);
  if (count(steps, 'write')) parts.push(`写了 ${count(steps, 'write')} 个文件`);
  if (count(steps, 'edit')) parts.push(`改了 ${count(steps, 'edit')} 个文件`);
  if (count(steps, 'build')) parts.push(`构建 ${count(steps, 'build')} 次`);
  if (parts.length <= 3) return parts.join('、');
  return `${parts.slice(0, 3).join('、')}，还有 ${parts.length - 3} 项`;
}

/** 一行摘要用的短版：只留最要紧的两项，否则一条横线根本放不下。 */
function compactSummaryOf(steps) {
  const parts = [];
  if (count(steps, 'write', 'edit')) parts.push(`改了 ${count(steps, 'write', 'edit')} 个文件`);
  if (count(steps, 'read')) parts.push(`读了 ${count(steps, 'read')} 个文件`);
  if (count(steps, 'build')) parts.push(`构建 ${count(steps, 'build')} 次`);
  if (!parts.length) return summaryOf(steps);
  return parts.join('、');
}

/* 图标是自绘的 16px / 1.5px 描边一套，不用 unicode 字形顶替（字形的大小与字重不受控，
   混在中文里会显得脏）。全部 currentColor，跟着文字一起变灰。 */
const ICONS = {
  reason: '<path d="M8 2.2 9.1 6l3.8 1.1-3.8 1.1L8 12l-1.1-3.8L3.1 7.1 6.9 6z"/>',
  list: '<path d="M3 5h10M3 8h10M3 11h6"/>',
  read: '<path d="M4.6 2.5h4.3l2.5 2.5v8.5H4.6z"/><path d="M8.8 2.5v2.6h2.6"/>',
  write: '<path d="M4.6 2.5h4.3l2.5 2.5v8.5H4.6z"/><path d="M8.8 2.5v2.6h2.6"/><path d="M8 7.6v3.6M6.2 9.4h3.6"/>',
  edit: '<path d="M3 11.6 9.9 4.7l1.9 1.9-6.9 6.9-2.2.4z"/><path d="M9.2 5.4 10.6 6.8"/>',
  search: '<circle cx="7.2" cy="7.2" r="3.7"/><path d="M10 10 13 13"/>',
  page: '<circle cx="8" cy="8" r="5.2"/><path d="M2.8 8h10.4M8 2.8c1.9 1.6 1.9 8.8 0 10.4-1.9-1.6-1.9-8.8 0-10.4"/>',
  image: '<rect x="2.8" y="3.2" width="10.4" height="9.6" rx="1.2"/><path d="M3.4 10.4 6 7.9l2 2 1.8-1.8 2.8 2.8"/>',
  build: '<path d="M2.6 6.2 8 3.3l5.4 2.9L8 9.1z"/><path d="M2.6 6.2v4.2L8 13.3l5.4-2.9V6.2"/>',
};
const iconOf = kind => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] ?? ICONS.list}</svg>`;
const chevron = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6.2 3.8 4.2 4.2-4.2 4.2"/></svg>';
const dots = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><circle cx="3.4" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.6" cy="8" r="1.2"/></svg>';
const STAGE_OK = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3.4 8.4 3 3 6.2-6.6"/></svg>';
const STAGE_FAIL = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>';
const titleOf = step => step.kind === 'reason' ? thinkingLabel(step) : step.title;
const activeTurn = turn => turn.state === 'thinking' || turn.state === 'running';
const formatElapsed = seconds => seconds < 60
  ? `${Number(seconds.toFixed(1))}s`
  : `${Math.floor(seconds / 60)}m ${Number((seconds % 60).toFixed(1))}s`;
const secondsOf = step => step.running ? (step.elapsedSeconds ?? 12) : parseFloat(step.ms);
const durationMarkup = steps => {
  const seconds = steps.reduce((sum, step) => sum + secondsOf(step), 0);
  return `<span class="step-ms" ${steps.some(step => step.running) ? `data-elapsed="${seconds}"` : ''}>${formatElapsed(seconds)}</span>`;
};
const turnClock = turn => turn.total ?? `<span data-elapsed="${turn.liveBase}">${formatElapsed(turn.liveBase)}</span>`;
/** 外层说这一轮的地位（和生产的状态词一致），内层说思考自己的地位。两者不能共用一句话。 */
const turnLabel = turn => ({ thinking: '生成中', running: '构建中', done: '已生成', failed: '生成失败' })[turn.state];
const thinkingLabel = step => step.running ? '正在思考' : '已思考';

function bodyOf(step) {
  const body = step.body;
  if (!body) return '';
  if (body.type === 'code') return `<pre class="code">${esc(body.text)}</pre>`;
  if (body.type === 'list') return `<pre class="code">${body.items.map(esc).join('\n')}</pre>`;
  if (body.type === 'diff') return `<div class="diff">${body.old.map(line => `<div class="minus">- ${esc(line)}</div>`).join('')}${body.next.map(line => `<div class="plus">+ ${esc(line)}</div>`).join('')}</div>`;
  if (body.type === 'search') return body.items.map(item => `<span class="search-item"><b>${esc(item.title)}</b><span>${esc(item.text)}</span></span>`).join('');
  if (body.type === 'stages') return `<div class="stages">${body.items.map(item => `<span class="${item.ok ? '' : 'stage-fail'}">${item.running ? '<i class="stage-spin"></i>' : item.ok ? STAGE_OK : STAGE_FAIL}${esc(item.name)} ${esc(item.ms)}</span>`).join('')}</div>${body.note ? `<p class="stage-note">诊断：${esc(body.note.replace(/^诊断：/, ''))}</p>` : ''}`;
  return '';
}

function stepMarkup(step, index, options = {}) {
  const open = options.open === true;
  const stateClass = step.err ? 'step-err' : step.running ? 'step-running' : 'done';
  return `<div class="step ${stateClass}" data-step="${index}" data-open="${open}">
    <button type="button" class="step-h" aria-expanded="${open}">
      <span class="chev" aria-hidden="true">${chevron}</span><span class="step-ico">${iconOf(step.kind)}</span>
      <span class="step-t">${esc(titleOf(step))}${step.meta ? ` <span class="step-m">· ${esc(step.meta)}</span>` : ''}</span>
      <span class="step-ms" ${step.running ? `data-elapsed="${secondsOf(step)}"` : ''}>${step.running ? formatElapsed(secondsOf(step)) : esc(step.ms)}</span>
    </button>
    <div class="step-body" ${open ? '' : 'hidden'}>${bodyOf(step)}</div>
  </div>`;
}

/** v0 的绿色药丸不是 token，是这一轮改了哪些行的行数统计（+新增 / -删除）。 */
function diffStatOf(steps) {
  const added = steps.reduce((sum, step) => sum + (step.diff?.added ?? 0), 0);
  const removed = steps.reduce((sum, step) => sum + (step.diff?.removed ?? 0), 0);
  return added || removed ? { added, removed } : null;
}
function statMarkup(turn) {
  const stat = diffStatOf(turn.steps);
  if (!stat) return '';
  return `<span class="stat"><i class="add">+${stat.added}</i><i class="sep">/</i><i class="del">-${stat.removed}</i></span>`;
}
const usageFoot = turn => turn.tokens
  ? `${esc(turn.credits)} credits · 输入 ${turn.tokens.up.toLocaleString('zh-CN')} / 输出 ${turn.tokens.out.toLocaleString('zh-CN')} tokens`
  : '用量在结算后才有';

/* ---------------- A：一行折叠组（v0 同构） ---------------- */

function renderA(turn) {
  const summary = summaryOf(turn.steps);
  const openGroup = turn.state !== 'done';
  return `<div class="v-a">
    <div class="run" data-run data-open="${openGroup}">
      <div class="row">
        <button type="button" class="run-h" aria-expanded="${openGroup}">
          <span class="chev" aria-hidden="true">${chevron}</span>
          <span class="run-t">${turnLabel(turn)}</span>
          <span class="step-ms">${turnClock(turn)}</span>
        </button>
        ${statMarkup(turn)}
        <span class="run-more" role="presentation" aria-hidden="true">${dots}</span>
      </div>
      <div class="run-body"><div class="run-clip"><div class="run-scroll">
        ${turn.steps.length > 1 ? `<button type="button" class="run-sub" aria-expanded="${turn.state !== 'done'}"><span class="chev" aria-hidden="true">${chevron}</span><span>${esc(summary)}</span>${durationMarkup(turn.steps)}</button>` : ''}
        <div class="steps">${turn.steps.map((step, index) => stepMarkup(step, index, { open: step.err === true })).join('')}</div>
        <div class="run-foot"><span class="credits">${turn.credits ? `派蒙 · ${esc(turn.credits)} credits` : '用量结算中'}</span><span>${turn.tokens ? `输入 ${turn.tokens.up.toLocaleString('zh-CN')} / 输出 ${turn.tokens.out.toLocaleString('zh-CN')} tokens` : ''}</span></div>
      </div></div></div>
    </div>
    ${turn.prose ? `<div class="prose">${turn.prose}</div>` : ''}
  </div>`;
}

/* ---------------- B：左侧时间线，默认只留最后两步 ---------------- */

function renderB(turn) {
  const steps = turn.steps;
  const keep = activeTurn(turn) || turn.state === 'failed' ? steps.length : Math.min(2, steps.length);
  const hidden = steps.slice(0, steps.length - keep);
  const shown = steps.slice(steps.length - keep);
  const clock = `${turnLabel(turn)} · ${turnClock(turn)}`;
  return `<div class="v-b">
    <div class="track-head"><span>${clock}</span><span class="sp"></span>${statMarkup(turn)}<span>${turn.credits ? `${turn.credits} credits` : '用量结算中'}</span></div>
    <div class="track" data-track>
      ${hidden.length ? `<button type="button" class="more-steps" data-reveal>＋ 更早的 ${hidden.length} 步 · ${esc(summaryOf(hidden))}${durationMarkup(hidden)}</button>` : ''}
      <div data-shown>${shown.map((step, index) => stepMarkup(step, steps.length - keep + index, { open: step.err === true })).join('')}</div>
    </div>
    ${turn.prose ? `<div class="prose" style="margin-top:12px">${turn.prose}</div>` : ''}
  </div>`;
}

/* ---------------- C：流程压成一行，明细进右侧面板 ---------------- */

function renderC(turn) {
  const steps = turn.steps;
  const label = `${turnLabel(turn)} · ${steps.length} 步 · ${turnClock(turn)}`;
  return `<div class="v-c">
    <button type="button" class="trace-line" data-trace>
      <span class="trace-caret">${activeTurn(turn) ? '◍' : '›'}</span><b>${label}</b><span class="trace-sum">${esc(compactSummaryOf(steps))}</span>
      <span class="sp"></span>${statMarkup(turn)}<span class="trace-open">查看过程</span>
    </button>
    ${turn.prose ? `<div class="prose">${turn.prose}</div>` : ''}
    <aside class="trace-panel" data-trace-panel data-open="false" aria-label="这一轮的过程">
      <div class="trace-h"><b>这一轮的过程</b><span class="tok">${turnClock(turn)}</span><button type="button" class="trace-close" data-trace-close aria-label="关闭">×</button></div>
      <div class="trace-b">${steps.map((step, index) => stepMarkup(step, index, { open: true })).join('')}</div>
      <div class="trace-f">派蒙 · ${usageFoot(turn)}</div>
    </aside>
  </div>`;
}

const RENDERERS = { A: renderA, B: renderB, C: renderC };

/* ---------------- 渲染与交互 ---------------- */

const app = document.getElementById('app');
const inner = document.getElementById('chat-inner');
const label = document.getElementById('proto-label');
const scroll = document.getElementById('chat-scroll');

const params = new URLSearchParams(location.search);
let variant = params.get('variant') || 'A';
let state = params.get('state') || 'done';
if (!RENDERERS[variant]) variant = 'A';
if (!['done', 'thinking', 'running', 'failed'].includes(state)) state = 'done';
let ticker = null;

function writeUrl() {
  const url = new URL(location.href);
  url.searchParams.set('variant', variant);
  url.searchParams.set('state', state);
  history.replaceState(null, '', url);
}

function paint() {
  document.body.dataset.state = state;
  app.dataset.state = state;
  app.dataset.variant = variant;
  const data = scenario(state);
  inner.innerHTML = data.turns.map(turn => turn.role === 'user'
    ? `<div class="msg msg--user"><div class="msg-h"><b>你</b><span>${esc(turn.time)}</span></div><div class="body">${esc(turn.text)}</div></div>`
    : `<div class="msg"><div class="msg-h"><b>派蒙</b><span>${esc(turn.time)}</span>${turn.note ? `<span>· ${esc(turn.note)}</span>` : ''}</div>${RENDERERS[variant](turn)}</div>`).join('');

  const meta = VARIANTS.find(item => item.key === variant);
  label.textContent = `${variant} (${meta.name}) · ${state}`;
  document.querySelectorAll('[data-state-set]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.stateSet === state));
  });
  writeUrl();
  startTicker();
  scroll.scrollTop = scroll.scrollHeight;
}

function startTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  if (state !== 'thinking' && state !== 'running') return;
  const startedAt = performance.now();
  const clocks = [...document.querySelectorAll('[data-elapsed]')];
  ticker = setInterval(() => {
    const elapsed = (performance.now() - startedAt) / 1000;
    clocks.forEach(node => { node.textContent = formatElapsed(Number(node.dataset.elapsed) + elapsed); });
  }, 100);
}

/* 三个变体各自的折叠交互（挂在 document 上：状态按钮与变体条在对话列之外） */
document.addEventListener('click', event => {
  const stepHeader = event.target.closest('.step-h');
  if (stepHeader) {
    const step = stepHeader.parentElement;
    const open = step.dataset.open !== 'true';
    step.dataset.open = String(open);
    stepHeader.setAttribute('aria-expanded', String(open));
    step.querySelector('.step-body').hidden = !open;
    return;
  }
  const runHeader = event.target.closest('.run-h');
  if (runHeader) {
    const run = runHeader.closest('.run');
    const open = run.dataset.open !== 'true';
    run.dataset.open = String(open);
    runHeader.setAttribute('aria-expanded', String(open));
    return;
  }
  const runSub = event.target.closest('.run-sub');
  if (runSub) {
    const expanded = runSub.getAttribute('aria-expanded') !== 'true';
    runSub.setAttribute('aria-expanded', String(expanded));
    return;
  }
  const reveal = event.target.closest('[data-reveal]');
  if (reveal) {
    const track = reveal.closest('[data-track]');
    const data = scenario(state);
    const steps = data.turns[1].steps;
    reveal.remove();
    track.querySelector('[data-shown]').innerHTML = steps.map((step, index) => stepMarkup(step, index, { open: step.err === true })).join('');
    return;
  }
  if (event.target.closest('[data-trace]')) {
    document.querySelector('[data-trace-panel]').dataset.open = 'true';
    return;
  }
  if (event.target.closest('[data-trace-close]')) {
    document.querySelector('[data-trace-panel]').dataset.open = 'false';
    return;
  }
  const arrow = event.target.closest('[data-step]');
  if (arrow) { cycle(Number(arrow.dataset.step)); return; }
  const stateButton = event.target.closest('[data-state-set]');
  if (stateButton) { state = stateButton.dataset.stateSet; paint(); }
});

function cycle(direction) {
  const index = VARIANTS.findIndex(item => item.key === variant);
  variant = VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length].key;
  paint();
}

document.addEventListener('keydown', event => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); cycle(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); cycle(1); }
});

paint();
