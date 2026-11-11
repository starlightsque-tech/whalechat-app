
/* =========================================================================
   WhaleChat live trades — capital-backed positions with real-time P&L,
   take-profit / stop-loss, duration auto-close and manual exit.
   Open positions live in DB.trades (status 'Open') so they sync everywhere.
   ========================================================================= */
'use strict';

const LT = {
  MIN_CAPITAL: 5,
  DURATIONS: [
    { label: '5 min', m: 5 }, { label: '15 min', m: 15 }, { label: '1 hour', m: 60 },
    { label: '4 hours', m: 240 }, { label: '1 day', m: 1440 }
  ],

  cfg() {
    if (!DB) return { leverage: 5 };
    if (!DB.invest) DB.invest = { feePct: 0.5, paused: {}, seededAt: Date.now() };
    if (!DB.invest.leverage) DB.invest.leverage = 5;
    return DB.invest;
  },
  leverage() { return Math.min(20, Math.max(1, Number(this.cfg().leverage) || 1)); },
  feePct() { return Math.max(0, Number(this.cfg().feePct) || 0); },
  all(userId) {
    if (!Array.isArray(DB.trades)) DB.trades = [];
    return DB.trades.filter(t => t.userId === (userId || me().id) && t.type === 'live');
  },
  open(userId) { return this.all(userId).filter(t => t.status === 'Open'); },
  closed(userId) { return this.all(userId).filter(t => t.status !== 'Open').sort((a, b) => b.closedAt - a.closedAt); },

  /* live numbers for a position */
  calc(t) {
    const q = INV.quote(t.ticker) || { price: t.entryPrice };
    const dir = t.side === 'short' ? -1 : 1;
    const move = t.entryPrice ? (q.price - t.entryPrice) / t.entryPrice : 0;
    let pnlCoins = t.capitalCoins * (t.leverage || 1) * move * dir;
    pnlCoins = Math.max(-t.capitalCoins, pnlCoins);          /* never lose more than the stake */
    const payout = Math.max(0, t.capitalCoins + pnlCoins);
    return {
      price: q.price,
      prev: q.prevClose,
      movePct: move * 100 * dir,
      pnlCoins: Math.round(pnlCoins * 100) / 100,
      pnlUsd: coinsToUsd(pnlCoins),
      pnlPct: t.capitalCoins ? (pnlCoins / t.capitalCoins) * 100 : 0,
      payoutCoins: Math.round(payout * 100) / 100,
      totalLoss: payout <= 0,
      left: Math.max(0, (t.expiresAt || 0) - Date.now())
    };
  },

  /* ---------------- open a position ---------------- */
  start(side, ticker, capitalCoins, opts) {
    const u = me();
    const s = INV.stock(ticker);
    if (!u || !s) return false;
    const o = opts || {};
    const capital = Math.round((Number(capitalCoins) || 0) * 100) / 100;
    if (capital < this.MIN_CAPITAL) { toast('Minimum trade is ' + this.MIN_CAPITAL + ' WC', 'err'); return false; }
    if (capital > u.balance) { toast('Not enough Whale Coin — top up your wallet', 'err'); return false; }
    if (INV.paused && INV.paused(ticker)) { toast(ticker + ' trading is paused', 'err'); return false; }
    const q = INV.quote(ticker);
    if (!q) return false;

    const fee = Math.round(capital * this.feePct() / 100 * 100) / 100;
    const minutes = Math.max(1, Math.min(7 * 24 * 60, Number(o.minutes) || 60));
    const trade = {
      id: uid('lt'), userId: u.id, type: 'live', ticker, name: s.name, side: side === 'short' ? 'short' : 'long',
      capitalCoins: capital, entryPrice: q.price, leverage: this.leverage(),
      tpPct: Math.max(0, Math.min(500, Number(o.tpPct) || 0)),
      slPct: Math.max(0, Math.min(100, Number(o.slPct) || 0)),
      expiresAt: Date.now() + minutes * 60000,
      status: 'Open', createdAt: Date.now(), feeCoins: fee
    };
    u.balance = Math.round((u.balance - capital - fee) * 100) / 100;
    DB.trades.unshift(trade);
    tx(u.id, 'trade-open', `${side === 'short' ? 'Short' : 'Long'} ${ticker} · ${coins(capital)} WC`, -capital - fee,
      { tradeId: trade.id, leverage: trade.leverage, entry: q.price });
    notify(u.id, 'Trade opened',
      `${side === 'short' ? 'Short' : 'Long'} ${ticker} with ${coins(capital)} WC at ${usd(q.price)} — closes in ${minutes} min.`,
      '#/invest/orders', 'trend');
    persist(); toast('Trade started — tracking live', 'ok'); render();
    return true;
  },

  /* ---------------- settle ---------------- */
  settle(t, reason) {
    if (!t || t.status !== 'Open') return false;
    const u = findUser(t.userId);
    if (!u) return false;
    const p = this.calc(t);
    const payout = p.totalLoss ? 0 : p.payoutCoins;
    u.balance = Math.round((u.balance + payout) * 100) / 100;
    t.status = 'Completed';
    t.closedAt = Date.now();
    t.closeReason = reason;
    t.exitPrice = p.price;
    t.pnlCoins = p.pnlCoins;
    t.pnlUsd = p.pnlUsd;
    t.payoutCoins = payout;
    t.result = p.totalLoss ? 'loss' : p.pnlCoins > 0 ? 'profit' : 'flat';

    tx(u.id, 'trade-close', `${t.ticker} trade ${reason} · ${payout ? '+' + coins(payout) + ' WC returned' : 'total loss'}`,
      payout, { tradeId: t.id, pnlCoins: p.pnlCoins, reason });

    if (p.totalLoss) {
      notify(u.id, 'Trade closed — total loss',
        `${t.ticker} moved against your position and the stake was lost. Nothing was returned.`,
        '#/invest/orders', 'ban');
      toast(`${t.ticker} closed at a total loss`, 'err');
    } else if (p.pnlCoins >= 0) {
      notify(u.id, 'Take profit — trade closed',
        `${t.ticker} closed with +${coins(p.pnlCoins)} WC profit. ${coins(payout)} WC (capital + profit) was credited.`,
        '#/invest/orders', 'trend');
      toast(`Profit taken — ${coins(payout)} WC credited`, 'ok');
    } else {
      notify(u.id, 'Trade closed at a loss',
        `${t.ticker} closed with −${coins(Math.abs(p.pnlCoins))} WC. ${coins(payout)} WC of capital was returned.`,
        '#/invest/orders', 'down');
      toast(`Trade stopped — ${coins(payout)} WC returned`, 'ok');
    }
    try { sync(); } catch (e) {}
    persist();
    render();
    return true;
  },

  /* auto close on target / stop / expiry */
  auto() {
    if (!DB || !DB.trades) return;
    this.open().forEach(t => {
      const p = this.calc(t);
      if (t.tpPct > 0 && p.pnlPct >= t.tpPct) return void this.settle(t, 'Take profit target hit');
      if (t.slPct > 0 && p.pnlPct <= -t.slPct) return void this.settle(t, 'Stop loss hit');
      if (t.expiresAt && Date.now() >= t.expiresAt) return void this.settle(t, 'Time limit reached');
    });
  },

  /* ---------------- view helpers ---------------- */
  clock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60), s = total % 60;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  },

  cardHTML(t) {
    const p = this.calc(t);
    const s = INV.stock(t.ticker) || { ticker: t.ticker, color: '#3aa0ff' };
    const up = p.pnlCoins > 0, down = p.pnlCoins < 0;
    const dirLabel = t.side === 'short' ? 'Short' : 'Long';
    return `<div class="lt-card" data-lt="${t.id}">
      <div class="row" style="gap:9px;align-items:center">
        ${INV.logoHTML(s, 32)}
        <div class="grow" style="min-width:0">
          <div class="small" style="font-weight:700">${esc(t.ticker)}
            <span class="lt-side ${t.side}">${dirLabel} ${t.leverage}×</span></div>
          <div class="tiny muted">${coins(t.capitalCoins)} WC · entry ${usd(t.entryPrice)}</div>
        </div>
        <span class="lt-mini">${INV.spark(t.ticker)}</span>
        <div style="text-align:right">
          <div class="lt-pnl ${up ? 'up' : down ? 'down' : ''}" data-lt-pnl="${t.id}">
            ${p.pnlCoins >= 0 ? '+' : '−'}${coins(Math.abs(p.pnlCoins))} WC</div>
          <div class="tiny ${up ? 'up' : down ? 'down' : 'muted'}" data-lt-pct="${t.id}">
            ${p.pnlPct >= 0 ? '+' : '−'}${Math.abs(p.pnlPct).toFixed(2)}%</div>
        </div>
      </div>
      <div class="lt-row">
        <span class="tiny muted">Price <b data-lt-price="${t.id}">${usd(p.price)}</b>
          <span data-lt-move="${t.id}" class="${p.movePct >= 0 ? 'up' : 'down'}">${p.movePct >= 0 ? '▲' : '▼'} ${Math.abs(p.movePct).toFixed(2)}%</span></span>
        <span class="tiny muted" data-lt-left="${t.id}">⏱ ${this.clock(p.left)}</span>
      </div>
      <div class="lt-bar"><i style="width:${Math.min(100, Math.max(0, 50 + p.pnlPct))}%"
        class="${up ? 'up' : down ? 'down' : ''}"></i></div>
      <div class="row" style="gap:7px;margin-top:9px">
        <button class="btn btn-sm btn-primary grow" data-act="lt-tp" data-id="${t.id}">
          ${ic('trend', 13)} Take profit ${p.pnlCoins > 0 ? '(+' + coins(p.pnlCoins) + ')' : ''}</button>
        <button class="btn btn-sm btn-ghost grow" data-act="lt-sl" data-id="${t.id}">
          ${ic('down', 13)} Stop trade ${p.pnlCoins < 0 ? '(−' + coins(Math.abs(p.pnlCoins)) + ')' : ''}</button>
      </div>
      <div class="tiny muted center" style="margin-top:6px">Returns ${coins(p.payoutCoins)} WC if closed now</div>
    </div>`;
  },

  closedRow(t) {
    const pnl = Number(t.pnlCoins) || 0;
    const win = pnl > 0, lost = t.result === 'loss';
    return `<div class="inv-row" style="align-items:flex-start">
      <div class="grow" style="min-width:0">
        <div class="small" style="font-weight:650">${esc(t.ticker)} ${t.side === 'short' ? 'Short' : 'Long'}
          <span class="tiny muted">· ${t.leverage}× · ${esc(t.closeReason || 'closed')}</span></div>
        <div class="tiny muted">${coins(t.capitalCoins)} WC @ ${usd(t.entryPrice)} → ${usd(t.exitPrice || 0)} · ${dateLabel(t.closedAt)} ${clockTime(t.closedAt)}</div>
        <div class="tiny ${win ? 'up' : lost ? 'down' : 'muted'}">
          ${lost ? 'Total loss — nothing returned' : (win ? '+' : '') + coins(pnl) + ' WC P/L'} ·
          returned ${coins(t.payoutCoins || 0)} WC</div>
      </div>
      <span class="badge ${win ? 'badge-success' : lost ? 'badge-danger' : 'badge-warn'}">
        ${lost ? 'Lost' : win ? 'Profit' : 'Flat'}</span></div>`;
  },

  /* ---------------- live paint ---------------- */
  paint() {
    this.open().forEach(t => {
      const p = this.calc(t);
      const set = (sel, txt) => { const el = document.querySelector(sel); if (el) el.textContent = txt; };
      set('[data-lt-pnl="' + t.id + '"]', (p.pnlCoins >= 0 ? '+' : '−') + coins(Math.abs(p.pnlCoins)) + ' WC');
      set('[data-lt-pct="' + t.id + '"]', (p.pnlPct >= 0 ? '+' : '−') + Math.abs(p.pnlPct).toFixed(2) + '%');
      set('[data-lt-price="' + t.id + '"]', usd(p.price));
      set('[data-lt-move="' + t.id + '"]', (p.movePct >= 0 ? '▲ ' : '▼ ') + Math.abs(p.movePct).toFixed(2) + '%');
      set('[data-lt-left="' + t.id + '"]', '⏱ ' + this.clock(p.left));
      document.querySelectorAll('[data-lt-pnl="' + t.id + '"], [data-lt-pct="' + t.id + '"]').forEach(el => {
        el.classList.toggle('up', p.pnlCoins > 0);
        el.classList.toggle('down', p.pnlCoins < 0);
      });
      document.querySelectorAll('[data-lt-move="' + t.id + '"]').forEach(el => {
        el.classList.toggle('up', p.movePct >= 0);
        el.classList.toggle('down', p.movePct < 0);
      });
      const bar = document.querySelector('[data-lt="' + t.id + '"] .lt-bar i');
      if (bar) {
        bar.style.width = Math.min(100, Math.max(0, 50 + p.pnlPct)) + '%';
        bar.className = p.pnlCoins >= 0 ? 'up' : 'down';
      }
      const ret = document.querySelector('[data-lt="' + t.id + '"] .tiny.muted.center');
      if (ret) ret.textContent = 'Returns ' + coins(p.payoutCoins) + ' WC if closed now';
    });
  },

  /* ---------------- mounts ---------------- */
  activeBlock() {
    const list = this.open();
    if (!list.length) return '';
    return `<div class="card lt-panel" id="ltActive">
      <div class="between"><div class="card-title" style="margin:0">Active trades
        <span class="badge badge-accent" style="margin-left:6px">${list.length} live</span></div>
        <span class="tiny muted">updates every 2s</span></div>
      ${list.map(t => this.cardHTML(t)).join('')}
    </div>`;
  },

  closedBlock() {
    const list = this.closed().slice(0, 8);
    if (!list.length) return '';
    return `<div class="card"><div class="card-title">Closed trades</div>
      <div class="inv-list">${list.map(t => this.closedRow(t)).join('')}</div></div>`;
  },

  /* opened-position ticket, rendered on the stock page */
  ticketHTML(ticker) {
    const s = INV.stock(ticker); if (!s) return '';
    const q = INV.quote(ticker);
    const lev = this.leverage();
    return `<div class="card" id="ltTicket">
      <div class="between"><div class="card-title" style="margin:0">Live trade · ${esc(ticker)}</div>
        <span class="badge">${lev}× leverage</span></div>
      <div class="tiny muted" style="margin:4px 0 10px;line-height:1.6">
        Put Whale Coin behind a position. Profit and loss move with the price in real time — take profit, stop the trade, or let the timer close it for you.</div>
      <div class="lt-side-pick">
        <button class="lt-side-btn ${'on'}" data-act="lt-side" data-side="long">▲ Long (price rises)</button>
        <button class="lt-side-btn" data-act="lt-side" data-side="short">▼ Short (price falls)</button>
      </div>
      <div class="field"><label class="label">Capital (Whale Coin)</label>
        <div class="input-wrap"><span class="inv-prefix">WC</span>
          <input class="input" id="ltCapital" type="number" step="1" min="${this.MIN_CAPITAL}" placeholder="0"/></div>
        <div class="tiny muted" id="ltCapitalUsd">≈ $0.00 · balance ${coins(me().balance)} WC</div></div>
      <div class="row" style="gap:8px">
        <div class="field grow"><label class="label">Take profit %</label>
          <input class="input" id="ltTp" type="number" step="1" min="0" placeholder="off"/></div>
        <div class="field grow"><label class="label">Stop loss %</label>
          <input class="input" id="ltSl" type="number" step="1" min="0" placeholder="off"/></div>
      </div>
      <div class="field"><label class="label">Time limit</label>
        <select class="input" id="ltDuration">${this.DURATIONS.map(d => `<option value="${d.m}" ${d.m === 60 ? 'selected' : ''}>${d.label}</option>`).join('')}</select></div>
      <button class="btn btn-primary btn-block" data-act="lt-start" data-t="${esc(ticker)}" style="width:100%">
        ${ic('play', 15)} Start trade</button>
      <div class="tiny muted center mt6">${ic('lock', 11)} Capital is held until the trade closes · ${this.feePct()}% fee</div>
    </div>`;
  }
};


/* ---------------- styles ---------------- */
(function () {
  if (document.getElementById('lt-style')) return;
  const st = document.createElement('style');
  st.id = 'lt-style';
  st.textContent = `
  .lt-panel .card-title{display:flex;align-items:center}
  .lt-card{border:1px solid var(--border);border-radius:14px;padding:11px;margin-top:10px;
    background:linear-gradient(160deg,var(--surface-2),var(--surface));position:relative;overflow:hidden}
  .lt-card:first-of-type{margin-top:6px}
  .lt-side{font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:6px;margin-left:5px}
  .lt-side.long{background:rgba(47,214,166,.16);color:var(--success)}
  .lt-side.short{background:rgba(255,95,116,.16);color:var(--danger)}
  .lt-pnl{font-family:var(--display);font-weight:800;font-size:15px;font-variant-numeric:tabular-nums}
  .lt-row{display:flex;justify-content:space-between;gap:8px;margin-top:8px;align-items:center}
  .lt-bar{height:5px;border-radius:99px;background:var(--surface-3);overflow:hidden;margin-top:8px}
  .lt-bar i{display:block;height:100%;border-radius:99px;transition:width .35s ease}
  .lt-bar i.up{background:linear-gradient(90deg,#2fd6a6,#2ee6c9)}
  .lt-bar i.down{background:linear-gradient(90deg,#ff5f74,#ff8a5b)}
  .lt-side-pick{display:flex;gap:6px;margin-bottom:10px}
  .lt-side-btn{flex:1;padding:9px 6px;border-radius:11px;border:1px solid var(--border);background:var(--surface-2);
    color:var(--muted);font-size:11.5px;font-weight:700;cursor:pointer;transition:all .15s ease}
  .lt-side-btn.on{border-color:rgba(46,230,201,.55);color:var(--text);background:linear-gradient(135deg,rgba(46,230,201,.16),rgba(58,160,255,.12))}
  .lt-mini{display:inline-block;width:46px;height:22px;margin:0 6px;vertical-align:middle;opacity:.9;flex:0 0 auto}
  .lt-mini svg{width:100%;height:100%;display:block}
  `;
  document.head.appendChild(st);
})();

/* keep spot orders and live positions apart: the spot Orders view expects shares */
(function () {
  if (typeof INV === 'undefined' || INV.__ltPatched) return;
  const base = INV.trades;
  INV.trades = function (userId) {
    return base.call(INV, userId).filter(t => t.type !== 'live');
  };
  INV.__ltPatched = true;
})();

/* ---------------- actions ---------------- */
App.ltSide = function (id, ds) {
  document.querySelectorAll('.lt-side-btn').forEach(b => b.classList.toggle('on', b.dataset.side === ds.side));
  document.querySelectorAll('.lt-side-btn').forEach(b => b.dataset.side && b.classList.toggle('on', b.getAttribute('data-side') === ds.side));
};
App.ltStart = function (id, ds) {
  const capEl = document.getElementById('ltCapital');
  const capital = Number(capEl && capEl.value) || 0;
  const sideEl = document.querySelector('.lt-side-btn.on');
  const side = sideEl ? sideEl.getAttribute('data-side') : 'long';
  const tp = Number((document.getElementById('ltTp') || {}).value) || 0;
  const sl = Number((document.getElementById('ltSl') || {}).value) || 0;
  const minutes = Number((document.getElementById('ltDuration') || {}).value) || 60;
  LT.start(side, ds.t, capital, { tpPct: tp, slPct: sl, minutes });
};
App.ltTp = function (id, ds) { const t = DB.trades.find(x => x.id === ds.id); LT.settle(t, 'Take profit — closed manually'); };
App.ltSl = function (id, ds) { const t = DB.trades.find(x => x.id === ds.id); LT.settle(t, 'Stopped manually'); };

/* ---------------- mounts ---------------- */
function ltMountDashboard() {
  if (!document.querySelector('.inv-hero')) return;
  if (document.getElementById('ltActiveMount')) return;
  const block = LT.activeBlock();
  if (!block) return;
  const host = document.createElement('div');
  host.id = 'ltActiveMount';
  host.innerHTML = block;
  const anchor = document.querySelector('.inv-actions');
  const chart = document.querySelector('.inv-chartcard');
  if (anchor && anchor.nextSibling) anchor.parentNode.insertBefore(host, anchor.nextSibling);
  else if (chart) chart.parentNode.insertBefore(host, chart);
  else return;
}

function ltMountOrders() {
  const head = document.querySelector('.page-head');
  if (!head || !/Orders/.test(head.textContent || '')) return;
  if (document.getElementById('ltOrdersMount')) return;
  const host = document.createElement('div');
  host.id = 'ltOrdersMount';
  host.innerHTML = LT.activeBlock() + LT.closedBlock();
  if (!host.innerHTML.trim()) return;
  head.parentNode.insertBefore(host, head.nextSibling);
}

function ltMountStock() {
  const hash = location.hash || '';
  const m = hash.match(/^#\/invest\/stock\/([A-Z0-9.]+)/i);
  if (!m) return;
  if (document.getElementById('ltTicket')) return;
  const content = document.getElementById('content');
  if (!content) return;
  const host = document.createElement('div');
  host.innerHTML = LT.ticketHTML(m[1].toUpperCase()) + LT.activeBlock();
  content.appendChild(host);
  const cap = document.getElementById('ltCapital');
  if (cap) cap.addEventListener('input', () => {
    const usdEl = document.getElementById('ltCapitalUsd');
    if (usdEl) usdEl.textContent = '≈ ' + usd(coinsToUsd(Number(cap.value) || 0)) + ' · balance ' + coins(me().balance) + ' WC';
  });
}

/* charts on every holding row (market page already charts every stock) */
function ltChartsOnHoldings() {
  document.querySelectorAll('.inv-row[href*="/invest/stock/"]').forEach(row => {
    if (row.querySelector('.lt-mini')) return;
    const ticker = (row.getAttribute('href') || '').split('/').pop().split('?')[0];
    if (!ticker || !INV.stock(ticker)) return;
    const wrap = document.createElement('span');
    wrap.className = 'lt-mini';
    wrap.innerHTML = INV.spark(ticker);
    const priceCol = row.lastElementChild;
    if (priceCol && priceCol.parentNode === row) row.insertBefore(wrap, priceCol);
    else row.appendChild(wrap);
  });
}

AFTER.invest = (function (orig) {
  return function (parts, params) {
    try { if (orig) orig(parts, params); } catch (e) {}
    try {
      ltMountDashboard(); ltMountOrders(); ltMountStock(); ltChartsOnHoldings();
    } catch (e) { console.error('live trade mount', e); }
  };
})(AFTER.invest);

/* ---------------- engine ---------------- */
setInterval(() => {
  try {
    if (!DB || !me() || document.hidden) return;
    LT.auto();
    LT.paint();
  } catch (e) { console.error('lt tick', e); }
}, 2000);

/* catch the app after login/first paint too */
setInterval(() => {
  try {
    if (!DB || !me()) return;
    if (document.querySelector('.inv-hero')) ltMountDashboard();
    else if (location.hash.indexOf('#/invest/stock/') === 0) ltMountStock();
  } catch (e) {}
}, 2500);
