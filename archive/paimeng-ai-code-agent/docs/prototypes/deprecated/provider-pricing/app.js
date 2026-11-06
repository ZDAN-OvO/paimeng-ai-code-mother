'use strict';

/* 原型：提供商模型与单价。静态数据，无网络请求，刷新即重置。 */

const NOW = '2026-11-02 07:00:10';

const COST_BASIS = { peak: '上游峰时价', 'off-peak': '上游谷时价', unknown: '上游成本未知' };
const CAP_LABELS = { streaming: '流式', toolCalling: '工具调用', structuredOutput: '结构化输出' };

const state = {
  fx: 7.2,
  multiplier: 2,
  providers: [
    { id: 'env-default', name: '默认提供商' },
    { id: 'env-secondary', name: '第二提供商' },
  ],
  models: [
    {
      id: 'm_codegen', providerId: 'env-default', name: 'test-codegen-model',
      caps: { streaming: true, toolCalling: true, structuredOutput: false },
      price: { miss: 6, hit: 0.12, out: 25 },
      upstream: null,
      history: [{ at: '2026-10-01 00:00:00', price: { miss: 6, hit: 0.12, out: 25 } }],
    },
    {
      id: 'm_route', providerId: 'env-default', name: 'test-route-model',
      caps: { streaming: false, toolCalling: false, structuredOutput: true },
      price: { miss: 2, hit: 0.05, out: 8 },
      upstream: null,
      history: [{ at: '2026-10-01 00:00:00', price: { miss: 2, hit: 0.05, out: 8 } }],
    },
    {
      id: 'm_codegen_second', providerId: 'env-secondary', name: 'test-codegen-model',
      caps: { streaming: true, toolCalling: true, structuredOutput: true },
      price: null,
      upstream: null,
      history: [],
    },
    {
      id: 'm_flash', providerId: 'env-default', name: 'deepseek-flash',
      caps: { streaming: true, toolCalling: true, structuredOutput: false },
      price: { miss: 6, hit: 0.12, out: 25 },
      upstream: { miss: 0.3, hit: 0.006, out: 1.2, basis: 'peak', source: 'https://api-docs.deepseek.com/quick_start/pricing' },
      history: [
        { at: '2026-10-01 00:00:00', price: { miss: 6, hit: 0.12, out: 25 } },
        { at: '2026-08-01 00:00:00', price: { miss: 5, hit: 0.1, out: 21 } },
      ],
    },
    {
      id: 'm_pro', providerId: 'env-default', name: 'deepseek-v4-pro',
      caps: { streaming: true, toolCalling: true, structuredOutput: true },
      price: { miss: 26, hit: 0.5, out: 85 },
      upstream: { miss: null, hit: null, out: null, basis: 'unknown', source: '' },
      history: [{ at: '2026-10-01 00:00:00', price: { miss: 26, hit: 0.5, out: 85 } }],
    },
    {
      id: 'm_whisper', providerId: 'env-secondary', name: 'whisper-large-v3',
      caps: { streaming: false, toolCalling: false, structuredOutput: false },
      price: { miss: 0.5, hit: 0, out: 2 },
      upstream: null,
      history: [{ at: '2026-10-01 00:00:00', price: { miss: 0.5, hit: 0, out: 2 } }],
    },
  ],
  slots: [
    { slot: 'codegen.default', label: '代码生成', optional: false, requires: ['streaming', 'toolCalling'], purpose: '生成与修复应用源码的主力模型', impact: '无法生成应用，所有生成请求都会被拒绝', modelId: 'm_codegen' },
    { slot: 'route.classify', label: '类型路由', optional: false, requires: ['structuredOutput'], purpose: '从用户需求里识别要生成的工程类型', impact: '无法识别工程类型，生成请求会被拒绝', modelId: 'm_route' },
    { slot: 'version.summary', label: '版本标题', optional: true, requires: [], purpose: '给每个版本写一句 20 字以内的页面变化说明', impact: '版本标题改用 agent 收尾原话兜底', modelId: 'm_flash' },
    { slot: 'speech.transcribe', label: '语音转写', optional: true, requires: [], purpose: '把浏览器录到的语音转成文字', impact: '聊天页麦克风按钮禁用并提示未配置', modelId: null },
  ],
  ui: {
    variant: 'A',
    selected: 'm_flash',
    drawer: null,
    expanded: null,
    draft: null,
    modalOpen: false,
    add: null,
    toast: '',
  },
};

/* ---------- 工具 ---------- */

const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function trimNum(n, digits) {
  return Number(n).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function fmtY(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `¥${trimNum(value, 4)}`;
}

function fmtUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return '未知';
  return `$${trimNum(value, 6)}`;
}

function providerName(id) {
  return state.providers.find((p) => p.id === id)?.name ?? id;
}

function byId(id) {
  return state.models.find((m) => m.id === id) ?? null;
}

function priced(model) {
  return !!model?.price;
}

function capList(model) {
  const list = Object.keys(CAP_LABELS).filter((cap) => model.caps[cap]);
  return list.length ? list : [];
}

function capTags(model, emptyText = '无硬性能力') {
  const list = capList(model);
  if (!list.length) return `<span class="faint">${emptyText}</span>`;
  return list.map((cap) => `<span class="tag">${CAP_LABELS[cap]}</span>`).join('');
}

function refsOf(model) {
  return state.slots.filter((slot) => slot.modelId === model.id);
}

function eligible(slot, model) {
  return priced(model) && slot.requires.every((cap) => model.caps[cap]);
}

function slotStatus(slot) {
  const model = byId(slot.modelId);
  if (!model) return { tone: 'warn', text: slot.optional ? '未分配，可选' : '必需槽位未分配' };
  if (!priced(model)) return { tone: 'danger', text: '绑定的模型缺价，不能分配' };
  if (!slot.requires.every((cap) => model.caps[cap])) return { tone: 'danger', text: '能力不满足槽位要求' };
  return { tone: 'ok', text: '已定价' };
}

function upstreamRmb(model) {
  const up = model.upstream;
  if (!up || up.out == null) return null;
  return { miss: up.miss * state.fx, hit: up.hit * state.fx, out: up.out * state.fx };
}

function marginOf(model, price) {
  const up = upstreamRmb(model);
  if (!up || !price || !price.out) return null;
  return (price.out - up.out) / price.out;
}

function openDraft(model) {
  state.ui.draft = {
    modelId: model.id,
    miss: model.price ? String(model.price.miss) : '',
    hit: model.price ? String(model.price.hit) : '',
    out: model.price ? String(model.price.out) : '',
    at: NOW,
  };
}

function draftFor(model) {
  if (!state.ui.draft || state.ui.draft.modelId !== model.id) openDraft(model);
  return state.ui.draft;
}

function variant() {
  return state.ui.variant;
}

function setVariant(next) {
  state.ui.variant = next;
  state.ui.drawer = null;
  state.ui.expanded = null;
  if (next === 'C' && !byId(state.ui.selected)) state.ui.selected = state.models[0]?.id;
  history.replaceState(null, '', `?variant=${next}`);
  render();
}

function cycle(step) {
  const order = ['A', 'B', 'C'];
  const index = order.indexOf(variant());
  setVariant(order[(index + step + order.length) % order.length]);
}

let toastTimer = null;
function toast(message) {
  state.ui.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.ui.toast = '';
    render();
  }, 2600);
  render();
}

/* ---------- 公共片段 ---------- */

function topbar() {
  return `
    <header class="topbar">
      <div class="brand"><span class="dot"></span>模型与计价</div>
      <div class="note">单价只有一处：提供商模型；槽位反向引用模型。</div>
      <div class="spacer"></div>
      <span class="env">管理端原型 · 静态数据</span>
    </header>`;
}

function noteBar() {
  return `
    <div class="model-note">
      <span><b>费率已并入模型</b> Rate card 页面取消，不再有两套价格</span>
      <span><b>引用方向</b> 槽位 → 提供商模型，模型行上的「被引用」是派生的</span>
      <span><b>缺价不可分配</b> 没填单价的模型不出现在槽位下拉里</span>
      <span><b>默认定价</b> 登记新模型时按上游 × 2 × 汇率预填</span>
    </div>`;
}

function priceTrio(model) {
  if (!priced(model)) {
    return `<span class="tag tag-danger">缺价</span><div class="hint">上游价未取到，不能分配</div>`;
  }
  return `
    <div class="price-trio">
      <span><i>未命中</i><b>${fmtY(model.price.miss)}</b></span>
      <span><i>命中</i><b>${fmtY(model.price.hit)}</b></span>
      <span><i>输出</i><b>${fmtY(model.price.out)}</b></span>
    </div>`;
}

function upstreamCell(model) {
  const up = model.upstream;
  if (!up || (up.miss == null && up.hit == null && up.out == null)) {
    return `<span class="muted">未知</span>`;
  }
  const rmb = upstreamRmb(model);
  return `
    <div class="mono">${fmtUsd(up.miss)} · ${fmtUsd(up.hit)} · ${fmtUsd(up.out)}</div>
    <div class="hint">${COST_BASIS[up.basis]}${rmb ? ` · 折 ${fmtY(rmb.miss)} / ${fmtY(rmb.hit)} / ${fmtY(rmb.out)}` : ''}</div>`;
}

function refsCell(model) {
  const refs = refsOf(model);
  if (!refs.length) return `<span class="faint">未被引用</span>`;
  return `<div class="chips">${refs.map((s) => `<span class="tag mono">${s.slot}</span>`).join('')}</div>`;
}

function slotSelect(slot) {
  const current = slot.modelId;
  const currentModel = byId(current);
  const options = state.models.filter((m) => eligible(slot, m));
  const stale = currentModel && !options.some((m) => m.id === current);
  return `
    <select data-change="assign" data-slot="${slot.slot}">
      <option value="">未分配</option>
      ${stale ? `<option value="${currentModel.id}" selected disabled>${esc(currentModel.name)}（缺价 / 能力不足）</option>` : ''}
      ${options.map((m) => `<option value="${m.id}" ${m.id === current ? 'selected' : ''}>${esc(providerName(m.providerId))} / ${esc(m.name)}</option>`).join('')}
    </select>`;
}

function requirementTags(slot) {
  if (!slot.requires.length) return `<span class="faint">无硬性能力</span>`;
  return slot.requires.map((cap) => `<span class="tag tag-primary">${CAP_LABELS[cap]}</span>`).join('');
}

function draftInputs(model, columns) {
  const draft = draftFor(model);
  return `
    <div class="price-inputs" style="${columns ? '' : 'margin-bottom:10px'}">
      <label>未命中输入（¥/1M）<input type="number" step="0.0001" min="0" data-draft="miss" value="${esc(draft.miss)}"></label>
      <label>缓存命中输入（¥/1M）<input type="number" step="0.0001" min="0" data-draft="hit" value="${esc(draft.hit)}"></label>
      <label>输出（¥/1M）<input type="number" step="0.0001" min="0" data-draft="out" value="${esc(draft.out)}"></label>
    </div>
    <div class="field" style="max-width:260px">
      <label>生效时间（UTC）</label>
      <input type="text" data-draft="at" value="${esc(draft.at)}">
    </div>`;
}

function historyList(model) {
  if (!model.history.length) return `<div class="hint">还没有价格版本。补齐单价后，这里记录每次调价。</div>`;
  return `
    <ul class="history">
      ${model.history.map((item, index) => `
        <li>
          <span class="t">${esc(item.at)}${index === 0 ? ' · 现行' : ''}</span>
          <span class="v">${fmtY(item.price.miss)} / ${fmtY(item.price.hit)} / ${fmtY(item.price.out)}</span>
        </li>`).join('')}
    </ul>`;
}

function billingFootnote() {
  return `<p class="hint" style="margin:18px 2px 0">账本仍按 Credit 记账（1 Credit = ¥0.01），¥ 单价在结算时换算；调价只影响生效时间之后的调用，历史账单按当时的费率快照，不重算。</p>`;
}

function upstreamBlock(model) {
  const up = model.upstream;
  if (!up || (up.miss == null && up.hit == null && up.out == null)) {
    return `<div class="upstream-box"><div class="empty">上游成本未知。未知就记未知，不拿售价折算冒充成本。</div></div>`;
  }
  return `
    <div class="upstream-box">
      <div class="prices">
        <span>未命中 ${fmtUsd(up.miss)}</span>
        <span>命中 ${fmtUsd(up.hit)}</span>
        <span>输出 ${fmtUsd(up.out)}</span>
      </div>
      <div class="hint" style="margin-top:6px">${COST_BASIS[up.basis]}${up.source ? ` · <a href="${esc(up.source)}" target="_blank" rel="noreferrer">来源</a>` : ''}</div>
    </div>`;
}

/* ---------- A：台账 ---------- */

function viewA() {
  return `
    <div class="shell">
      ${noteBar()}
      <div class="section-head">
        <div>
          <h1>提供商模型</h1>
          <p>单价与模型同处一张表，单位 ¥ / 1M tokens。调价生成新版本，只影响生效时间之后的调用。</p>
        </div>
        <div class="grow"></div>
        <button class="btn btn-primary" data-action="add-model">登记模型</button>
      </div>
      <div class="panel ledger-wrap" style="margin-bottom:22px">
        <table class="ledger">
          <thead>
            <tr>
              <th>提供商</th>
              <th>模型 · 能力</th>
              <th class="group">单价 <span class="unit">¥ / 1M tokens</span></th>
              <th>上游参考</th>
              <th>被引用</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${state.models.map((m) => `
              <tr>
                <td><div class="strong">${esc(providerName(m.providerId))}</div><div class="mono muted">${m.providerId}</div></td>
                <td><div class="strong mono">${esc(m.name)}</div><div class="chips" style="margin-top:4px">${capTags(m)}</div></td>
                <td>${priceTrio(m)}</td>
                <td>${upstreamCell(m)}</td>
                <td>${refsCell(m)}</td>
                <td class="nowrap"><button class="btn btn-ghost" data-action="edit" data-model="${m.id}">${priced(m) ? '调价' : '补价'}</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="section-head">
        <div>
          <h1>模型分配</h1>
          <p>槽位由代码定义；这里只决定每个槽位引用哪个已定价模型。</p>
        </div>
      </div>
      <div class="panel">
        <table class="assign-table">
          <thead><tr><th>槽位</th><th>用途</th><th>需要能力</th><th>引用模型</th><th>状态</th></tr></thead>
          <tbody>
            ${state.slots.map((s) => {
              const st = slotStatus(s);
              return `
                <tr>
                  <td><div class="mono strong">${s.slot}</div><div class="muted">${s.label}${s.optional ? ' · 可选' : ' · 必需'}</div></td>
                  <td class="muted">${s.purpose}</td>
                  <td><div class="chips">${requirementTags(s)}</div></td>
                  <td>${slotSelect(s)}</td>
                  <td><span class="tag ${st.tone === 'ok' ? 'tag-ok' : st.tone === 'danger' ? 'tag-danger' : 'tag-warn'}">${st.text}</span></td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${billingFootnote()}
    </div>`;
}

/* ---------- B：槽位优先 ---------- */

function viewB() {
  return `
    <div class="shell">
      ${noteBar()}
      <div class="section-head">
        <div>
          <h1>模型分配</h1>
          <p>先看槽位：每个槽位只能引用已定价且能力满足的模型。缺价模型不在下拉里，也不显示为可选项。</p>
        </div>
        <div class="grow"></div>
        <button class="btn btn-primary" data-action="add-model">登记模型</button>
      </div>
      <div class="slot-grid">
        ${state.slots.map((s) => {
          const st = slotStatus(s);
          return `
            <article class="panel slot-card ${st.tone === 'danger' ? 'is-missing' : ''}">
              <div class="slot-top">
                <span class="mono slot-id">${s.slot}</span>
                <span class="tag ${s.optional ? '' : 'tag-primary'}">${s.optional ? '可选' : '必需'}</span>
              </div>
              <h3>${s.label}</h3>
              <p>${s.purpose}</p>
              <div class="chips">${requirementTags(s)}</div>
              ${slotSelect(s)}
              <div class="slot-foot">${st.tone === 'ok' ? '<span class="dot"></span>' : ''}<span>${st.text}</span></div>
            </article>`;
        }).join('')}
      </div>

      <div class="section-head">
        <div>
          <h1>模型清单</h1>
          <p>单价就地维护；缺价的行标红，补齐之前不能出现在任何槽位里。</p>
        </div>
      </div>
      <div class="panel inv">
        ${state.models.map((m) => {
          const expanded = state.ui.expanded === m.id;
          return `
            <div class="inv-row ${priced(m) ? '' : 'is-unpriced'}">
              <div class="inv-main-row">
                <div>
                  <div class="strong mono">${esc(m.name)}</div>
                  <div class="muted">${esc(providerName(m.providerId))} / ${m.providerId}</div>
                </div>
                <div class="chips">${capTags(m)}</div>
                <div>${priceTrio(m)}</div>
                <div>${refsCell(m)}</div>
                <div class="inv-actions">
                  ${m.upstream && m.upstream.out != null ? `<button class="btn btn-ghost" data-action="sync-upstream" data-model="${m.id}">按 2× 上游</button>` : ''}
                  <button class="btn btn-ghost" data-action="edit" data-model="${m.id}">${priced(m) ? '调价' : '补价'}</button>
                </div>
              </div>
              ${expanded ? `
                <div class="inline-editor">
                  ${draftInputs(m)}
                  <div style="display:flex;gap:8px;padding-bottom:1px">
                    <button class="btn btn-primary" data-action="save-price" data-model="${m.id}">保存并生效</button>
                    <button class="btn" data-action="cancel-edit">取消</button>
                  </div>
                </div>` : ''}
            </div>`;
        }).join('')}
      </div>
      ${billingFootnote()}
    </div>`;
}

/* ---------- C：定价工作台 ---------- */

function viewC() {
  const selected = byId(state.ui.selected) ?? state.models[0];
  if (!selected) return '<div class="shell">没有模型。</div>';
  const draft = draftFor(selected);
  const price = {
    miss: num(draft.miss),
    hit: num(draft.hit),
    out: num(draft.out),
  };
  const margin = marginOf(selected, price);
  const upRmb = upstreamRmb(selected);

  return `
    <div class="shell">
      ${noteBar()}
      <div class="workbench">
        <aside class="panel model-list">
          <div class="list-head">
            <strong>提供商模型</strong>
            <span class="muted">${state.models.length}</span>
            <div class="grow"></div>
            <button class="btn btn-ghost" data-action="add-model">＋ 登记</button>
          </div>
          ${state.models.map((m) => `
            <button class="m-item ${m.id === selected.id ? 'is-active' : ''}" data-action="select-model" data-model="${m.id}">
              <div class="row1">
                <span class="dot ${priced(m) ? '' : 'is-missing'}"></span>
                <span class="name">${esc(m.name)}</span>
                ${priced(m) ? '' : '<span class="tag tag-danger">缺价</span>'}
              </div>
              <div class="row2">
                <span>${esc(providerName(m.providerId))}</span>
                <span class="p">${priced(m) ? `${fmtY(m.price.miss)} / ${fmtY(m.price.out)}` : '不可分配'}</span>
              </div>
            </button>`).join('')}
        </aside>

        <section class="panel detail">
          <div class="detail-head">
            <div>
              <h2>${esc(selected.name)}</h2>
              <div class="muted">${esc(providerName(selected.providerId))} / ${selected.providerId}</div>
            </div>
            <div class="grow" style="flex:1"></div>
            <div class="chips">${capTags(selected)}</div>
            ${priced(selected) ? '<span class="tag tag-ok">已定价</span>' : '<span class="tag tag-danger">缺价</span>'}
          </div>

          <div class="detail-grid">
            <div class="block">
              <h4>上游成本
                <span class="grow"></span>
                <span class="tag tag-quiet">USD / 1M tokens</span>
              </h4>
              ${upstreamBlock(selected)}
              <div class="form-row two" style="margin-top:12px">
                <div class="field">
                  <label>汇率（USD → ¥）</label>
                  <input type="number" step="0.01" min="0" data-change="fx" value="${state.fx}">
                </div>
                <div class="field">
                  <label>默认倍率</label>
                  <select data-change="multiplier">
                    ${[1.5, 2, 2.5, 3].map((n) => `<option value="${n}" ${n === state.multiplier ? 'selected' : ''}>× ${n}</option>`).join('')}
                  </select>
                </div>
              </div>
              ${upRmb ? `<p class="formula">上游折人民币：${fmtY(upRmb.miss)} / ${fmtY(upRmb.hit)} / ${fmtY(upRmb.out)}　·　× ${state.multiplier} 后：${fmtY(upRmb.miss * state.multiplier)} / ${fmtY(upRmb.hit * state.multiplier)} / ${fmtY(upRmb.out * state.multiplier)}</p>` : '<p class="formula">上游成本未知，无法预填。</p>'}
              ${upRmb ? `<div class="detail-actions"><button class="btn" data-action="recalc" data-model="${selected.id}">按 × ${state.multiplier} 上游重算</button><span class="hint">只改输入，保存后才生效</span></div>` : ''}
            </div>

            <div class="block">
              <h4>我们的单价 <span class="tag tag-quiet">¥ / 1M tokens</span></h4>
              ${draftInputs(selected)}
              <div class="margin">
                <span class="muted">输出毛利</span>
                <b class="${margin == null ? 'muted' : margin > 0 ? 'ok-text' : 'danger-text'}">${margin == null ? '未知' : `${(margin * 100).toFixed(1)}%`}</b>
                <span class="hint">按输出单价与上游输出成本</span>
              </div>
              <div class="detail-actions">
                <button class="btn btn-primary" data-action="save-price" data-model="${selected.id}">保存并生效</button>
                <span class="hint">${priced(selected) ? `下一版生效时间：${esc(draft.at)}` : '缺价模型不能分配到任何槽位'}</span>
              </div>
            </div>
          </div>

          <div class="block" style="margin-top:14px">
            <h4>价格历史 <span class="grow"></span><span class="tag tag-quiet">调价只影响生效时间之后</span></h4>
            ${historyList(selected)}
          </div>

          <div class="block" style="margin-top:14px">
            <h4>被以下槽位引用 <span class="grow"></span><span class="hint">槽位引用模型；模型不存槽位</span></h4>
            ${refsOf(selected).length
              ? `<div class="chips">${refsOf(selected).map((s) => `<span class="tag tag-primary mono">${s.slot}</span>`).join('')}</div>`
              : '<span class="faint">没有被任何槽位引用</span>'}
          </div>
        </section>
      </div>

      <div class="slot-strip">
        ${state.slots.map((s) => {
          const st = slotStatus(s);
          return `
            <div class="panel slot-mini">
              <div class="top"><span class="mono">${s.slot}</span><span class="tag ${s.optional ? '' : 'tag-primary'}">${s.optional ? '可选' : '必需'}</span></div>
              ${slotSelect(s)}
              <div class="foot">${st.text}</div>
            </div>`;
        }).join('')}
      </div>
      ${billingFootnote()}
    </div>`;
}

/* ---------- 抽屉 / 弹窗 ---------- */

function drawer() {
  const model = byId(state.ui.drawer);
  if (!model) return '';
  return `
    <div class="overlay" data-action="close-drawer"></div>
    <aside class="drawer">
      <div class="drawer-head">
        <div>
          <div class="strong">调价</div>
          <div class="mono muted">${esc(model.name)} · ${esc(providerName(model.providerId))}</div>
        </div>
        <div class="grow"></div>
        <button class="btn btn-ghost" data-action="close-drawer">关闭</button>
      </div>
      <div class="drawer-body">
        <h4 class="strong" style="margin:0 0 8px">上游参考</h4>
        ${upstreamBlock(model)}
        <h4 class="strong" style="margin:18px 0 8px">我们的单价</h4>
        ${draftInputs(model)}
        <h4 class="strong" style="margin:18px 0 8px">价格历史</h4>
        ${historyList(model)}
      </div>
      <div class="drawer-foot">
        <button class="btn" data-action="cancel-edit">取消</button>
        <button class="btn btn-primary" data-action="save-price" data-model="${model.id}">保存并生效</button>
      </div>
    </aside>`;
}

function addModal() {
  const add = state.ui.add;
  if (!add) return '';
  const fetched = add.fetched;
  const upstream = add.upstream;
  return `
    <div class="overlay" data-action="close-modal"></div>
    <div class="modal">
      <div class="modal-head">
        <div>
          <div class="strong">登记提供商模型</div>
          <div class="hint">同一个请求名在不同提供商下是两条身份；单价跟着身份走。</div>
        </div>
        <div class="grow"></div>
        <button class="btn btn-ghost" data-action="close-modal">关闭</button>
      </div>
      <div class="modal-body">
        <div class="form-row two">
          <div class="field">
            <label>提供商</label>
            <select data-change="add-provider">
              ${state.providers.map((p) => `<option value="${p.id}" ${p.id === add.providerId ? 'selected' : ''}>${p.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>请求名（模型 ID）</label>
            <input type="text" data-add="name" value="${esc(add.name)}" placeholder="例如 deepseek-chat">
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn" data-action="fetch-upstream" ${add.loading ? 'disabled' : ''}>${add.loading ? '正在获取…' : '获取上游价格'}</button>
          <span class="hint">按公开价目表查询；查不到就留空，模型存为缺价。</span>
        </div>

        ${fetched ? (upstream && upstream.out != null ? `
          <div class="upstream-box">
            <div class="line"><strong>已获取</strong><span class="tag tag-quiet">USD / 1M</span><div class="grow"></div><span class="hint">${COST_BASIS[upstream.basis]}</span></div>
            <div class="prices">
              <span>未命中 ${fmtUsd(upstream.miss)}</span>
              <span>命中 ${fmtUsd(upstream.hit)}</span>
              <span>输出 ${fmtUsd(upstream.out)}</span>
            </div>
            <p class="formula">默认售价 = 上游 × ${state.multiplier} × 汇率 ${state.fx} → ${fmtY(upstream.miss * state.multiplier * state.fx)} / ${fmtY(upstream.hit * state.multiplier * state.fx)} / ${fmtY(upstream.out * state.multiplier * state.fx)}</p>
          </div>` : `
          <div class="upstream-box is-missing">
            <div class="empty">没有查到公开价格。可以手工填单价，也可以先存为缺价；缺价模型不能分配。</div>
          </div>`) : ''}

        <div class="form-row three">
          <div class="field">
            <label>未命中输入（¥/1M）</label>
            <input type="number" step="0.0001" min="0" data-add="miss" value="${esc(add.draft.miss)}">
          </div>
          <div class="field">
            <label>缓存命中输入（¥/1M）</label>
            <input type="number" step="0.0001" min="0" data-add="hit" value="${esc(add.draft.hit)}">
          </div>
          <div class="field">
            <label>输出（¥/1M）</label>
            <input type="number" step="0.0001" min="0" data-add="out" value="${esc(add.draft.out)}">
          </div>
        </div>
        <div class="field" style="max-width:280px">
          <label>生效时间（UTC）</label>
          <input type="text" data-add="at" value="${esc(add.draft.at)}">
        </div>

        <div class="field">
          <label>能力（决定能进哪些槽位）</label>
          <div class="chips" style="gap:12px">
            ${Object.entries(CAP_LABELS).map(([cap, label]) => `
              <label style="display:flex;align-items:center;gap:6px;color:var(--text)">
                <input type="checkbox" data-change="add-cap" data-cap="${cap}" ${add.caps[cap] ? 'checked' : ''}> ${label}
              </label>`).join('')}
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn btn-primary" data-action="save-model">保存</button>
      </div>
    </div>`;
}

/* ---------- 渲染 ---------- */

function switcher() {
  const labels = { A: '台账式 · 单价随模型', B: '槽位优先 · 卡片分配', C: '定价工作台 · 主从' };
  return `
    <div class="switcher">
      <button data-action="prev" title="上一个（←）">‹</button>
      <div class="label"><b>${variant()}</b><span>${labels[variant()]}</span></div>
      <button data-action="next" title="下一个（→）">›</button>
    </div>`;
}

function render() {
  const view = variant() === 'A' ? viewA() : variant() === 'B' ? viewB() : viewC();
  $('#app').innerHTML = `
    ${topbar()}
    ${view}
    ${state.ui.drawer ? drawer() : ''}
    ${state.ui.modalOpen ? addModal() : ''}
    ${state.ui.toast ? `<div class="toast">${esc(state.ui.toast)}</div>` : ''}
    ${switcher()}`;
}

/* ---------- 交互 ---------- */

function openEditor(id) {
  const model = byId(id);
  if (!model) return;
  openDraft(model);
  if (variant() === 'A') state.ui.drawer = id;
  if (variant() === 'B') state.ui.expanded = id;
  if (variant() === 'C') state.ui.selected = id;
  render();
}

function saveDraft() {
  const draft = state.ui.draft;
  if (!draft) return;
  const model = byId(draft.modelId);
  if (!model) return;
  const price = { miss: num(draft.miss), hit: num(draft.hit), out: num(draft.out) };
  if (!price.miss && !price.hit && !price.out) {
    toast('至少填写一个大于 0 的单价');
    return;
  }
  model.price = price;
  model.history.unshift({ at: draft.at || NOW, price: { ...price } });
  const at = draft.at || NOW;
  state.ui.drawer = null;
  state.ui.expanded = null;
  state.ui.draft = null;
  if (variant() === 'C') openDraft(model);
  toast(`已保存：${model.name} 的新单价生效于 ${at}`);
}

function syncUpstream(id) {
  const model = byId(id);
  if (!model?.upstream || model.upstream.out == null) return;
  const price = {
    miss: upstreamRmb(model).miss * state.multiplier,
    hit: upstreamRmb(model).hit * state.multiplier,
    out: upstreamRmb(model).out * state.multiplier,
  };
  model.price = price;
  model.history.unshift({ at: NOW, price: { ...price } });
  state.ui.draft = null;
  toast(`已按上游 × ${state.multiplier} 更新单价`);
}

function recalcDraft() {
  const model = byId(state.ui.selected);
  if (!model?.upstream || model.upstream.out == null) return;
  const rmb = upstreamRmb(model);
  const draft = draftFor(model);
  draft.miss = String(trimNum(rmb.miss * state.multiplier, 4));
  draft.hit = String(trimNum(rmb.hit * state.multiplier, 4));
  draft.out = String(trimNum(rmb.out * state.multiplier, 4));
  toast(`已按上游 × ${state.multiplier} × 汇率 ${state.fx} 重算，保存后生效`);
}

const UPSTREAM_CATALOGUE = {
  'deepseek-chat': { miss: 0.28, hit: 0.028, out: 0.42, basis: 'off-peak', source: 'https://api-docs.deepseek.com/quick_start/pricing' },
  'deepseek-reasoner': { miss: 0.55, hit: 0.14, out: 2.19, basis: 'peak', source: 'https://api-docs.deepseek.com/quick_start/pricing' },
  'gpt-5-mini': { miss: 0.25, hit: 0.025, out: 2.0, basis: 'peak', source: 'https://platform.openai.com/docs/pricing' },
  'qwen3-max': { miss: 0.86, hit: 0.17, out: 3.44, basis: 'peak', source: 'https://help.aliyun.com/zh/model-studio/models' },
};

function openAdd() {
  state.ui.add = {
    providerId: state.providers[0].id,
    name: '',
    caps: { streaming: false, toolCalling: false, structuredOutput: false },
    upstream: null,
    fetched: false,
    loading: false,
    draft: { miss: '', hit: '', out: '', at: NOW },
  };
  state.ui.modalOpen = true;
  render();
}

function fetchUpstream() {
  const add = state.ui.add;
  if (!add) return;
  if (!add.name.trim()) {
    toast('先填模型 ID');
    return;
  }
  add.loading = true;
  render();
  setTimeout(() => {
    if (!state.ui.add) return;
    const found = UPSTREAM_CATALOGUE[add.name.trim().toLowerCase()] ?? null;
    add.loading = false;
    add.fetched = true;
    add.upstream = found;
    if (found) {
      add.draft = {
        miss: trimNum(found.miss * state.multiplier * state.fx, 4),
        hit: trimNum(found.hit * state.multiplier * state.fx, 4),
        out: trimNum(found.out * state.multiplier * state.fx, 4),
        at: NOW,
      };
    }
    render();
  }, 650);
}

function saveNewModel() {
  const add = state.ui.add;
  if (!add) return;
  const name = add.name.trim();
  if (!name) {
    toast('模型 ID 不能为空');
    return;
  }
  const price = {
    miss: num(add.draft.miss),
    hit: num(add.draft.hit),
    out: num(add.draft.out),
  };
  const hasPrice = price.miss + price.hit + price.out > 0;
  const model = {
    id: `m_${Date.now()}`,
    providerId: add.providerId,
    name,
    caps: { ...add.caps },
    price: hasPrice ? price : null,
    upstream: add.upstream,
    history: hasPrice ? [{ at: add.draft.at || NOW, price: { ...price } }] : [],
  };
  state.models.push(model);
  state.ui.modalOpen = false;
  state.ui.add = null;
  if (variant() === 'C') state.ui.selected = model.id;
  toast(hasPrice ? '已登记并设定单价，可以分配' : '已存为缺价：补齐单价之前不能分配');
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.model;
  switch (action) {
    case 'prev': cycle(-1); break;
    case 'next': cycle(1); break;
    case 'variant': setVariant(el.dataset.variant); break;
    case 'edit': openEditor(id); break;
    case 'select-model':
      state.ui.selected = id;
      openDraft(byId(id));
      render();
      break;
    case 'save-price': saveDraft(); break;
    case 'cancel-edit':
      state.ui.draft = null;
      state.ui.drawer = null;
      state.ui.expanded = null;
      render();
      break;
    case 'close-drawer': state.ui.drawer = null; render(); break;
    case 'sync-upstream': syncUpstream(id); break;
    case 'recalc': recalcDraft(); render(); break;
    case 'add-model': openAdd(); break;
    case 'close-modal': state.ui.modalOpen = false; state.ui.add = null; render(); break;
    case 'fetch-upstream': fetchUpstream(); break;
    case 'save-model': saveNewModel(); render(); break;
    default: break;
  }
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.dataset.draft && state.ui.draft) {
    state.ui.draft[el.dataset.draft] = el.value;
  }
  if (el.dataset.add && state.ui.add) {
    if (el.dataset.add === 'name') state.ui.add.name = el.value;
    else state.ui.add.draft[el.dataset.add] = el.value;
  }
});

document.addEventListener('change', (event) => {
  const el = event.target;
  const add = state.ui.add;
  if (el.dataset.change === 'assign') {
    const slot = state.slots.find((s) => s.slot === el.dataset.slot);
    if (slot) {
      slot.modelId = el.value || null;
      if (variant() === 'C' && byId(el.value)) {
        state.ui.selected = el.value;
        openDraft(byId(el.value));
      }
      render();
    }
    return;
  }
  if (el.dataset.change === 'fx') {
    state.fx = Number(el.value) || 0;
    render();
    return;
  }
  if (el.dataset.change === 'multiplier') {
    state.multiplier = Number(el.value) || 2;
    render();
    return;
  }
  if (!add) return;
  if (el.dataset.change === 'add-provider') {
    add.providerId = el.value;
    return;
  }
  if (el.dataset.change === 'add-cap') {
    add.caps[el.dataset.cap] = el.checked;
    return;
  }
});

document.addEventListener('keydown', (event) => {
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); cycle(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); cycle(1); }
  if (event.key === 'Escape') {
    state.ui.drawer = null;
    state.ui.modalOpen = false;
    state.ui.add = null;
    state.ui.draft = null;
    state.ui.expanded = null;
    render();
  }
});

(function init() {
  const requested = (new URLSearchParams(location.search).get('variant') || 'A').toUpperCase();
  state.ui.variant = ['A', 'B', 'C'].includes(requested) ? requested : 'A';
  if (state.ui.variant === 'C') state.ui.selected = 'm_flash';
  render();
}());
