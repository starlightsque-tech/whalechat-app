
/* =========================================================================
   WhaleChat live trades — capital-backed positions with real-time P&L,
   take-profit / stop-loss, duration auto-close and manual exit.
   Open positions live in DB.trades (status 'Open') so they sync everywhere.
   ========================================================================= */
'use strict';

const LT_COIN = (typeof COIN_USD === 'number') ? COIN_USD : 0.5;

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
          ${ic('down', 13)} Take loss ${p.pnlCoins < 0 ? '(−' + coins(Math.abs(p.pnlCoins)) + ')' : ''}</button>
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
    this.paintEarnings();
  },

  /* the hero "Earnings" figure follows the live trades, not old holdings */
  paintEarnings() {
    const el = document.querySelector('[data-lv="pv-earn"]');
    if (!el) return;
    const pos = this.open();
    const pnl = pos.reduce((sum, t) => sum + this.calc(t).pnlCoins, 0);
    el.textContent = (pnl >= 0 ? '+' : '\u2212') + coins(Math.abs(pnl)) + ' WC';
    el.classList.remove('up', 'down');
    if (pnl > 0) el.classList.add('up');
    else if (pnl < 0) el.classList.add('down');
    const cell = el.parentElement;
    const label = cell && cell.querySelector('.tiny.muted');
    if (label) label.textContent = pos.length ? 'Active trade earnings' : 'Earnings';
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

  /* the stock-page panel: buy to open, then take profit / take loss */
  ticketHTML(ticker) {
    const s = INV.stock(ticker); if (!s) return '';
    const lev = this.leverage();
    const pos = this.open().filter(t => t.ticker === ticker)[0];
    const head = `<div class="between"><div class="card-title" style="margin:0">Trade · ${esc(ticker)}</div>
        <span class="badge">${lev}×</span></div>`;

    if (pos) {
      return `<div class="card" id="ltTicket">
        ${head}
        <div class="tiny muted" style="margin:4px 0 10px">Your position is live and counting now — it is not waiting for the market.</div>
        ${this.cardHTML(pos)}
        <div class="row" style="gap:8px;margin-top:10px">
          <button class="btn btn-primary grow" data-act="lt-tp" data-id="${pos.id}">
            ${ic('trend', 15)} Take profit</button>
          <button class="btn btn-ghost grow" data-act="lt-sl" data-id="${pos.id}">
            ${ic('down', 15)} Take loss</button>
        </div>
        <div class="tiny muted center mt6">Profit: capital + gain · Loss: remaining capital · Total loss: nothing returned</div>
      </div>`;
    }

    return `<div class="card" id="ltTicket">
      ${head}
      <div class="tiny muted" style="margin:4px 0 10px;line-height:1.6">
        Enter your limit and how long the trade runs, then press <b>Buy</b>. The trade starts immediately and earns or loses in real time.</div>
      <div class="lt-side-pick">
        <button class="lt-side-btn on" data-act="lt-side" data-side="long">▲ Long (price rises)</button>
        <button class="lt-side-btn" data-act="lt-side" data-side="short">▼ Short (price falls)</button>
      </div>
      <div class="field"><label class="label">Capital (Whale Coin)</label>
        <div class="input-wrap"><span class="inv-prefix">WC</span>
          <input class="input" id="ltCapital" type="number" step="1" min="${this.MIN_CAPITAL}" placeholder="0"/></div>
        <div class="tiny muted" id="ltCapitalUsd">≈ $0.00 · balance ${coins(me().balance)} WC</div></div>
      <div class="row" style="gap:8px">
        <div class="field grow"><label class="label">Take profit %</label>
          <input class="input" id="ltTp" type="number" step="1" min="0" placeholder="limit"/></div>
        <div class="field grow"><label class="label">Take loss %</label>
          <input class="input" id="ltSl" type="number" step="1" min="0" placeholder="limit"/></div>
      </div>
      <div class="field"><label class="label">Trade duration</label>
        <select class="input" id="ltDuration">${this.DURATIONS.map(d => `<option value="${d.m}" ${d.m === 60 ? 'selected' : ''}>${d.label}</option>`).join('')}</select></div>
      <button class="btn btn-primary" data-act="lt-start" data-t="${esc(ticker)}" style="width:100%">
        ${ic('play', 15)} Buy</button>
      <div class="tiny muted center mt6">${ic('lock', 11)} Capital is held while the trade runs · ${this.feePct()}% fee · it closes by itself at your limit or when time is up</div>
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
  .lt-day{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:6px 11px;border-radius:99px;
    font-size:12px;background:rgba(255,255,255,.06);border:1px solid var(--border);font-variant-numeric:tabular-nums}
  .lt-day.up{color:var(--success);background:rgba(47,214,166,.10);border-color:rgba(47,214,166,.25)}
  .lt-day.down{color:var(--danger);background:rgba(255,95,116,.10);border-color:rgba(255,95,116,.25)}
  .lt-up{color:var(--success) !important;transition:color .2s ease}
  .lt-down{color:var(--danger) !important;transition:color .2s ease}
  .lt-push-banner{position:fixed;left:10px;right:10px;bottom:calc(env(safe-area-inset-bottom,0px) + 86px);z-index:940;
    display:flex;gap:9px;align-items:center;padding:10px 12px;border-radius:14px;
    background:var(--surface);border:1px solid var(--border-strong);box-shadow:var(--shadow)}
  .lt-push-ic{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,rgba(46,230,201,.18),rgba(58,160,255,.18));color:var(--accent);flex:0 0 auto}
  @media(min-width:760px){.lt-push-banner{left:auto;right:20px;bottom:20px;max-width:400px}}
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

/* ============================ 1D intraday data ============================
   The base engine generated a single point for 1D, so every 1D chart and every
   market sparkline rendered empty. Build a real intraday series instead. */
(function () {
  if (typeof INV === 'undefined' || INV.__lt1d) return;
  const baseSeries = INV.series;
  INV.series = function (ticker, tf) {
    if (tf !== '1D') return baseSeries.call(INV, ticker, tf);
    const s = INV.stock(ticker);
    if (!s) return [];
    const q = INV.quote(ticker);
    const key = ticker + '::1D';
    const cached = INV.seriesCache && INV.seriesCache[key];
    if (cached && cached.length > 20) { cached[cached.length - 1] = q.price; return cached; }
    const n = 78;                                  /* 5-minute bars across a session */
    const rnd = mulberry32(seedOf(ticker + '::1d'));
    const open = q.prevClose || q.price;
    const drift = (q.price - open) / n;
    const out = [];
    let v = open;
    for (let i = 0; i < n; i++) {
      v = v + drift + (rnd() - 0.5) * open * 0.0045;
      out.push(Math.max(0.01, v));
    }
    out[0] = open;
    out[n - 1] = q.price;
    INV.seriesCache = INV.seriesCache || {};
    INV.seriesCache[key] = out;
    return out;
  };
  INV.seriesCache = INV.seriesCache || {};
  INV.__lt1d = true;
})();

/* ======================= 2-second market ticker ==========================
   Every stock card shows live price, direction and a redrawn sparkline so a
   user can see whether it is rising or falling before opening a trade. */
LT.paintMarket = function () {
  if (!DB) return;
  const nodes = document.querySelectorAll('[data-lv]');
  if (!nodes.length) return;
  nodes.forEach(el => {
    const spec = el.getAttribute('data-lv') || '';
    const i = spec.indexOf(':');
    if (i < 0) return;
    const kind = spec.slice(0, i), ticker = spec.slice(i + 1);
    const q = INV.quote(ticker);
    if (!q) return;
    if (kind === 'price') {
      const txt = '$' + q.price.toFixed(2);
      if (el.textContent !== txt) {
        el.textContent = txt;
        el.classList.remove('lt-up', 'lt-down');
        el.classList.add(q.dir > 0 ? 'lt-up' : q.dir < 0 ? 'lt-down' : '');
        setTimeout(() => el.classList.remove('lt-up', 'lt-down'), 800);
      }
    } else if (kind === 'wc') {
      const txt = coins(usdToCoins(q.price)) + ' WC';
      if (el.textContent !== txt) el.textContent = txt;
    } else if (kind === 'pct') {
      const p = q.changePct;
      const txt = (p >= 0 ? '▲ +' : '▼ ') + Math.abs(p).toFixed(2) + '%';
      if (el.textContent !== txt) el.textContent = txt;
      el.classList.toggle('up', p > 0);
      el.classList.toggle('down', p < 0);
    }
  });
  /* redraw the mini charts on the market cards */
  document.querySelectorAll('[data-spark]').forEach(el => {
    const t = el.getAttribute('data-spark');
    const svg = INV.spark(t);
    if (svg && el.innerHTML !== svg) el.innerHTML = svg;
  });
  /* a live trade page chart should breathe too */
  const chart = document.querySelector('[data-lt-live-chart]');
  if (chart) {
    const t = chart.getAttribute('data-lt-live-chart');
    const tf = chart.getAttribute('data-lt-tf') || '1D';
    const mode = chart.getAttribute('data-lt-mode') || 'line';
    const vals = INV.series(t, tf);
    chart.innerHTML = mode === 'candle' ? INV.candleChart(vals) : INV.lineChart(vals, { h: 150 });
  }
};

/* =========================== dashboard (trade aware) ====================== */
const LT_WINDOW = { '1D': 864e5, '1W': 7 * 864e5, '1M': 30 * 864e5, '3M': 90 * 864e5, '1Y': 365 * 864e5, 'ALL': 730 * 864e5 };

LT.positions = function (userId) {
  const trades = LT.open(userId).map(t => {
    const p = LT.calc(t);
    return {
      kind: 'trade', trade: t, ticker: t.ticker, side: t.side, lev: t.leverage,
      capital: t.capitalCoins, entry: t.entryPrice, pnlCoins: p.pnlCoins,
      valueCoins: Math.max(0, t.capitalCoins + p.pnlCoins), pnlPct: p.pnlPct, price: p.price
    };
  });
  const spots = INV.holdings(userId).map(h => {
    const q = INV.quote(h.ticker) || { price: h.avgPrice, prevClose: h.avgPrice };
    const valueUsd = h.shares * q.price;
    return {
      kind: 'spot', holding: h, ticker: h.ticker, side: 'long', lev: 1,
      capital: usdToCoins(h.shares * h.avgPrice), entry: h.avgPrice,
      pnlCoins: usdToCoins(valueUsd - h.shares * h.avgPrice),
      valueCoins: usdToCoins(valueUsd),
      pnlPct: h.avgPrice ? (q.price / h.avgPrice - 1) * 100 : 0, price: q.price
    };
  });
  return trades.concat(spots);
};

LT.summary = function (userId) {
  const pos = LT.positions(userId);
  const valueCoins = pos.reduce((s, p) => s + p.valueCoins, 0);
  const capital = pos.reduce((s, p) => s + p.capital, 0);
  const pnl = pos.reduce((s, p) => s + p.pnlCoins, 0);
  const u = me();
  return {
    pos, valueCoins, capital, pnl,
    valueUsd: coinsToUsd(valueCoins),
    capitalUsd: coinsToUsd(capital),
    pnlUsd: coinsToUsd(pnl),
    pnlPct: capital ? (pnl / capital) * 100 : 0,
    cash: (u && u.balance) || 0,
    live: pos.filter(p => p.kind === 'trade').length
  };
};

/* series for the performance chart: spot holdings + live trades */
LT.seriesWithTrades = function (tf, userId) {
  const pos = LT.positions(userId);
  if (!pos.length) return [];
  const win = LT_WINDOW[tf] || LT_WINDOW['1M'];
  const now = Date.now();
  const series = pos.map(p => ({ p, data: INV.series(p.ticker, tf) }));
  const len = Math.max(...series.map(s => s.data.length));
  const out = [];
  for (let i = 0; i < len; i++) {
    let v = 0;
    series.forEach(({ p, data }) => {
      if (!data.length) { v += p.capital; return; }
      const price = data[Math.min(i, data.length - 1)];
      if (p.kind === 'spot') { v += (p.holding.shares * price) * (1 / COIN_USD); return; }
      const t = p.trade;
      const idx = Math.min(data.length - 1, i);
      const msAgo = (1 - idx / Math.max(1, data.length - 1)) * win;
      const started = now - (t.createdAt || now);
      if (msAgo > started) { v += p.capital; return; }           /* before entry: flat capital */
      const dir = t.side === 'short' ? -1 : 1;
      const move = t.entryPrice ? (price - t.entryPrice) / t.entryPrice : 0;
      const pnl = Math.max(-p.capital, p.capital * (t.leverage || 1) * move * dir);
      v += Math.max(0, p.capital + pnl);
    });
    out.push(v);
  }
  return out;
};

LT.allocSlices = function (userId) {
  const map = {};
  LT.positions(userId).forEach(p => { map[p.ticker] = (map[p.ticker] || 0) + p.valueCoins; });
  return Object.keys(map).map(t => ({ ticker: t, value: coinsToUsd(map[t]) })).sort((a, b) => b.value - a.value);
};

LT.dash = function (params) {
  const u = me();
  const s = LT.summary(u.id);
  const tf = (params && params.tf && LT_WINDOW[params.tf]) ? params.tf : '1M';
  const slices = LT.allocSlices(u.id);
  const cols = ['#2ee6c9', '#3aa0ff', '#8b7bff', '#ffc861', '#2fd6a6', '#ff7bb0', '#5ad1ff', '#ff9f5a'];
  const series = LT.seriesWithTrades(tf, u.id);
  const dayUp = s.pnl > 0, dayDown = s.pnl < 0;

  const quick = [
    { ic: 'download', label: 'Deposit', nav: '#/deposit' },
    { ic: 'send', label: 'Withdraw', nav: '#/withdraw' },
    { ic: 'trend', label: 'Buy', nav: '#/invest/market' },
    { ic: 'clock', label: 'Trades', nav: '#/invest/orders' },
    { ic: 'star', label: 'Watchlist', nav: '#/invest/watchlist' }
  ];

  return `
  <div class="page-head"><div class="between">
    <div class="section-title" style="margin:0">Invest</div>
    <div class="row" style="gap:8px">
      <a href="#/invest/orders" class="btn btn-sm btn-ghost">${ic('clock', 14)} Trades</a>
      <a href="#/invest/market" class="btn btn-sm btn-soft">${ic('search', 14)} Market</a>
    </div>
  </div></div>

  <div class="inv-hero">
    <div class="tiny muted">Total portfolio value</div>
    <div class="inv-big"><span data-ltd="value">${coins(s.valueCoins)}</span> <span class="inv-unit">WC</span></div>
    <div class="tiny muted" data-ltd="value-usd">≈ ${usd(s.valueUsd)} USD</div>
    <div class="lt-day ${dayUp ? 'up' : dayDown ? 'down' : ''}" data-ltd="day">
      ${ic(dayUp ? 'trend' : 'down', 14)}
      <b>${s.pnl >= 0 ? '+' : '−'}${usd_LT(Math.abs(s.pnlUsd))}</b>
      <span>(${s.pnl >= 0 ? '+' : '−'}${Math.abs(s.pnlPct).toFixed(2)}%) today</span>
    </div>
    <div class="inv-hero-grid">
      <div><span class="tiny muted">Invested</span><b data-ltd="invested">${coins(s.capital)} WC</b></div>
      <div><span class="tiny muted">Earnings${s.live ? ' · live' : ''}</span>
        <b class="${dayUp ? 'up' : dayDown ? 'down' : ''}" data-ltd="earnings">
          ${s.pnl >= 0 ? '+' : '−'}${coins(Math.abs(s.pnl))} WC</b></div>
      <div><span class="tiny muted">Available cash</span><b data-ltd="cash">${coins(s.cash)} WC</b></div>
    </div>
  </div>

  <div class="inv-actions">${quick.map(q => `<a href="${q.nav}" class="inv-act"><span class="inv-act-ic">${ic(q.ic, 18)}</span><span>${q.label}</span></a>`).join('')}</div>

  <div class="card inv-chartcard">
    <div class="between" style="align-items:center">
      <div><div class="card-title" style="margin:0">Portfolio performance</div>
        <div class="tiny muted">${s.pos.length ? tf + ' · live' : 'No positions yet'}</div></div>
      ${INV.seg(tf)}
    </div>
    <div class="inv-chart" id="ltDashChart" data-ltd-chart="${tf}">
      ${s.pos.length ? INV.lineChart(series, { h: 150 }) : `<div class="inv-empty">${ic('trend', 26)}<p class="small muted">Start a trade or buy stock to see performance.</p><a href="#/invest/market" class="btn btn-sm btn-primary">Explore market</a></div>`}
    </div>
  </div>

  <div class="inv-two">
    <div class="card">
      <div class="card-title">Allocation</div>
      <div id="ltDashAlloc">${slices.length ? `<div class="inv-alloc">${INV.donut(slices)}
        <div class="inv-legend">${slices.slice(0, 6).map((x, i) => `<div class="row" style="gap:7px;align-items:center">
          <i style="width:8px;height:8px;border-radius:3px;background:${cols[i % cols.length]};display:inline-block"></i>
          <span class="tiny ellipsis grow">${esc(x.ticker)}</span>
          <span class="tiny muted">${((x.value / (coinsToUsd(s.valueCoins) || 1)) * 100).toFixed(0)}%</span></div>`).join('')}</div></div>`
        : `<div class="inv-empty"><p class="small muted">Allocation appears once you own stocks or have a live trade.</p></div>`}</div>
    </div>

    <div class="card">
      <div class="between"><div class="card-title" style="margin:0">My positions</div>
        <span class="tiny muted">${s.pos.length} open</span></div>
      <div id="ltDashPos">${LT.positionsHTML(u.id)}</div>
    </div>
  </div>

  <div class="card inv-note">${ic('shield', 14)} <span class="tiny">Prices are simulated and move every 5 seconds. Values here include your live trades and stock holdings, at 1 WC = $0.50.</span></div>`;
};

function usd_LT(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }

LT.positionsHTML = function (userId) {
  const pos = LT.positions(userId);
  if (!pos.length) return `<div class="inv-empty">${ic('bag', 26)}<p class="small muted">No open positions. Buy a stock or start a trade to begin.</p><a href="#/invest/market" class="btn btn-sm btn-primary">Browse stocks</a></div>`;
  return `<div class="inv-list">${pos.map(p => {
    const stock = INV.stock(p.ticker) || { ticker: p.ticker, name: p.ticker, color: '#3aa0ff' };
    const up = p.pnlCoins > 0, down = p.pnlCoins < 0;
    const tag = p.kind === 'trade' ? `<span class="lt-side ${p.side}">${p.side === 'short' ? 'Short' : 'Long'} ${p.lev}×</span>` : '';
    return `<a class="inv-row" href="#/invest/stock/${p.ticker}">
      ${INV.logoHTML(stock)}
      <div class="grow" style="min-width:0">
        <div class="small ellipsis" style="font-weight:650">${esc(stock.name)} ${tag}</div>
        <div class="tiny muted">${coins(p.capital)} WC in · now ${coins(p.valueCoins)} WC</div>
      </div>
      <span class="lt-mini">${INV.spark(p.ticker)}</span>
      <div style="text-align:right">
        <div class="small" style="font-weight:650">${usd(p.price)}</div>
        <div class="tiny ${up ? 'up' : down ? 'down' : 'muted'}">${p.pnlCoins >= 0 ? '+' : '−'}${coins(Math.abs(p.pnlCoins))} WC (${p.pnlPct >= 0 ? '+' : '−'}${Math.abs(p.pnlPct).toFixed(2)}%)</div>
      </div></a>`;
  }).join('')}</div>`;
};

/* repaint the dashboard numbers, chart, allocation and positions in place */
LT.paintDash = function () {
  const u = me(); if (!u) return;
  const has = document.querySelector('[data-ltd="value"]');
  if (!has) return;
  const s = LT.summary(u.id);
  const set = (sel, txt) => { const el = document.querySelector(sel); if (el) el.textContent = txt; };
  set('[data-ltd="value"]', coins(s.valueCoins));
  set('[data-ltd="value-usd"]', '≈ ' + usd(s.valueUsd) + ' USD');
  set('[data-ltd="invested"]', coins(s.capital) + ' WC');
  set('[data-ltd="earnings"]', (s.pnl >= 0 ? '+' : '−') + coins(Math.abs(s.pnl)) + ' WC');
  set('[data-ltd="cash"]', coins(s.cash) + ' WC');
  const day = document.querySelector('[data-ltd="day"]');
  if (day) {
    day.className = 'lt-day ' + (s.pnl > 0 ? 'up' : s.pnl < 0 ? 'down' : '');
    day.innerHTML = `${ic(s.pnl >= 0 ? 'trend' : 'down', 14)}<b>${s.pnl >= 0 ? '+' : '−'}${usd_LT(Math.abs(s.pnlUsd))}</b>
      <span>(${s.pnl >= 0 ? '+' : '−'}${Math.abs(s.pnlPct).toFixed(2)}%) today</span>`;
  }
  const earn = document.querySelector('[data-ltd="earnings"]');
  if (earn) { earn.classList.toggle('up', s.pnl > 0); earn.classList.toggle('down', s.pnl < 0); }
  const chart = document.getElementById('ltDashChart');
  if (chart) {
    const tf = chart.getAttribute('data-ltd-chart') || '1M';
    const series = LT.seriesWithTrades(tf, u.id);
    chart.innerHTML = series.length ? INV.lineChart(series, { h: 150 })
      : `<div class="inv-empty">${ic('trend', 26)}<p class="small muted">No positions yet.</p></div>`;
  }
  const alloc = document.getElementById('ltDashAlloc');
  if (alloc) {
    const slices = LT.allocSlices(u.id);
    const cols = ['#2ee6c9', '#3aa0ff', '#8b7bff', '#ffc861', '#2fd6a6', '#ff7bb0', '#5ad1ff', '#ff9f5a'];
    alloc.innerHTML = slices.length ? `<div class="inv-alloc">${INV.donut(slices)}
      <div class="inv-legend">${slices.slice(0, 6).map((x, i) => `<div class="row" style="gap:7px;align-items:center">
        <i style="width:8px;height:8px;border-radius:3px;background:${cols[i % cols.length]};display:inline-block"></i>
        <span class="tiny ellipsis grow">${esc(x.ticker)}</span>
        <span class="tiny muted">${((x.value / (coinsToUsd(s.valueCoins) || 1)) * 100).toFixed(0)}%</span></div>`).join('')}</div></div>`
      : `<div class="inv-empty"><p class="small muted">Allocation appears once you own stocks or have a live trade.</p></div>`;
  }
  const posEl = document.getElementById('ltDashPos');
  if (posEl) posEl.innerHTML = LT.positionsHTML(u.id);
};

/* the dashboard itself */
INV.viewDash = function (params) { return LT.dash(params); };

/* ============================ admin audit log ============================ */
const AUDIT = {
  log(action, detail) {
    if (!DB) return;
    if (!Array.isArray(DB.audit)) DB.audit = [];
    const u = me();
    DB.audit.unshift({
      id: uid('au'), at: Date.now(),
      userId: u ? u.id : null, username: u ? u.username : 'system',
      action: String(action || 'action'), detail: String(detail || '').slice(0, 200)
    });
    if (DB.audit.length > 500) DB.audit.length = 500;
    try { sync(); } catch (e) {}
    persist();
  },
  list() { return (DB && Array.isArray(DB.audit)) ? DB.audit.slice() : []; }
};

/* record every admin action that changes the platform (deferred so every
   handler — including the ones defined further down — is already in place) */
setTimeout(function () {
  const wrap = (name, label, describe) => {
    const orig = App[name];
    if (typeof orig !== 'function' || orig.__audited) return;
    const wrapped = function (id, ds) {
      try { AUDIT.log(label, describe ? describe(id, ds) : (ds && ds.t ? ds.t : (id || ''))); } catch (e) {}
      return orig.apply(this, arguments);
    };
    wrapped.__audited = true;
    App[name] = wrapped;
  };
  wrap('invAdminAdd', 'Stock listed', () => 'new stock added');
  wrap('invAdminEdit', 'Stock edited', (id, ds) => (ds && ds.t) || '');
  wrap('invAdminDel', 'Stock deleted', (id, ds) => (ds && ds.t) || '');
  wrap('invAdminPause', 'Stock trading toggled', (id, ds) => (ds && ds.t) || '');
  wrap('invAdminFee', 'Trading fee changed', () => {
    const v = (document.getElementById('ivFeeInput') || {}).value;
    return v != null ? 'fee → ' + v + '%' : '';
  });
  wrap('invAdminBal', 'User balance edited', (id) => {
    const u = findUser(id); return u ? '@' + u.username : String(id || '');
  });
  wrap('ltSaveLeverage', 'Trade leverage changed', () => {
    const v = (document.getElementById('ltLeverage') || {}).value;
    return v != null ? 'leverage → ' + v + 'x' : '';
  });
  wrap('admPublish', 'Release published to all users', () => APP_VERSION);
  wrap('admMailSave', 'Email server configured', () => {
    const f = (document.getElementById('admMailFrom') || {}).value;
    return f ? 'sender ' + f : 'updated';
  });
  wrap('admPushToggle', 'Push notifications toggled for all users', () => {
    const on = !!(DB.settings && DB.settings.push && DB.settings.push.enabled);
    return on ? 'turning off' : 'turning on';
  });
}, 0);

/* ==================== admin: generate the wholesale catalogue ==================== */
App.admGenerateProducts = async function () {
  if (!await confirmDialog({ title: 'Generate wholesale products?',
    body: 'Adds 8 products with real product photography, specifications, wholesale prices and stock, ready for vendors to buy.',
    ok: 'Generate products' })) return;
  let cat = null;
  try {
    const res = await fetch('./products.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('catalogue not found');
    cat = await res.json();
  } catch (e) { return toast('Could not load the catalogue: ' + e.message, 'err'); }
  const items = (cat && cat.products) || [];
  if (!items.length) return toast('Catalogue is empty', 'err');
  if (!Array.isArray(DB.companyProducts)) DB.companyProducts = [];
  let added = 0, updated = 0;
  items.forEach(it => {
    const existing = DB.companyProducts.find(p => p.id === it.id)
      || DB.companyProducts.find(p => (p.name || '').toLowerCase() === String(it.name).toLowerCase());
    if (existing) {
      existing.name = it.name; existing.category = it.category; existing.priceUsd = it.priceUsd;
      existing.stock = Number(it.stock) || existing.stock || 0;
      existing.description = it.description; existing.image = it.image; existing.emoji = null;
      updated++;
    } else {
      DB.companyProducts.push({
        id: it.id, name: it.name, category: it.category, priceUsd: it.priceUsd,
        stock: Number(it.stock) || 0, description: it.description, image: it.image,
        emoji: null, createdAt: Date.now()
      });
      added++;
    }
  });
  try { AUDIT.log('Wholesale catalogue generated', added + ' added · ' + updated + ' updated'); } catch (e) {}
  try { sync(); } catch (e) {}
  persist();
  toast('Generated ' + items.length + ' products with real photos', 'ok');
  render();
};

function ltProductsCard() {
  const total = (DB.companyProducts || []).length;
  const withPics = (DB.companyProducts || []).filter(p => p.image).length;
  return `<div class="card mt16">
    <div class="between" style="align-items:center;flex-wrap:wrap;gap:10px">
      <div><div class="card-title" style="margin:0 0 4px">Generate products</div>
        <div class="small muted">8 wholesale products with real photography, specifications, prices and stock — ready for vendors to buy.</div></div>
      <button class="btn btn-primary" data-act="adm-generate-products">${ic('box', 15)} Generate products</button>
    </div>
    <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
      <span class="badge">${total} products</span>
      <span class="badge ${withPics ? 'badge-success' : 'badge-warn'}">${withPics} with photos</span>
      <span class="badge">Vendors only</span>
    </div>
    <div class="tiny muted mt10" style="line-height:1.7">
      Running it again refreshes names, specs, prices and photos on the same 8 products — it never duplicates them.
      Product photos are real studio shots shipped with the app, not illustrations or emoji.</div>
  </div>`;
}

function ltAuditView() {
  const rows = AUDIT.list();
  const tabs = `<div class="admin-nav">${ADMIN_NAV.map(n => {
    const key = n.href.replace('#/admin', '') || '';
    return `<a href="${n.href}" class="${key === '/audit' ? 'on' : ''}">${n.label}</a>`;
  }).join('')}</div>`;
  const groups = {};
  rows.forEach(r => { groups[r.action] = (groups[r.action] || 0) + 1; });
  return `${tabs}
  <div class="page-head"><div class="between">
    <div><div class="section-title" style="margin:0">Audit log</div>
      <div class="tiny muted">Every admin change, newest first</div></div>
    <span class="badge">${rows.length} entries</span>
  </div></div>
  ${rows.length ? `<div class="card"><div class="inv-list">
    ${rows.slice(0, 120).map(r => `<div class="inv-row" style="align-items:flex-start">
      <div class="grow" style="min-width:0">
        <div class="small" style="font-weight:650">${esc(r.action)}${r.detail ? ' · ' + esc(r.detail) : ''}</div>
        <div class="tiny muted">@${esc(r.username || 'system')} · ${dateLabel(r.at)} ${clockTime(r.at)}</div>
      </div>
      <span class="badge">${timeAgo(r.at)}</span></div>`).join('')}
  </div></div>` : `<div class="card"><div class="inv-empty">${ic('shield', 26)}<p class="small muted">No admin activity recorded yet.</p></div></div>`}`;
}

const _adminAudit = VIEWS.admin;
VIEWS.admin = function (parts, params) {
  if ((parts[1] || '') === 'products') {
    const u = me();
    if (u && u.role === 'admin') {
      const html = _adminAudit.apply(this, arguments);
      if (document.getElementById('ltProdCard')) return html;   /* one card only */
      setTimeout(() => {
        const anchorEl = document.querySelector('.admin-nav');
        if (!anchorEl || document.getElementById('ltProdCard')) return;
        const wrap = document.createElement('div');
        wrap.id = 'ltProdCard';
        wrap.innerHTML = ltProductsCard();
        const firstCard = document.querySelector('.admin-nav + .card, .admin-nav ~ .card');
        if (firstCard && firstCard.parentNode) firstCard.parentNode.insertBefore(wrap, firstCard);
        else document.getElementById('content').appendChild(wrap);
      }, 30);
      return html;
    }
    return _adminAudit.apply(this, arguments);
  }
  if ((parts[1] || '') === 'audit') {
    const u = me();
    if (!u || u.role !== 'admin') return `<div class="card empty"><div class="ic">${ic('lock', 26)}</div><h3>Admin access only</h3></div>`;
    return ltAuditView();
  }
  return _adminAudit.apply(this, arguments);
};
if (!ADMIN_NAV.some(n => n.key === 'admin-audit')) {
  ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0,
    { key: 'admin-audit', label: 'Audit', icon: 'eye', href: '#/admin/audit' });
}

/* ===================== vendor earnings + invest view ===================== */
LT.vendorStats = function (v) {
  const orders = (DB.orders || []).filter(o => o.vendorId === v.id && !['cancelled', 'refunded'].includes(o.status));
  const grossUsd = orders.reduce((s, o) => s + (Number(o.totalUsd) || 0), 0);
  const units = orders.reduce((s, o) => s + (o.items || []).reduce((n, i) => n + (Number(i.qty) || 0), 0), 0);
  const pending = orders.filter(o => ['processing', 'pending'].includes(o.status)).length;
  const paidCoins = orders.reduce((s, o) => s + (Number(o.totalCoins) || 0), 0);
  const demoOrders = orders.filter(o => o.simulated);
  const demoUsd = demoOrders.reduce((s, o) => s + (Number(o.totalUsd) || 0), 0);
  const u = findUser(v.userId) || {};
  return { orders: orders.length, grossUsd, units, pending, paidCoins, balance: u.balance || 0,
           demoOrders: demoOrders.length, demoUsd };
};

function ltVendorInvestCard(v) {
  const p = LT.summary(v.userId);
  const stat = (label, value, cls) => `<div><span class="tiny muted">${label}</span>
    <b class="${cls || ''}">${value}</b></div>`;
  return `<div class="card mt14">
    <div class="between" style="align-items:center">
      <div class="card-title" style="margin:0">Investments</div>
      <a href="#/invest" class="btn btn-xs btn-soft">${ic('trend', 12)} Open Invest</a>
    </div>
    <div class="inv-hero-grid" style="border-top:none;padding-top:2px;margin-top:6px">
      ${stat('Portfolio value', coins(p.valueCoins) + ' WC')}
      ${stat('Invested', coins(p.capital) + ' WC')}
      ${stat('Live earnings', (p.pnl >= 0 ? '+' : '−') + coins(Math.abs(p.pnl)) + ' WC', p.pnl >= 0 ? 'up' : 'down')}
    </div>
    <div class="tiny muted mt6">${p.live ? p.live + ' live trade' + (p.live === 1 ? '' : 's') + ' running' : 'No live trades'}
      · ${p.pos.length} position${p.pos.length === 1 ? '' : 's'}</div>
  </div>`;
}

const _vendorView = VIEWS.vendor;
VIEWS.vendor = function (parts, params) {
  const html = _vendorView.apply(this, arguments);
  try {
    if (parts[1]) return html;
    const v = vendorOf(me().id);
    if (!v) return html;
    const st = LT.vendorStats(v);
    const card = `<div class="card mt14">
      <div class="card-title">Store earnings</div>
      <div class="inv-hero-grid" style="border-top:none;padding-top:2px;margin-top:6px">
        <div><span class="tiny muted">Gross sales</span><b>${usd(st.grossUsd)}</b></div>
        <div><span class="tiny muted">Orders</span><b>${st.orders}</b>${st.pending ? `<span class="tiny muted"> · ${st.pending} open</span>` : ''}</div>
        <div><span class="tiny muted">Units sold</span><b>${st.units}</b></div>
      </div>
      <div class="between mt10"><span class="tiny muted">Credited to your wallet</span>
        <b class="small">${coins(st.paidCoins)} WC</b></div>
      <div class="between mt6"><span class="tiny muted">Wallet balance</span>
        <b class="small">${coins(st.balance)} WC</b></div>
      ${st.demoOrders ? `<div class="between mt6"><span class="tiny muted">Of which demo shoppers</span>
        <b class="tiny">${st.demoOrders} order${st.demoOrders === 1 ? '' : 's'} · ${usd(st.demoUsd)} <span class="muted">(simulated, not real revenue)</span></b></div>` : ''}
    </div>` + ltVendorInvestCard(v);
    return html + card;
  } catch (e) { console.error('vendor card', e); return html; }
};

/* ======================= per-stock P&L history =========================== */
LT.stockHistory = function (ticker) {
  const u = me(); if (!u) return '';
  const rows = (DB.trades || []).filter(t => t.userId === u.id && t.ticker === ticker && t.type === 'live' && t.status !== 'Open')
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  const spot = (DB.trades || []).filter(t => t.userId === u.id && t.ticker === ticker && t.type !== 'live' && t.status === 'Completed')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!rows.length && !spot.length) return '';
  const realized = rows.reduce((s, t) => s + (Number(t.pnlCoins) || 0), 0)
                 + spot.reduce((s, t) => s + usdToCoins(Number(t.plUsd) || 0), 0);
  const wins = rows.filter(t => (Number(t.pnlCoins) || 0) > 0).length;
  const losses = rows.filter(t => (Number(t.pnlCoins) || 0) < 0).length;
  const best = rows.reduce((m, t) => Math.max(m, Number(t.pnlCoins) || 0), 0);
  const worst = rows.reduce((m, t) => Math.min(m, Number(t.pnlCoins) || 0), 0);
  const total = rows.length + spot.length;
  return `<div class="card mt14">
    <div class="between"><div class="card-title" style="margin:0">Your ${esc(ticker)} history</div>
      <span class="badge ${realized >= 0 ? 'badge-success' : 'badge-danger'}">
        ${realized >= 0 ? '+' : '−'}${coins(Math.abs(realized))} WC realised</span></div>
    <div class="inv-hero-grid" style="border-top:none;padding-top:2px;margin-top:6px">
      <div><span class="tiny muted">Closed trades</span><b>${total}</b></div>
      <div><span class="tiny muted">Win / loss</span><b>${wins} / ${losses}</b></div>
      <div><span class="tiny muted">Best / worst</span>
        <b class="tiny">+${coins(best)} / −${coins(Math.abs(worst))}</b></div>
    </div>
    <div class="inv-list mt10">
      ${rows.slice(0, 6).map(t => `<div class="inv-row" style="align-items:flex-start">
        <div class="grow" style="min-width:0">
          <div class="small" style="font-weight:650">${t.side === 'short' ? 'Short' : 'Long'} ${t.leverage}×
            <span class="tiny muted">· ${esc(t.closeReason || 'closed')}</span></div>
          <div class="tiny muted">${coins(t.capitalCoins)} WC · ${usd(t.entryPrice)} → ${usd(t.exitPrice || 0)} · ${dateLabel(t.closedAt)}</div>
        </div>
        <span class="tiny ${(t.pnlCoins || 0) >= 0 ? 'up' : 'down'}">${(t.pnlCoins || 0) >= 0 ? '+' : '−'}${coins(Math.abs(t.pnlCoins || 0))} WC</span>
      </div>`).join('')}
    </div>
  </div>`;
};

/* ============================ demo shoppers (bots) ========================
   Simulated buyers that keep a marketplace looking alive. They are flagged
   everywhere they can be — isBot on the account, simulated on every order —
   so nobody can mistake their spend for real revenue. */
const BOT_ROSTER = [
  { slug:'lena-hoffmann',  name:'Lena Hoffmann',  username:'lena.hoffmann',  email:'lena.hoffmann@web.de',      phone:'+49 30 4820 1177', country:'Germany',     city:'Berlin',     address:'Torstraße 84',          postal:'10119',   cadence:[1,4] },
  { slug:'mathieu-leroy',  name:'Mathieu Leroy',  username:'mathieu.leroy',  email:'mathieu.leroy@orange.fr',   phone:'+33 4 78 21 44 90', country:'France',      city:'Lyon',       address:'27 Rue de la République', postal:'69002',   cadence:[2] },
  { slug:'carla-moreno',   name:'Carla Moreno',   username:'carla.moreno',   email:'carla.moreno@telefonica.net', phone:'+34 963 21 88 40', country:'Spain',   city:'Valencia',   address:'Calle de Colón 12',      postal:'46004',   cadence:[1,3,5] },
  { slug:'oliver-hughes',  name:'Oliver Hughes',  username:'oliver.hughes',  email:'o.hughes@btinternet.com',   phone:'+44 161 496 0721', country:'United Kingdom', city:'Manchester', address:'41 Deansgate',      postal:'M3 2AY',  cadence:[3,6] },
  { slug:'aiko-tanaka',    name:'Aiko Tanaka',    username:'aiko.tanaka',    email:'aiko.tanaka@docomo.ne.jp',  phone:'+81 6-6345-2210',  country:'Japan',       city:'Osaka',      address:'2-4-9 Umeda, Kita-ku',   postal:'530-0001', cadence:[2,5] },
  { slug:'miguel-santos',  name:'Miguel Santos',  username:'miguel.santos',  email:'miguel.santos@gmail.com',   phone:'+63 32 412 7788',  country:'Philippines', city:'Cebu City',  address:'18 Osmeña Boulevard',    postal:'6000',    cadence:[1] },
  { slug:'arjun-mehta',    name:'Arjun Mehta',    username:'arjun.mehta',    email:'arjun.mehta@outlook.in',    phone:'+91 20 4102 8890', country:'India',       city:'Pune',       address:'7 Koregaon Park Lane 5', postal:'411001',  cadence:[0,3] },
  { slug:'zofia-nowak',    name:'Zofia Nowak',    username:'zofia.nowak',    email:'zofia.nowak@wp.pl',         phone:'+48 12 421 66 30', country:'Poland',      city:'Kraków',     address:'ul. Długa 24',           postal:'31-147',  cadence:[4,6,0] }
];

LT.botsCfg = function () {
  if (!DB.settings) DB.settings = {};
  if (!DB.settings.bots) DB.settings.bots = { enabled: false, seededAt: null, cycles: 0, orders: 0, gmvUsd: 0 };
  return DB.settings.bots;
};
LT.botId = function (slug) { return 'bot_' + slug; };

LT.seedBots = function () {
  const cfg = LT.botsCfg();
  if (!Array.isArray(DB.bots)) DB.bots = [];
  BOT_ROSTER.forEach(b => {
    const id = LT.botId(b.slug);
    let u = findUser(id);
    if (!u) {
      u = {
        id, username: b.username, fullName: b.name, email: b.email, phone: b.phone,
        pass: null, pin: null, avatar: './bots/' + b.slug + '.jpg',
        role: 'user', balance: 20000, totalDeposits: 20000, totalWithdrawals: 0, totalEarnings: 0,
        vendorId: null, cart: [], stars: [], isBot: true,
        country: b.country, city: b.city, address: b.address, postal: b.postal,
        settings: { notifications: false, theme: 'dark' },
        verified: true, banned: false, completedSales: 0, rating: 5,
        createdAt: Date.now() - 90 * 864e5
      };
      DB.users.push(u);
    } else {
      u.isBot = true;
      if (!u.avatar) u.avatar = './bots/' + b.slug + '.jpg';
    }
    let rec = DB.bots.find(x => x.botId === id);
    if (!rec) {
      rec = { botId: id, slug: b.slug, cadence: b.cadence, nextAt: LT.nextDue(b.cadence), createdAt: Date.now() };
      DB.bots.push(rec);
    }
    rec.cadence = b.cadence;
  });
  if (!cfg.seededAt) cfg.seededAt = Date.now();
  return DB.bots;
};

/* next scheduled run: the next matching weekday, at a plausible shopping hour */
LT.nextDue = function (cadence) {
  const days = (cadence && cadence.length) ? cadence : [1];
  const now = new Date();
  for (let i = 1; i <= 8; i++) {
    const d = new Date(now.getTime() + i * 864e5);
    if (days.includes(d.getDay())) {
      if (Math.random() < 0.15) continue;            /* people skip weeks sometimes */
      d.setHours(9 + Math.floor(Math.random() * 11), Math.floor(Math.random() * 60), 0, 0);
      return d.getTime();
    }
  }
  return now.getTime() + 7 * 864e5;
};

LT.placeBotOrder = function (botUser, rec) {
  const vendorProducts = (DB.products || []).filter(p => p.active && p.stock > 0 && p.vendorId);
  if (!vendorProducts.length) return false;
  const p = vendorProducts[Math.floor(Math.random() * vendorProducts.length)];
  const vendor = vendorById(p.vendorId);
  if (!vendor) return false;
  const vendorUser = findUser(vendor.userId);
  if (!vendorUser) return false;
  const qty = Math.min(p.stock, Math.random() < 0.75 ? 1 : 2);
  const totalUsd = Math.round(p.priceUsd * qty * 100) / 100;
  const totalCoins = Math.round(totalUsd / LT_COIN * 100) / 100;

  if ((botUser.balance || 0) < totalCoins) botUser.balance = 20000;   /* simulated top-up */
  botUser.balance = Math.round((botUser.balance - totalCoins) * 100) / 100;

  const order = {
    id: uid('ord'), ref: 'WC-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
    buyerId: botUser.id, vendorId: vendor.id,
    items: [{ productId: p.id, name: p.name, qty, priceUsd: p.priceUsd, image: p.image, emoji: p.emoji, category: p.category }],
    totalUsd, totalCoins,
    delivery: {
      fullName: botUser.fullName, phone: botUser.phone, email: botUser.email,
      country: botUser.country, city: botUser.city, address: botUser.address, postal: botUser.postal
    },
    status: 'processing', payment: 'whale_coin', createdAt: Date.now(),
    simulated: true, isBot: true,
    timeline: [{ status: 'processing', at: Date.now(), note: 'Order placed' }]
  };
  DB.orders.unshift(order);
  p.stock = Math.max(0, p.stock - qty);
  if (p.stock === 0) p.active = false;

  vendorUser.balance = Math.round((vendorUser.balance + totalCoins) * 100) / 100;
  vendor.completedSales = (vendor.completedSales || 0) + 1;
  try {
    tx(vendorUser.id, 'sale', 'Demo order · ' + p.name, totalCoins, { orderId: order.id, simulated: true });
    notify(vendorUser.id, 'New order received',
      `${botUser.fullName} ordered ${qty} × ${p.name} · ${coins(totalCoins)} WC. (Demo shopper — simulated revenue.)`,
      '#/vendor/orders', 'bag');
  } catch (e) {}

  const cfg = LT.botsCfg();
  cfg.orders = (cfg.orders || 0) + 1;
  cfg.gmvUsd = Math.round(((cfg.gmvUsd || 0) + totalUsd) * 100) / 100;
  rec.lastAt = Date.now();
  rec.nextAt = LT.nextDue(rec.cadence);
  return true;
};

LT.botCycle = function (force) {
  const cfg = LT.botsCfg();
  if (!cfg.enabled && !force) return 0;
  LT.seedBots();
  const now = Date.now();
  let placed = 0;
  DB.bots.forEach(rec => {
    if (!rec.nextAt) rec.nextAt = LT.nextDue(rec.cadence);
    if (force || rec.nextAt <= now) {
      const u = findUser(rec.botId);
      if (u && LT.placeBotOrder(u, rec)) placed++;
    }
  });
  if (placed) {
    cfg.cycles = (cfg.cycles || 0) + 1;
    try { sync(); } catch (e) {}
    persist();
  }
  return placed;
};

App.botToggle = function () {
  const cfg = LT.botsCfg();
  cfg.enabled = !cfg.enabled;
  if (cfg.enabled) LT.seedBots();
  try { AUDIT.log('Demo shoppers ' + (cfg.enabled ? 'enabled' : 'disabled'), cfg.enabled ? 'bots will order on schedule' : 'no more simulated orders'); } catch (e) {}
  try { sync(); } catch (e) {}
  persist();
  toast(cfg.enabled ? 'Demo shoppers enabled — they order 1–3× a week' : 'Demo shoppers turned off', 'ok');
  render();
};

App.botRunNow = function () {
  const n = LT.botCycle(true);
  toast(n ? n + ' demo order(s) placed' : 'No vendor products with stock available', n ? 'ok' : 'err');
};

function ltBotsView() {
  const cfg = LT.botsCfg();
  if (cfg.enabled) LT.seedBots();
  const bots = (DB.bots || []).map(rec => ({ rec, u: findUser(rec.botId), meta: BOT_ROSTER.find(b => b.slug === rec.slug) })).filter(x => x.u);
  const orders = (DB.orders || []).filter(o => o.simulated);
  const tabs = `<div class="admin-nav">${ADMIN_NAV.map(n => {
    const key = n.href.replace('#/admin', '') || '';
    return `<a href="${n.href}" class="${key === '/bots' ? 'on' : ''}">${n.label}</a>`;
  }).join('')}</div>`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${tabs}
  <div class="page-head"><div class="between">
    <div><div class="section-title" style="margin:0">Demo shoppers</div>
      <div class="tiny muted">Simulated customers that buy from your vendors</div></div>
    <button class="btn ${cfg.enabled ? 'btn-danger' : 'btn-primary'}" data-act="bot-toggle">
      ${ic(cfg.enabled ? 'pause' : 'play', 15)} ${cfg.enabled ? 'Turn off' : 'Turn on'}</button>
  </div></div>

  <div class="card">
    <div class="between" style="align-items:center;flex-wrap:wrap;gap:10px">
      <div><div class="card-title" style="margin:0 0 4px">Status</div>
        <div class="small ${cfg.enabled ? 'up' : 'muted'}">${cfg.enabled ? 'Running — shoppers order on their weekly schedule' : 'Off — no simulated orders'}</div></div>
      <button class="btn btn-ghost" data-act="bot-run-now">${ic('play', 14)} Place orders now</button>
    </div>
    <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
      <span class="badge">${bots.length} shoppers</span>
      <span class="badge">${orders.length} demo orders</span>
      <span class="badge">$${(cfg.gmvUsd || 0).toFixed(2)} simulated spend</span>
    </div>
    <div class="inv-note tiny" style="margin-top:12px">${ic('shield', 13)}
      <span>Demo orders are marked <b>simulated</b> on the order, and each account carries a bot flag, so this revenue is
      always distinguishable from real sales. It must never be treated as withdrawable money.</span></div>
  </div>

  <div class="card">
    <div class="card-title">Shoppers</div>
    <div class="inv-list">
      ${bots.map(({ rec, u, meta }) => `<div class="inv-row">
        <span class="avatar sm" style="overflow:hidden;flex:0 0 auto">
          ${u.avatar ? `<img src="${u.avatar}" alt="" style="width:100%;height:100%;object-fit:cover"/>` : ''}</span>
        <div class="grow" style="min-width:0">
          <div class="small" style="font-weight:650">${esc(u.fullName)} <span class="badge" style="font-size:9px">Demo</span></div>
          <div class="tiny muted ellipsis">${esc(meta ? meta.city + ', ' + meta.country : '')} · @${esc(u.username)}</div>
          <div class="tiny muted">${rec.cadence.map(d => days[d]).join(' · ')} · next ${new Date(rec.nextAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
        </div>
        <div style="text-align:right"><div class="tiny muted">balance</div>
          <div class="small" style="font-weight:650">${coins(u.balance)} WC</div></div>
      </div>`).join('')}
    </div>
  </div>`;
}

const _adminBots = VIEWS.admin;
VIEWS.admin = function (parts, params) {
  if ((parts[1] || '') === 'bots') {
    const u = me();
    if (!u || u.role !== 'admin') return `<div class="card empty"><div class="ic">${ic('lock', 26)}</div><h3>Admin access only</h3></div>`;
    return ltBotsView();
  }
  return _adminBots.apply(this, arguments);
};
if (!ADMIN_NAV.some(n => n.key === 'admin-bots')) {
  ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0,
    { key: 'admin-bots', label: 'Demo shoppers', icon: 'users', href: '#/admin/bots' });
}

/* run the schedule while the app is open */
setInterval(() => {
  try {
    if (!DB || !me()) return;
    const cfg = LT.botsCfg();
    if (cfg.enabled) LT.botCycle(false);
  } catch (e) {}
}, 5 * 60 * 1000);

/* ===================== admin → servers & publishing ===================== */
App.admPublish = async function () {
  if (!await confirmDialog({ title: 'Publish this version to everyone?',
    body: 'Every open app reloads onto ' + APP_VERSION + ' automatically. Users do not need to update anything.',
    ok: 'Publish to all users' })) return;
  try {
    const r = await fetch('/api/reload', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ build: APP_BUILD, version: APP_VERSION })
    }).then(x => x.json());
    toast('Published ' + APP_VERSION + ' to ' + (r.clients || 0) + ' connected device(s)', 'ok');
  } catch (e) { toast('Could not reach the server', 'err'); }
};

App.admMailSave = async function () {
  const key = ((document.getElementById('admBrevo') || {}).value || '').trim();
  const from = ((document.getElementById('admMailFrom') || {}).value || '').trim();
  const name = ((document.getElementById('admMailName') || {}).value || '').trim() || 'WhaleChat';
  if (key && !/^xkeysib-/i.test(key) && !/^xsmtpsib-/i.test(key)) return toast('That does not look like a Brevo API key', 'err');
  if (from && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(from)) return toast('Enter a valid sender email', 'err');
  try {
    const r = await fetch('/api/admin/mail', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminId: me().id, brevoKey: key || undefined, from: from || undefined, fromName: name })
    }).then(x => x.json());
    if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
    toast('Email server connected for all users', 'ok');
    render();
  } catch (e) { toast('Could not save: ' + e.message, 'err'); }
};

App.admMailTest = async function () {
  const to = ((document.getElementById('admMailTest') || {}).value || '').trim();
  if (!to) return toast('Enter an address to test', 'err');
  const r = await fetch('/api/email/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }) }).then(x => x.json()).catch(() => null);
  if (r && r.ok) toast('Test email sent to ' + to, 'ok');
  else toast('Test failed: ' + ((r && (r.error || r.reason)) || 'unknown'), 'err');
};

App.admPushToggle = function () {
  if (!DB.settings) DB.settings = {};
  const cur = (DB.settings.push && DB.settings.push.enabled) || false;
  DB.settings.push = { enabled: !cur, at: Date.now(), by: me().id };
  try { sync(); } catch (e) {}
  persist();
  toast(!cur ? 'Push enabled — every user is asked to allow notifications' : 'Push turned off for all users', 'ok');
  render();
};

App.admPushAsk = async function () {
  try {
    if (typeof Notification === 'undefined') return toast('This browser cannot show notifications', 'err');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications stayed blocked — allow them in browser settings', 'err');
    if (window.Push && Push.ensure) {
      const r = await Push.ensure(true);
      if (r && r.ok) return toast('Notifications on — ' + r.devices + ' device(s) registered', 'ok');
    }
    toast('Notifications allowed on this device', 'ok');
    try { localStorage.setItem('wc_push_asked', '1'); } catch (e) {}
    render();
  } catch (e) { toast('Could not enable notifications', 'err'); }
};

App.admPushDismiss = function () {
  try { localStorage.setItem('wc_push_asked', '1'); } catch (e) {}
  const b = document.getElementById('ltPushBanner'); if (b) b.remove();
};

async function ltServersPanel() {
  let mail = null;
  try { mail = await fetch('/api/email/status', { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
  const pushOn = !!(DB.settings && DB.settings.push && DB.settings.push.enabled);
  const tabs = `<div class="admin-nav">${ADMIN_NAV.map(n => {
    const key = n.href.replace('#/admin', '') || '';
    return `<a href="${n.href}" class="${key === '/servers' ? 'on' : ''}">${n.label}</a>`;
  }).join('')}</div>`;

  return `${tabs}
  <div class="page-head"><div><div class="section-title" style="margin:0">Servers & release</div>
    <div class="tiny muted">Turn everything on once — it applies to every user account</div></div></div>

  <div class="card">
    <div class="between" style="align-items:center;flex-wrap:wrap;gap:10px">
      <div><div class="card-title" style="margin:0 0 4px">Publish app version</div>
        <div class="small muted">Current build <b>${esc(APP_VERSION)}</b> · ${esc(APP_BUILD)}</div></div>
      <button class="btn btn-primary" data-act="adm-publish">${ic('send', 15)} Publish to all users</button>
    </div>
    <div class="tiny muted mt10" style="line-height:1.7">
      Every open app receives the release instantly and restarts onto it by itself — users never update manually.
      Closed apps pick it up the next time they open.</div>
  </div>

  <div class="card">
    <div class="between" style="align-items:center;flex-wrap:wrap;gap:10px">
      <div><div class="card-title" style="margin:0 0 4px">Email server</div>
        <div class="small ${mail && mail.configured ? 'up' : 'muted'}">
          ${mail && mail.configured ? 'Connected · sending from ' + esc(mail.from || '') + ' via ' + esc(mail.provider || '') : 'Not connected'}</div></div>
      <span class="badge ${mail && mail.configured ? 'badge-success' : 'badge-warn'}">${mail && mail.configured ? 'Live' : 'Off'}</span>
    </div>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:12px">
      <div class="field grow" style="margin:0;min-width:220px"><label class="label">Brevo API key</label>
        <input class="input" id="admBrevo" type="password" placeholder="xkeysib-…" autocomplete="off"/></div>
      <div class="field grow" style="margin:0;min-width:180px"><label class="label">Sender email</label>
        <input class="input" id="admMailFrom" placeholder="whalechat1@gmail.com"/></div>
      <div class="field grow" style="margin:0;min-width:140px"><label class="label">Sender name</label>
        <input class="input" id="admMailName" placeholder="WhaleChat"/></div>
      <button class="btn btn-primary" data-act="adm-mail-save">Connect</button>
    </div>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">
      <div class="field grow" style="margin:0;min-width:200px"><input class="input" id="admMailTest" placeholder="you@email.com"/></div>
      <button class="btn btn-ghost" data-act="adm-mail-test">Send test</button>
    </div>
    <div class="tiny muted mt6">Saved on the server, so welcome mails, order mails and broadcasts work for every user.</div>
  </div>

  <div class="card">
    <div class="between" style="align-items:center;flex-wrap:wrap;gap:10px">
      <div><div class="card-title" style="margin:0 0 4px">Push notifications</div>
        <div class="small muted">${pushOn ? 'Enabled — every user is prompted to allow notifications' : 'Off — users can still enable them individually'}</div></div>
      <button class="btn ${pushOn ? 'btn-danger' : 'btn-primary'}" data-act="adm-push-toggle">
        ${ic(pushOn ? 'pause' : 'bell', 15)} ${pushOn ? 'Turn off for all' : 'Enable for all users'}</button>
    </div>
    <div class="tiny muted mt10" style="line-height:1.7">
      Browsers only grant notifications after the user taps allow, so this shows a one-tap prompt on every account.
      Push then arrives for buys, sells, price alerts and admin messages — even when the app is closed.</div>
  </div>`;
}

const _adminServers = VIEWS.admin;
VIEWS.admin = function (parts, params) {
  if ((parts[1] || '') === 'servers') {
    const u = me();
    if (!u || u.role !== 'admin') return `<div class="card empty"><div class="ic">${ic('lock', 26)}</div><h3>Admin access only</h3></div>`;
    const shell = `<div id="ltServersWrap"><div class="card"><div class="tiny muted">Loading server status…</div></div></div>`;
    setTimeout(() => {
      ltServersPanel().then(html => {
        const el = document.getElementById('ltServersWrap');
        if (el) el.innerHTML = html;
      }).catch(() => {});
    }, 30);
    return shell;
  }
  return _adminServers.apply(this, arguments);
};

if (!ADMIN_NAV.some(n => n.key === 'invest')) {
  ADMIN_NAV.splice(1, 0, { key: 'invest', label: 'Invest', icon: 'trend', href: '#/invest' });
}
if (!ADMIN_NAV.some(n => n.key === 'admin-servers')) {
  ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0,
    { key: 'admin-servers', label: 'Servers', icon: 'shield', href: '#/admin/servers' });
}

/* one-tap prompt for every user once an admin enables push */
function ltPushBanner() {
  if (!DB || !DB.settings || !DB.settings.push || !DB.settings.push.enabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  try { if (localStorage.getItem('wc_push_asked')) return; } catch (e) {}
  if (document.getElementById('ltPushBanner')) return;
  const el = document.createElement('div');
  el.id = 'ltPushBanner';
  el.className = 'lt-push-banner';
  el.innerHTML = `<span class="lt-push-ic">${ic('bell', 16)}</span>
    <div style="flex:1;min-width:0"><div class="small" style="font-weight:650">Turn on notifications</div>
      <div class="tiny muted">Trades, alerts and messages reach you even when the app is closed.</div></div>
    <button class="btn btn-primary btn-xs" data-act="adm-push-ask">Allow</button>
    <button class="btn-icon" data-act="adm-push-dismiss" style="width:26px;height:26px">${ic('x', 13)}</button>`;
  document.body.appendChild(el);
}

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

/* admin: leverage is what decides how fast a trade can be wiped out */
App.ltSaveLeverage = function () {
  const el = document.getElementById('ltLeverage');
  const v = Number((el && el.value) || 0);
  if (!(v >= 1 && v <= 20)) return toast('Leverage must be between 1× and 20×', 'err');
  LT.cfg().leverage = Math.round(v);
  try { sync(); } catch (e) {}
  persist(); toast('Trade leverage set to ' + Math.round(v) + '×', 'ok'); render();
};

function ltLeverageCard() {
  const lev = LT.leverage();
  const wipe = (100 / lev).toFixed(1);
  return `<div class="card">
    <div class="card-title">Live trade leverage</div>
    <div class="tiny muted" style="line-height:1.7;margin-bottom:8px">
      A <b>${lev}×</b> position is wiped out by a <b>${wipe}%</b> move against it — at that point the trade closes
      and <b>nothing is returned</b> to the user's balance. Lower leverage means gentler losses.</div>
    <div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
      <div class="field grow" style="margin:0;min-width:120px"><label class="label">Leverage</label>
        <input class="input" id="ltLeverage" type="number" step="1" min="1" max="20" value="${lev}"/></div>
      <button class="btn btn-primary" data-act="lt-save-leverage">Save</button>
    </div>
    <div class="tiny muted mt6">Applies to new trades. Open trades keep the leverage they were opened with.</div>
  </div>`;
}

const _adminForLeverage = VIEWS.admin;
VIEWS.admin = function (parts, params) {
  const html = _adminForLeverage.apply(this, arguments);
  if ((parts[1] || '') !== 'stocks') return html;
  return html + ltLeverageCard();
};

/* the base paint rewrites the earnings tile every 5s — re-apply ours after it */
(function () {
  if (typeof INV === 'undefined' || INV.__ltPaintPatched) return;
  const basePaint = INV.paint;
  INV.paint = function () {
    const out = basePaint.apply(INV, arguments);
    try { LT.paintEarnings(); } catch (e) {}
    return out;
  };
  INV.__ltPaintPatched = true;
})();

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
  const ticker = m[1].toUpperCase();
  const content = document.getElementById('content');
  if (!content || document.getElementById('ltTicketMount')) return;

  const host = document.createElement('div');
  host.id = 'ltTicketMount';
  host.innerHTML = LT.ticketHTML(ticker) + LT.activeBlock() + LT.stockHistory(ticker);

  /* the old spot panel (Market/Limit + Buy stock/Sell) is replaced entirely:
     a trade starts immediately and is exited with Take profit / Take loss. */
  const legacyBtn = content.querySelector('[data-act="inv-trade"]');
  const legacyCard = legacyBtn ? legacyBtn.closest('.card') : null;
  if (legacyCard && legacyCard.parentNode) {
    legacyCard.parentNode.insertBefore(host, legacyCard);
    legacyCard.remove();
  } else {
    content.appendChild(host);
  }

  /* make the big chart tick at 2s as well */
  const bigChart = content.querySelector('.inv-chart[data-chart]');
  if (bigChart) {
    const parts = (bigChart.getAttribute('data-chart') || '').split('|');
    bigChart.setAttribute('data-lt-live-chart', parts[0] || ticker);
    bigChart.setAttribute('data-lt-tf', parts[1] || '1D');
    bigChart.setAttribute('data-lt-mode', parts[2] || 'line');
    bigChart.removeAttribute('data-chart');
  }

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
    LT.paintDash();
    LT.paintMarket();
  } catch (e) { console.error('lt tick', e); }
}, 2000);

/* catch the app after login/first paint too */
setInterval(() => {
  try {
    if (!DB || !me()) return;
    ltPushBanner();
    if (document.querySelector('.inv-hero')) ltMountDashboard();
    else if (location.hash.indexOf('#/invest/stock/') === 0) ltMountStock();
  } catch (e) {}
}, 2500);
