
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
  DIV_FALLBACK: {
    AAPL: 0.45, TSLA: 0, NVDA: 0.03, COIN: 0, MSTR: 0, MARA: 0, KO: 3.00, JPM: 2.20,
    NKE: 1.80, UNH: 1.50, AVGO: 1.20, WMT: 1.00, DIS: 0.80, V: 0.75, UBER: 0, AMZN: 0,
    MSFT: 0.70, GOOGL: 0.45, META: 0.35, NFLX: 0, AMD: 0, PEP: 3.40, PLTR: 0, ARM: 0,
    SHOP: 0, HOOD: 0, LLY: 0.70, XOM: 3.30, SMCI: 0, RIVN: 0,
  VOD_L: 7.0, SAP_DE: 1.3, '7203_T': 2.5, SHOP_TO: 0
  },
  dividendYield(ticker) {
    const inv = this.cfg();
    const t = String(ticker || '').toUpperCase();
    const ov = inv.dividendOverrides && inv.dividendOverrides[t];
    if (ov != null && ov !== '' && Number.isFinite(Number(ov))) return Math.max(0, Math.min(100, Number(ov)));
    const auto = inv.dividendYields && inv.dividendYields[t];
    if (auto != null && Number.isFinite(Number(auto))) return Math.max(0, Math.min(100, Number(auto)));
    return Number(this.DIV_FALLBACK[t]) || 0;
  },
  dividendBonusFor(ticker, stakeWC, minutes) {
    const y = this.dividendYield(ticker);
    const stake = Number(stakeWC) || 0, mins = Number(minutes) || 0;
    if (!(y > 0) || !(stake > 0) || !(mins > 0)) return 0;
    const mult = Math.max(0, Number(this.cfg().dividendMultiplier) || 1);
    let bonus = stake * (y / 100 / 365) * mult * (mins / 1440);
    if (bonus > 0 && bonus < 0.01) bonus = 0.01;
    return Math.round(bonus * 100) / 100;
  },
  px(ticker, value) { return (typeof INV !== 'undefined' && INV.priceText) ? INV.priceText(ticker, value) : usd(value); },
  label(ticker) { return (typeof INV !== 'undefined' && INV.assetTicker) ? INV.assetTicker(ticker) : String(ticker || ''); },
  dividendBadge(ticker) {
    const y = this.dividendYield(ticker);
    if (!(y > 0)) return '';
    return `<span class="div-badge">Div ${y.toFixed(2)}%</span>`;
  },
  dividendEstimateBadge(ticker, stakeWC, minutes, label) {
    const y = this.dividendYield(ticker);
    if (!(y > 0)) return '';
    const bonus = this.dividendBonusFor(ticker, stakeWC, minutes);
    if (!(bonus > 0)) return '';
    const text = label || '1d';
    return `<span class="div-est" title="Estimated ${text} dividend bonus on ${Number(stakeWC) || 0} WC">${text} +${coins(bonus)} WC</span>`;
  },

  cfg() {
    if (!DB) return { leverage: 5 };
    if (!DB.invest) DB.invest = { feePct: 0.5, paused: {}, seededAt: Date.now() };
    if (!DB.invest.leverage) DB.invest.leverage = 5;
    if (!(Number(DB.invest.dividendMultiplier) > 0)) DB.invest.dividendMultiplier = 1;
    if (!DB.invest.dividendPayoutMode) DB.invest.dividendPayoutMode = 'all';
    if (!DB.invest.dividendYields || typeof DB.invest.dividendYields !== 'object') DB.invest.dividendYields = {};
    if (!DB.invest.dividendOverrides || typeof DB.invest.dividendOverrides !== 'object') DB.invest.dividendOverrides = {};
    return DB.invest;
  },
  leverage() { return Math.min(20, Math.max(1, Number(this.cfg().leverage) || 1)); },
  feePct() { return Math.max(0, Number(this.cfg().feePct) || 0); },
  all(userId) {
    if (!Array.isArray(DB.trades)) DB.trades = [];
    const list = DB.trades.filter(t => t.userId === (userId || me().id) && t.type === 'live');
    list.forEach(t => {
      if (!t.direction) t.direction = t.side === 'short' ? 'FALL' : 'RISE';
      if (t.stakeAmount == null) t.stakeAmount = t.capitalCoins;
      const entry = Number(t.entryPrice) || 0, lev = Math.max(1, Number(t.leverage) || 1);
      if (!(Number(t.takeProfitPrice) > 0) && Number(t.tpPct) > 0 && entry > 0) {
        const m = Number(t.tpPct) / (100 * lev);
        t.takeProfitPrice = Math.round(entry * (t.direction === 'FALL' ? (1 - m) : (1 + m)) * 10000) / 10000;
      }
      if (!(Number(t.stopLossPrice) > 0) && Number(t.slPct) > 0 && entry > 0) {
        const m = Number(t.slPct) / (100 * lev);
        t.stopLossPrice = Math.round(entry * (t.direction === 'FALL' ? (1 + m) : (1 - m)) * 10000) / 10000;
      }
    });
    return list;
  },
  open(userId) { return this.all(userId).filter(t => t.status === 'Open'); },
  closed(userId) { return this.all(userId).filter(t => t.status !== 'Open').sort((a, b) => b.closedAt - a.closedAt); },

  dirOf(t) { return t && t.direction ? t.direction : (t && t.side === 'short' ? 'FALL' : 'RISE'); },
  tpslOf(t) { return { tp: Number(t && t.takeProfitPrice) || 0, sl: Number(t && t.stopLossPrice) || 0 }; },
  /* trail the stop behind favourable price movement; only tightens, never loosens */
  updateTrailing(t) {
    if (!t || !t.trailingActive || t.status !== 'Open') return false;
    const dist = Math.max(0.05, Math.min(50, Number(t.trailingStopPct) || 0)) / 100;
    if (!(dist > 0)) return false;
    const q = INV.quote(t.ticker);
    if (!q || !(q.price > 0)) return false;
    const dir = this.dirOf(t);
    const entry = Number(t.entryPrice) || q.price;
    let stop = Number(t.trailingStopPrice) || Number(t.stopLossPrice) || 0;
    if (!(stop > 0)) stop = dir === 'RISE' ? entry * (1 - dist) : entry * (1 + dist);
    const next = dir === 'RISE' ? q.price * (1 - dist) : q.price * (1 + dist);
    const tightened = dir === 'RISE' ? Math.max(stop, next) : Math.min(stop, next);
    const rounded = Math.round(tightened * 10000) / 10000;
    const changed = rounded !== Math.round(stop * 10000) / 10000;
    t.trailingStopPrice = rounded;
    t.stopLossPrice = rounded;
    return changed;
  },
  levelPrice(direction, entry, raw, mode, kind, capital, leverage) {
    const v = Math.abs(Number(raw) || 0);
    if (!v || !(entry > 0)) return 0;
    if (mode === 'price') return Math.round(v * 10000) / 10000;
    const rise = direction === 'RISE';
    let pct;
    if (mode === 'wc') {
      const stake = Number(capital) || 0, lev = Math.max(1, Number(leverage) || 1);
      if (!(stake > 0)) return 0;
      pct = v / (stake * lev);                 /* WC profit / loss -> required price move */
    } else {
      pct = v / 100;
    }
    const price = kind === 'tp'
      ? (rise ? entry * (1 + pct) : entry * (1 - pct))
      : (rise ? entry * (1 - pct) : entry * (1 + pct));
    if (!(price > 0)) return 0;
    return Math.round(price * 10000) / 10000;
  },
  validateLevels(direction, entry, tp, sl) {
    if (!(entry > 0)) return 'No live entry price for this symbol';
    if (tp > 0) {
      if (direction === 'RISE' && tp <= entry) return 'Take Profit must be above the entry price for a Rise trade';
      if (direction === 'FALL' && tp >= entry) return 'Take Profit must be below the entry price for a Fall trade';
    }
    if (sl > 0) {
      if (sl <= 0) return 'Stop Loss price must be above zero';
      if (direction === 'RISE' && sl >= entry) return 'Stop Loss must be below the entry price for a Rise trade';
      if (direction === 'FALL' && sl <= entry) return 'Stop Loss must be above the entry price for a Fall trade';
    }
    return '';
  },

  /* live numbers for a position */
  calc(t) {
    const q = INV.quote(t.ticker) || { price: t.entryPrice };
    /* direction is authoritative: FALL profits when price falls, RISE when it rises */
    const dir = this.dirOf(t) === 'FALL' ? -1 : 1;
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
    if (!q || !(Number(q.price) > 0)) { toast('No live Finnhub quote for this asset yet', 'err'); return false; }

    const fee = Math.round(capital * this.feePct() / 100 * 100) / 100;
    const minutes = Math.max(1, Math.min(7 * 24 * 60, Number(o.minutes) || 60));
    const durationMeta = this.DURATIONS.find(d => d.m === minutes);
    const durationText = durationMeta ? durationMeta.label : minutes + ' min';
    const divYield = this.dividendYield(ticker);
    const divBonus = this.dividendBonusFor(ticker, capital, minutes);
    const direction = side === 'short' ? 'FALL' : 'RISE';
    const tpPrice = Math.max(0, Number(o.tpPrice) || 0);
    const slPrice = Math.max(0, Number(o.slPrice) || 0);
    const trailPct = Math.max(0, Math.min(50, Number(o.trailingPct) || 0));
    const levelErr = this.validateLevels(direction, q.price, tpPrice, slPrice);
    if (levelErr) { toast(levelErr, 'err'); return false; }
    const trailStop = trailPct > 0
      ? Math.round(q.price * (direction === 'FALL' ? (1 + trailPct / 100) : (1 - trailPct / 100)) * 10000) / 10000
      : 0;
    const trade = {
      id: uid('lt'), userId: u.id, type: 'live', ticker, name: s.name,
      side: side === 'short' ? 'short' : 'long', direction,
      capitalCoins: capital, stakeAmount: capital, entryPrice: q.price, initialEntryPrice: q.price,
      leverage: this.leverage(),
      takeProfitPrice: tpPrice > 0 ? Math.round(tpPrice * 10000) / 10000 : null,
      takeProfitMode: o.tpMode || 'PRICE',
      takeProfitWc: Number(o.tpWc) > 0 ? Math.round(Number(o.tpWc) * 100) / 100 : null,
      stopLossPrice: trailPct > 0 ? trailStop : (slPrice > 0 ? Math.round(slPrice * 10000) / 10000 : null),
      stopLossMode: trailPct > 0 ? 'TRAILING' : (o.slMode || 'PRICE'),
      stopLossWc: Number(o.slWc) > 0 ? Math.round(Number(o.slWc) * 100) / 100 : null,
      trailingActive: trailPct > 0,
      trailingStopPct: trailPct || 0,
      trailingStopPrice: trailPct > 0 ? trailStop : null,
      tpPct: Math.max(0, Math.min(500, Number(o.tpPct) || 0)),
      slPct: Math.max(0, Math.min(100, Number(o.slPct) || 0)),
      durationMinutes: minutes, durationLabel: durationText,
      dividendYield: divYield, dividendBonus: divBonus, dividendPaid: false,
      expiresAt: Date.now() + minutes * 60000,
      status: 'Open', createdAt: Date.now(), feeCoins: fee
    };
    u.balance = Math.round((u.balance - capital - fee) * 100) / 100;
    DB.trades.unshift(trade);
    tx(u.id, 'trade-open', `${direction === 'FALL' ? 'Fall' : 'Rise'} ${this.label(ticker)} · ${coins(capital)} WC`, -capital - fee,
      { tradeId: trade.id, leverage: trade.leverage, entry: q.price, direction });
    notify(u.id, 'Trade opened',
      `${direction === 'FALL' ? 'Fall' : 'Rise'} ${this.label(ticker)} with ${coins(capital)} WC at ${this.px(ticker, q.price)}${tpPrice ? ' · TP ' + usd(tpPrice) : ''}${trailPct ? ' · trailing ' + trailPct + '%' : (slPrice ? ' · SL ' + usd(slPrice) : '')} — closes in ${minutes} min.${divBonus > 0 ? ' Dividend on timer: +' + coins(divBonus) + ' WC.' : ''}`,
      '#/invest/orders', 'trend');
    persist(); toast('Trade started — tracking live', 'ok'); render();
    try { window.dispatchEvent(new CustomEvent('wc:trade-opened', { detail: { ticker, id: trade.id } })); } catch (e) {}
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

    let dividendCoins = 0;
    if (reason === 'Time limit reached' && !t.dividendPaid) {
      const mode = this.cfg().dividendPayoutMode || 'all';
      const minutes = Number(t.durationMinutes) || 0;
      let bonus = Number(t.dividendBonus);
      if (!(bonus > 0)) bonus = this.dividendBonusFor(t.ticker, t.capitalCoins, minutes);
      if (mode === 'wins' && p.pnlCoins <= 0) bonus = 0;
      if (bonus > 0) {
        dividendCoins = Math.round(bonus * 100) / 100;
        u.balance = Math.round((u.balance + dividendCoins) * 100) / 100;
        t.dividendPaid = true;
        t.dividendCoins = dividendCoins;
        t.dividendPaidAt = Date.now();
        const dlabel = t.durationLabel || (this.DURATIONS.find(d => d.m === minutes) || {}).label || minutes + ' min';
        tx(u.id, 'dividend', `Dividend Bonus - ${t.ticker} (${dlabel})`, dividendCoins,
          { tradeId: t.id, annualYield: t.dividendYield, multiplier: this.cfg().dividendMultiplier });
        notify(u.id, 'Dividend bonus credited',
          `+${coins(dividendCoins)} WC dividend for ${t.ticker} (${dlabel}).`, '#/invest/orders', 'gift');
      }
    }
    t.totalPayoutCoins = Math.round((payout + dividendCoins) * 100) / 100;

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
    try { window.dispatchEvent(new CustomEvent('wc:trade-closed', { detail: { ticker: t.ticker, id: t.id } })); } catch (e) {}
    return true;
  },

  /* ---------------- take profit (skim, keep trade running) ---------------- */
  takeProfit(t, reason) {
    if (!t || t.status !== 'Open') return false;
    const u = findUser(t.userId);
    if (!u) return false;
    const p = this.calc(t);
    const profit = Math.round((Number(p.pnlCoins) || 0) * 100) / 100;
    if (!(profit > 0)) { toast('No profit to take yet — wait for the chart to move in your favour', 'err'); return false; }
    if (!t.initialEntryPrice) t.initialEntryPrice = t.entryPrice;
    u.balance = Math.round(((Number(u.balance) || 0) + profit) * 100) / 100;
    /* re-base the position so the remaining trade starts from the current price */
    t.entryPrice = Math.round((Number(p.price) || 0) * 10000) / 10000;
    t.profitTakenCoins = Math.round(((Number(t.profitTakenCoins) || 0) + profit) * 100) / 100;
    t.lastProfitAt = Date.now();
    t.lastProfitPrice = p.price;
    /* the taken level is consumed — a new TP can be set from the new entry */
    t.takeProfitPrice = null;
    t.takeProfitWc = null;
    t.takeProfitMode = 'PRICE';
    t.tpPct = 0;
    /* keep a trailing stop anchored to the new price */
    if (t.trailingActive && Number(t.trailingStopPct) > 0) {
      const dist = Math.max(0.05, Math.min(50, Number(t.trailingStopPct))) / 100;
      const stop = t.direction === 'FALL' ? t.entryPrice * (1 + dist) : t.entryPrice * (1 - dist);
      t.trailingStopPrice = Math.round(stop * 10000) / 10000;
      t.stopLossPrice = t.trailingStopPrice;
    }
    const label = reason || 'Take Profit';
    tx(u.id, 'trade-profit', `${label} · ${t.ticker} · +${coins(profit)} WC taken, trade continues`, profit,
      { tradeId: t.id, pnlCoins: profit, price: p.price, continues: true });
    notify(u.id, 'Profit taken — trade continues',
      `${t.ticker}: +${coins(profit)} WC profit credited to your balance. The trade is still running — it closes at your stop loss, when the timer ends, or when you press Stop trade.`,
      '#/invest/orders', 'trend');
    try { sync(); } catch (e) {}
    persist();
    render();
    toast(`Profit taken — ${coins(profit)} WC credited. Trade continues`, 'ok');
    try { window.dispatchEvent(new CustomEvent('wc:trade-profit', { detail: { ticker: t.ticker, id: t.id, profit } })); } catch (e) {}
    return true;
  },

  /* auto close on stop / expiry; take profit now skims and keeps running */
  auto() {
    if (!DB || !DB.trades) return;
    this.open().forEach(t => {
      this.updateTrailing(t);
      /* Finnhub-covered symbols are settled by the backend so a closed browser
         cannot miss a payout — avoid paying the same trade twice. */
      if (typeof WC_MARKET !== 'undefined' && typeof WC_MARKET.feedFresh === 'function' && WC_MARKET.feedFresh() && WC_MARKET.feed.quotes && WC_MARKET.feed.quotes[t.ticker]) return;
      const p = this.calc(t);
      const dir = this.dirOf(t);
      const lv = this.tpslOf(t);
      const slReason = t.trailingActive ? 'Trailing Stop Hit' : 'Stop Loss Hit';
      if (dir === 'RISE') {
        if (lv.tp > 0 && p.price >= lv.tp) return void this.takeProfit(t, 'Take Profit Hit');
        if (lv.sl > 0 && p.price <= lv.sl) return void this.settle(t, slReason);
      } else {
        if (lv.tp > 0 && p.price <= lv.tp) return void this.takeProfit(t, 'Take Profit Hit');
        if (lv.sl > 0 && p.price >= lv.sl) return void this.settle(t, slReason);
      }
      if (t.tpPct > 0 && p.pnlPct >= t.tpPct) return void this.takeProfit(t, 'Take Profit Hit');
      if (t.slPct > 0 && p.pnlPct <= -t.slPct) return void this.settle(t, slReason);
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
    const dirLabel = t.side === 'short' ? 'Fall' : 'Rise';
    return `<div class="lt-card" data-lt="${t.id}">
      <div class="row" style="gap:9px;align-items:center">
        ${INV.logoHTML(s, 32)}
        <div class="grow" style="min-width:0">
          <div class="small" style="font-weight:700">${esc(this.label(t.ticker))}
            <span class="lt-side ${t.side}">${dirLabel} ${t.leverage}×</span>
            <span class="tiny ${up ? 'up' : down ? 'down' : 'muted'}" data-lt-dirhint="${t.id}">${t.side === 'short' ? 'profit while price falls' : 'profit while price rises'}</span></div>
          <div class="tiny muted">${coins(t.capitalCoins)} WC · entry ${this.px(t.ticker, t.entryPrice)}</div>
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
        <span class="tiny muted">Price <b data-lt-price="${t.id}">${this.px(t.ticker, p.price)}</b>
          <span data-lt-move="${t.id}" class="${p.movePct >= 0 ? 'up' : 'down'}">${p.movePct >= 0 ? '▲' : '▼'} ${Math.abs(p.movePct).toFixed(2)}%</span></span>
        <span class="tiny muted" data-lt-left="${t.id}">⏱ ${this.clock(p.left)}</span>
      </div>
      <div class="lt-levels">
        <span class="lt-lvl tp"><i></i>TP <b>${Number(t.takeProfitPrice) > 0 ? usd(t.takeProfitPrice) : '—'}</b>${Number(t.takeProfitWc) > 0 ? `<small>${Number(t.takeProfitWc)} WC</small>` : ''}</span>
        <span class="lt-lvl sl" data-lt-sl="${t.id}"><i></i>${t.trailingActive ? 'TSL' : 'SL'} <b>${Number(t.stopLossPrice) > 0 ? usd(t.stopLossPrice) : '—'}</b>${Number(t.stopLossWc) > 0 ? `<small>${Number(t.stopLossWc)} WC</small>` : ''}</span>
        ${t.trailingActive ? `<span class="lt-lvl trail">trail ${Number(t.trailingStopPct).toFixed(1)}%</span>` : ''}
        <button class="lt-edit" data-act="lt-edit-tpsl" data-id="${t.id}">${ic('edit', 12)} Edit TP/SL</button>
      </div>
      <div class="lt-bar"><i style="width:${Math.min(100, Math.max(0, 50 + p.pnlPct))}%"
        class="${up ? 'up' : down ? 'down' : ''}"></i></div>
      <div class="tiny ${up ? 'up' : down ? 'down' : 'muted'}" style="margin-top:7px;line-height:1.5">
        ${t.side === 'short'
          ? `▼ Fall prediction — the chart falling is your profit zone (green); the chart rising is your loss zone (red). Now ${p.pnlCoins >= 0 ? '+' : '−'}${coins(Math.abs(p.pnlCoins))} WC.`
          : `▲ Rise prediction — the chart rising is your profit zone (green); the chart falling is your loss zone (red). Now ${p.pnlCoins >= 0 ? '+' : '−'}${coins(Math.abs(p.pnlCoins))} WC.`}
      </div>
      <div class="row lt-action-row" style="gap:6px;margin-top:9px">
        <button class="btn btn-sm btn-primary grow" data-act="lt-tp" data-id="${t.id}" data-lt-tp-btn="${t.id}" ${p.pnlCoins > 0 ? '' : 'disabled'} title="${p.pnlCoins > 0 ? 'Take the open profit and keep the trade running' : 'No profit to take yet'}">
          ${ic('trend', 13)} Take profit <span data-lt-tp-amt="${t.id}">${p.pnlCoins > 0 ? '(+' + coins(p.pnlCoins) + ')' : ''}</span></button>
        <button class="btn btn-sm btn-soft grow" data-act="lt-stop" data-id="${t.id}" title="Close the trade now and return capital + open P/L">
          ${ic('ban', 13)} Stop trade</button>
        <button class="btn btn-sm btn-ghost grow" data-act="lt-sl" data-id="${t.id}" data-lt-sl-btn="${t.id}" ${p.pnlCoins < 0 ? '' : 'disabled'} title="${p.pnlCoins < 0 ? 'Close the trade at a loss now' : 'Only available while the trade is losing'}">
          ${ic('down', 13)} Take loss <span data-lt-sl-amt="${t.id}">${p.pnlCoins < 0 ? '(−' + coins(Math.abs(p.pnlCoins)) + ')' : ''}</span></button>
      </div>
      ${(() => {
        const pending = (t.securedProfits || []).filter((x) => x && !x.claimed);
        if (!pending.length) return '';
        const sum = pending.reduce((a, x) => a + (Number(x.coins) || 0), 0);
        return `<div class="tiny up" style="margin-top:6px">${pending.length} secured profit${pending.length === 1 ? '' : 's'} · <b>${coins(sum)} WC</b> pending claim — see Secured profits below</div>`;
      })()}
      <div class="tiny muted center" style="margin-top:6px">${Number(t.profitTakenCoins) > 0 ? `Profit already taken: <b class="up">+${coins(t.profitTakenCoins)} WC</b> · ` : ''}Returns ${coins(p.payoutCoins)} WC if stopped now</div>
      ${Number(t.dividendBonus) > 0 ? `<div class="tiny center lt-div-line">+${coins(t.dividendBonus)} WC dividend at timer</div>` : ''}
    </div>`;
  },

  closedRow(t) {
    const pnl = Number(t.pnlCoins) || 0;
    const win = pnl > 0, lost = t.result === 'loss';
    return `<div class="inv-row" style="align-items:flex-start">
      <div class="grow" style="min-width:0">
        <div class="small" style="font-weight:650">${esc(this.label(t.ticker))} ${t.side === 'short' ? 'Fall' : 'Rise'}
          <span class="tiny muted">· ${t.leverage}× · ${esc(t.closeReason || 'closed')}</span></div>
        <div class="tiny muted">${coins(t.capitalCoins)} WC @ ${this.px(t.ticker, t.entryPrice)} → ${this.px(t.ticker, t.exitPrice || 0)} · ${dateLabel(t.closedAt)} ${clockTime(t.closedAt)}</div>
        <div class="lt-hist-levels">${Number(t.takeProfitPrice) > 0 ? `<span class="tp">TP ${usd(t.takeProfitPrice)}</span>` : '<span>TP —</span>'}
          ${Number(t.stopLossPrice) > 0 ? `<span class="sl">${t.trailingActive ? 'TSL' : 'SL'} ${usd(t.stopLossPrice)}</span>` : '<span>SL —</span>'}
          ${t.trailingActive ? `<span class="trail">trail ${Number(t.trailingStopPct).toFixed(1)}%</span>` : ''}</div>
        <div class="tiny ${win ? 'up' : lost ? 'down' : 'muted'}">
          ${lost ? 'Total loss — nothing returned' : (win ? '+' : '') + coins(pnl) + ' WC P/L'} ·
          returned ${coins(t.payoutCoins || 0)} WC</div>
        ${Number(t.dividendCoins) > 0 ? `<div class="tiny up">+${coins(t.dividendCoins)} WC dividend credited</div>` : ''}
        ${(() => {
          const p = (t.securedProfits || []).filter((x) => x && !x.claimed);
          if (!p.length) return '';
          const sum = p.reduce((a, x) => a + (Number(x.coins) || 0), 0);
          return `<div class="tiny up">${p.length} secured profit${p.length === 1 ? '' : 's'} · ${coins(sum)} WC awaiting claim</div>`;
        })()}
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
      set('[data-lt-price="' + t.id + '"]', this.px(t.ticker, p.price));
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
      document.querySelectorAll('[data-lt-sl="' + t.id + '"] b').forEach(el => {
        el.textContent = Number(t.stopLossPrice) > 0 ? usd(t.stopLossPrice) : '—';
      });
      document.querySelectorAll('[data-lt-dirhint="' + t.id + '"]').forEach((el) => {
        el.textContent = t.side === 'short' ? 'profit while price falls' : 'profit while price rises';
      });
      const ret = document.querySelector('[data-lt="' + t.id + '"] .tiny.muted.center');
      if (ret) ret.textContent = (Number(t.profitTakenCoins) > 0 ? 'Profit already taken: +' + coins(t.profitTakenCoins) + ' WC · ' : '') + 'Returns ' + coins(p.payoutCoins) + ' WC if stopped now';
      document.querySelectorAll('[data-lt-tp-btn="' + t.id + '"]').forEach((b) => {
        b.disabled = p.pnlCoins <= 0;
        b.title = p.pnlCoins > 0 ? 'Take the open profit and keep the trade running' : 'No profit to take yet';
      });
      document.querySelectorAll('[data-lt-sl-btn="' + t.id + '"]').forEach((b) => {
        b.disabled = p.pnlCoins >= 0;
        b.title = p.pnlCoins < 0 ? 'Close the trade at a loss now' : 'Only available while the trade is losing';
      });
      document.querySelectorAll('[data-lt-tp-amt="' + t.id + '"]').forEach((el) => {
        el.textContent = p.pnlCoins > 0 ? '(+' + coins(p.pnlCoins) + ')' : '';
      });
      document.querySelectorAll('[data-lt-sl-amt="' + t.id + '"]').forEach((el) => {
        el.textContent = p.pnlCoins < 0 ? '(−' + coins(Math.abs(p.pnlCoins)) + ')' : '';
      });
    });
    this.paintEarnings();
    this.paintChartHint();
  },

  /* the hero "Earnings" figure follows the live trades, not old holdings */
  paintChartHint() {
    const el = document.querySelector('[data-lt-chart-hint]');
    if (!el) return;
    const m = (location.hash || '').match(/^#\/invest\/stock\/([A-Z0-9._]+)/i);
    if (!m) { el.textContent = ''; return; }
    const ticker = m[1].toUpperCase();
    const pos = this.open().find(t => t.ticker === ticker);
    if (!pos) {
      el.innerHTML = '<span class="muted">Green = price up · Red = price down. Open a Rise or Fall trade to see your profit zone.</span>';
      return;
    }
    const p = this.calc(pos);
    const up = p.pnlCoins >= 0;
    el.className = 'tiny center ' + (up ? 'up' : 'down');
    el.innerHTML = pos.side === 'short'
      ? `<b>▼ Fall trade</b> · falling chart = <b>green profit zone</b>, rising chart = <b>red loss zone</b> · now ${up ? '+' : '−'}${coins(Math.abs(p.pnlCoins))} WC`
      : `<b>▲ Rise trade</b> · rising chart = <b>green profit zone</b>, falling chart = <b>red loss zone</b> · now ${up ? '+' : '−'}${coins(Math.abs(p.pnlCoins))} WC`;
  },

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

  /* ---------------- secured profits (auto secure bot) ---------------- */
  securedEntries(userId) {
    const out = [];
    (DB.trades || []).forEach((t) => {
      if (!t || t.userId !== userId) return;
      (t.securedProfits || []).forEach((p) => {
        if (p && !p.claimed) out.push({ trade: t, profit: p });
      });
    });
    return out.sort((a, b) => (Number(b.profit.at) || 0) - (Number(a.profit.at) || 0));
  },

  securedBlock(userId) {
    const list = this.securedEntries(userId || me().id);
    if (!list.length) return '';
    const total = list.reduce((sum, x) => sum + (Number(x.profit.coins) || 0), 0);
    const rows = list.map(({ trade, profit }) => `<div class="inv-row" style="align-items:center;gap:8px">
      <div class="grow" style="min-width:0">
        <div class="small" style="font-weight:650">${esc(this.label(trade.ticker))}
          <span class="tiny muted">· ${trade.side === 'short' ? 'Fall' : 'Rise'} ${trade.leverage}× · secured ${clockTime(profit.at)}</span></div>
        <div class="tiny muted">Secured at ${this.px(trade.ticker, profit.price)}${trade.status === 'Open' ? ' · trade still running' : ' · trade closed'}</div>
      </div>
      <div style="text-align:right">
        <div class="small up" style="font-weight:700">+${coins(profit.coins)} WC</div>
        <button class="btn btn-xs btn-primary" data-act="lt-claim-profit" data-trade="${trade.id}" data-profit="${profit.id}">Take profit</button>
      </div>
    </div>`).join('');
    return `<div class="card" id="ltSecured">
      <div class="between"><div class="card-title" style="margin:0">Secured profits
        <span class="badge badge-success" style="margin-left:6px">${list.length}</span></div>
        <span class="tiny up">${coins(total)} WC pending</span></div>
      <div class="tiny muted" style="margin:4px 0 8px;line-height:1.6">
        The Auto Secure bot locked these profits while you were away. Press <b>Take profit</b> on each entry to credit it to your balance.
      </div>
      <div class="inv-list">${rows}</div>
    </div>`;
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
    const head = `<div class="between"><div class="card-title" style="margin:0">Trade · ${esc(INV.assetTicker ? INV.assetTicker(ticker) : ticker)}</div>
        <span class="badge">${lev}×</span></div>`;

    if (pos) {
      return `<div class="card" id="ltTicket">
        ${head}
        <div class="tiny muted" style="margin:4px 0 10px">Your position is live and counting now — it is not waiting for the market.</div>
        ${this.cardHTML(pos)}
        <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-primary grow" data-act="lt-tp" data-id="${pos.id}" data-lt-tp-btn="${pos.id}" ${this.calc(pos).pnlCoins > 0 ? '' : 'disabled'}>
            ${ic('trend', 15)} Take profit <span data-lt-tp-amt="${pos.id}">${this.calc(pos).pnlCoins > 0 ? '(+' + coins(this.calc(pos).pnlCoins) + ')' : ''}</span></button>
          <button class="btn btn-soft grow" data-act="lt-stop" data-id="${pos.id}">
            ${ic('ban', 15)} Stop trade</button>
          <button class="btn btn-ghost grow" data-act="lt-sl" data-id="${pos.id}" data-lt-sl-btn="${pos.id}" ${this.calc(pos).pnlCoins < 0 ? '' : 'disabled'}>
            ${ic('down', 15)} Take loss <span data-lt-sl-amt="${pos.id}">${this.calc(pos).pnlCoins < 0 ? '(−' + coins(Math.abs(this.calc(pos).pnlCoins)) + ')' : ''}</span></button>
        </div>
        <button class="btn btn-soft btn-sm" data-act="lt-edit-tpsl" data-id="${pos.id}" style="width:100%;margin-top:8px">
          ${ic('edit', 14)} Edit Take Profit / Stop Loss</button>
        <div class="tiny muted center mt6">Profit: capital + gain · Loss: remaining capital · Total loss: nothing returned</div>
      </div>`;
    }

    return `<div class="card" id="ltTicket">
      ${head}
      <div class="tiny muted" style="margin:4px 0 10px;line-height:1.6">
        Enter your limit and how long the trade runs, then press <b>Buy</b>. The trade starts immediately and earns or loses in real time.</div>
      <div class="lt-side-pick">
        <button class="lt-side-btn on" data-act="lt-side" data-side="long">▲ Rise (price up)</button>
        <button class="lt-side-btn" data-act="lt-side" data-side="short">▼ Fall (price down)</button>
      </div>
      <div class="tiny muted" id="ltSideHint" style="margin:-4px 0 10px;line-height:1.5">
        ▲ <b>Rise:</b> you profit when the chart moves up and lose when it moves down.
      </div>
      <div class="field"><label class="label">Capital (Whale Coin)</label>
        <div class="input-wrap"><span class="inv-prefix">WC</span>
          <input class="input" id="ltCapital" type="number" step="1" min="${this.MIN_CAPITAL}" placeholder="0"/></div>
        <div class="tiny muted" id="ltCapitalUsd">≈ $0.00 · balance ${coins(me().balance)} WC</div></div>
      <div class="lt-tpsl-grid">
        <div class="lt-level-box" data-k="tp" data-mode="${LT.levels.tp}">
          <div class="between"><label class="label">Take Profit <span class="tiny muted">skims profit, trade continues</span></label>
            <div class="lt-modebtns">
              <button type="button" class="${LT.levels.tp === 'pct' ? 'on' : ''}" data-act="lt-mode" data-k="tp" data-mode="pct">%</button>
              <button type="button" class="${LT.levels.tp === 'price' ? 'on' : ''}" data-act="lt-mode" data-k="tp" data-mode="price">$</button>
              <button type="button" class="${LT.levels.tp === 'wc' ? 'on' : ''}" data-act="lt-mode" data-k="tp" data-mode="wc">WC</button>
            </div></div>
          <div class="input-wrap"><span class="inv-prefix" id="ltTpPrefix">${LT.levels.tp === 'price' ? '$' : LT.levels.tp === 'wc' ? 'WC' : '%'}</span>
            <input class="input" id="ltTp" type="number" step="0.01" min="0" placeholder="optional"/></div>
          <div class="lt-quick" data-quick="pct">
            <button type="button" data-act="lt-quick" data-k="tp" data-pct="10">+10%</button>
            <button type="button" data-act="lt-quick" data-k="tp" data-pct="25">+25%</button>
            <button type="button" data-act="lt-quick" data-k="tp" data-pct="50">+50%</button>
            <button type="button" data-act="lt-quick" data-k="tp" data-pct="100">+100%</button>
          </div>
          <div class="lt-quick" data-quick="wc">
            <button type="button" data-act="lt-quick" data-k="tp" data-unit="wc" data-val="10">+10 WC</button>
            <button type="button" data-act="lt-quick" data-k="tp" data-unit="wc" data-val="25">+25 WC</button>
            <button type="button" data-act="lt-quick" data-k="tp" data-unit="wc" data-val="50">+50 WC</button>
          </div>
          <div class="lt-preview" id="ltTpPreview">Target —</div>
        </div>
        <div class="lt-level-box" data-k="sl" data-mode="${LT.levels.sl}">
          <div class="between"><label class="label">Stop Loss <span class="tiny muted">optional</span></label>
            <div class="lt-modebtns">
              <button type="button" class="${LT.levels.sl === 'pct' ? 'on' : ''}" data-act="lt-mode" data-k="sl" data-mode="pct">%</button>
              <button type="button" class="${LT.levels.sl === 'price' ? 'on' : ''}" data-act="lt-mode" data-k="sl" data-mode="price">$</button>
              <button type="button" class="${LT.levels.sl === 'wc' ? 'on' : ''}" data-act="lt-mode" data-k="sl" data-mode="wc">WC</button>
            </div></div>
          <div class="input-wrap"><span class="inv-prefix" id="ltSlPrefix">${LT.levels.sl === 'price' ? '$' : LT.levels.sl === 'wc' ? 'WC' : '%'}</span>
            <input class="input" id="ltSl" type="number" step="0.01" min="0" placeholder="optional"/></div>
          <div class="lt-quick" data-quick="pct">
            <button type="button" data-act="lt-quick" data-k="sl" data-pct="10">-10%</button>
            <button type="button" data-act="lt-quick" data-k="sl" data-pct="25">-25%</button>
            <button type="button" data-act="lt-quick" data-k="sl" data-pct="50">-50%</button>
            <button type="button" data-act="lt-quick" data-k="sl" data-pct="100">-100%</button>
          </div>
          <div class="lt-quick" data-quick="wc">
            <button type="button" data-act="lt-quick" data-k="sl" data-unit="wc" data-val="10">-10 WC</button>
            <button type="button" data-act="lt-quick" data-k="sl" data-unit="wc" data-val="25">-25 WC</button>
            <button type="button" data-act="lt-quick" data-k="sl" data-unit="wc" data-val="50">-50 WC</button>
          </div>
          <div class="lt-preview" id="ltSlPreview">Target —</div>
        </div>
      </div>
      <label class="lt-trail-row">
        <input type="checkbox" id="ltTrail"/>
        <span class="small">Trailing stop</span>
        <span class="lt-trail-dist"><input class="input" id="ltTrailPct" type="number" step="0.1" min="0.5" max="50" value="2"/>% behind price</span>
      </label>
      <div class="tiny muted" id="ltTpslHint" style="margin:-2px 0 10px;line-height:1.55">Rise: TP above entry, SL below. Fall: TP below entry, SL above. <b>Take Profit skims the profit into your balance and keeps the trade running</b>; <b>Stop Loss ends the trade</b>. WC mode targets a Whale Coin amount.</div>
      <div class="field"><label class="label">Trade duration</label>
        <select class="input" id="ltDuration">${this.DURATIONS.map(d => `<option value="${d.m}" ${d.m === 60 ? 'selected' : ''}>${d.label}</option>`).join('')}</select></div>
      <div class="lt-div-est" id="ltDivEst">Dividend bonus · calculating…</div>
      <button class="btn btn-primary" data-act="lt-start" data-t="${esc(ticker)}" style="width:100%">
        ${ic('play', 15)} Buy</button>
      <div class="tiny muted center mt6">${ic('lock', 11)} Capital is held while the trade runs · ${this.feePct()}% fee · take profit skims &amp; continues · stop loss closes automatically · timer ends the trade</div>
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
  .lt-action-row{flex-wrap:nowrap}
  .lt-action-row .btn{flex:1 1 0;min-width:0;padding:8px 4px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  @media(max-width:380px){.lt-action-row{flex-wrap:wrap}.lt-action-row .btn{flex:1 1 46%}}
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
  .lt-tpsl-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .lt-level-box{border:1px solid var(--border);border-radius:12px;padding:9px;background:var(--surface-2)}
  .lt-level-box .label{margin-bottom:5px}
  .lt-modebtns{display:flex;gap:3px}
  .lt-modebtns button{border:1px solid var(--border);background:var(--surface);color:var(--muted);
    border-radius:7px;font-size:10px;font-weight:700;padding:2px 7px;cursor:pointer;line-height:1.5}
  .lt-modebtns button.on{border-color:rgba(46,230,201,.55);color:var(--text);background:rgba(46,230,201,.14)}
  .lt-quick{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
  .lt-quick button{border:1px solid var(--border);background:var(--surface);color:var(--muted);
    border-radius:99px;font-size:10px;font-weight:650;padding:3px 7px;cursor:pointer}
  .lt-quick button:hover{color:var(--text);border-color:var(--border-strong)}
  .lt-quick button.lt-clear{color:var(--danger)}
  .lt-levels{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;
    padding-top:7px;border-top:1px dashed var(--border)}
  .lt-lvl{font-size:10px;font-weight:700;display:inline-flex;align-items:center;gap:4px;color:var(--muted)}
  .lt-lvl i{width:7px;height:7px;border-radius:50%;display:inline-block}
  .lt-lvl.tp i{background:#22c55e} .lt-lvl.sl i{background:#ef4444}
  .lt-lvl b{color:var(--text);font-variant-numeric:tabular-nums}
  .lt-lvl small{font-size:9px;color:var(--muted-2);font-weight:600}
  .div-badge{display:inline-flex;align-items:center;font-size:9px;font-weight:700;color:#ffc861;
    border:1px solid rgba(255,200,97,.28);background:rgba(255,200,97,.08);border-radius:99px;padding:1px 5px;white-space:nowrap}
  .div-est{display:inline-flex;align-items:center;font-size:9px;font-weight:700;color:var(--accent);
    border:1px solid rgba(46,230,201,.24);background:rgba(46,230,201,.07);border-radius:99px;padding:1px 5px;white-space:nowrap}
  .div-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:2px;min-height:13px}
  .lt-div-est{margin:-2px 0 10px;padding:8px 10px;border-radius:9px;font-size:11px;line-height:1.5;
    color:var(--success);background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.18)}
  .lt-div-est.off{color:var(--muted);background:var(--surface-2);border-color:var(--border)}
  .lt-div-line{color:var(--gold);margin-top:3px}
  .lt-hist-levels .div{color:var(--gold)}
  .lt-edit{margin-left:auto;border:1px solid var(--border);background:var(--surface);
    color:var(--accent);border-radius:8px;font-size:10px;font-weight:700;padding:3px 6px;cursor:pointer}
  .lt-lvl-head{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:13px}
  .lt-preview{margin-top:6px;font-size:10px;font-weight:650;color:var(--accent);font-variant-numeric:tabular-nums}
  .lt-level-box .lt-quick{display:none}
  .lt-level-box[data-mode="pct"] .lt-quick[data-quick="pct"],
  .lt-level-box[data-mode="wc"] .lt-quick[data-quick="wc"]{display:flex}
  .lt-trail-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px;
    padding:8px 10px;border:1px dashed var(--border);border-radius:11px;background:var(--surface-2)}
  .lt-trail-row input[type="checkbox"]{width:15px;height:15px;accent-color:var(--accent)}
  .lt-trail-dist{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--muted);margin-left:auto}
  .lt-trail-dist .input{width:58px;padding:5px 7px;font-size:11px;height:auto}
  .lt-hist-levels{display:flex;gap:8px;flex-wrap:wrap;margin-top:3px;font-size:9.5px;color:var(--muted)}
  .lt-hist-levels span{background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:1px 5px}
  .lt-hist-levels .tp{color:#22c55e} .lt-hist-levels .sl{color:#ef4444}
  .lt-hist-levels .trail{color:var(--warn)}
  .lt-lvl.trail{color:var(--warn);font-size:9.5px}
  @media(max-width:420px){.lt-tpsl-grid{grid-template-columns:1fr}}
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
  if (chart && !chart.__wcLwc) {
    const t = chart.getAttribute('data-lt-live-chart');
    const tf = chart.getAttribute('data-lt-tf') || '1D';
    const mode = chart.getAttribute('data-lt-mode') || 'line';
    const vals = INV.series(t, tf);
    chart.innerHTML = mode === 'candle' ? INV.candleChart(vals) : INV.lineChart(vals, { h: 150 });
  }
};

/* =========================== dashboard (trade aware) ====================== */
const LT_WINDOW = { '1D': 864e5, '1W': 7 * 864e5, '1M': 30 * 864e5, '3M': 90 * 864e5, '1Y': 365 * 864e5, 'ALL': 730 * 864e5 };

/* ------------------------- bot performance (live) ------------------------- */
LT.botSession = function (userId) {
  try {
    const B = (typeof window !== 'undefined') ? window.WC_BOTS : null;
    const s = B && B.state && B.state.session;
    if (!s || (s.userId && s.userId !== userId)) return null;
    return s;
  } catch (e) { return null; }
};

/* bot equity at a point in time: allocation, then each simulated trade's pool */
LT.botValueAt = function (session, at) {
  if (!session) return 0;
  const alloc = Number(session.allocatedCoins) || 0;
  if (!(alloc > 0)) return 0;
  if (at < (Number(session.startedAt) || 0)) return 0;
  let v = alloc;
  const trades = (session.trades || []).slice().sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  trades.forEach((tr) => {
    if ((Number(tr.at) || 0) > at) return;
    const after = Number(tr.poolAfter);
    if (Number.isFinite(after)) v = after;
  });
  if (at >= Date.now() - 3000) v = Number(session.poolCoins) || v;
  return Math.max(0, v);
};

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
  const bot = LT.botSession(userId);
  const botValue = bot ? (Number(bot.poolCoins) || 0) : 0;
  const botCapital = bot ? (Number(bot.allocatedCoins) || 0) : 0;
  const botPnl = bot ? Math.round((botValue - botCapital) * 100) / 100 : 0;
  let valueCoins = pos.reduce((s, p) => s + p.valueCoins, 0);
  let capital = pos.reduce((s, p) => s + p.capital, 0);
  let pnl = pos.reduce((s, p) => s + p.pnlCoins, 0);
  if (bot) { valueCoins += botValue; capital += botCapital; pnl += botPnl; }
  const u = me();
  return {
    pos, valueCoins, capital, pnl,
    valueUsd: coinsToUsd(valueCoins),
    capitalUsd: coinsToUsd(capital),
    pnlUsd: coinsToUsd(pnl),
    pnlPct: capital ? (pnl / capital) * 100 : 0,
    cash: (u && u.balance) || 0,
    live: pos.filter(p => p.kind === 'trade').length,
    botActive: !!bot,
    botValue, botCapital, botPnl,
    botTrades: bot ? (Number(bot.tradeCount) || (bot.trades || []).length || 0) : 0,
    botStatus: bot ? bot.status : null,
    botTier: bot ? bot.tierName : null,
    botLast: bot && bot.trades && bot.trades.length ? bot.trades[0] : null
  };
};

/* series for the performance chart: spot holdings + live trades + trading bot */
LT.seriesWithTrades = function (tf, userId) {
  const pos = LT.positions(userId);
  const bot = LT.botSession(userId);
  if (!pos.length && !bot) return [];
  const win = LT_WINDOW[tf] || LT_WINDOW['1M'];
  const now = Date.now();
  const series = pos.map(p => ({ p, data: INV.series(p.ticker, tf) }));
  const len = pos.length ? Math.max(...series.map(s => s.data.length)) : 60;
  const out = [];
  for (let i = 0; i < len; i++) {
    const msAgo = (1 - i / Math.max(1, len - 1)) * win;
    let v = bot ? LT.botValueAt(bot, now - msAgo) : 0;
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
  const bot = LT.botSession(userId);
  if (bot) map['Trading Bot'] = (map['Trading Bot'] || 0) + (Number(bot.poolCoins) || 0);
  return Object.keys(map).map(t => ({ ticker: t, value: coinsToUsd(map[t]) })).sort((a, b) => b.value - a.value);
};

LT.dash = function (params) {
  const u = me();
  const s = LT.summary(u.id);
  const hasPerf = s.pos.length > 0 || s.botActive;
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
      <div><div class="card-title" style="margin:0;display:flex;align-items:center;gap:7px">Portfolio performance
        ${hasPerf ? '<span class="lt-live-badge"><i></i>LIVE</span>' : ''}</div>
        <div class="tiny muted">${hasPerf ? tf + ' · live performance' + (s.botActive ? ' + bot' : '') : 'No positions yet'}</div></div>
      ${INV.seg(tf)}
    </div>
    <div class="inv-chart" id="ltDashChart" data-ltd-chart="${tf}">
      ${hasPerf ? INV.lineChart(series, { h: 150 }) : `<div class="inv-empty">${ic('trend', 26)}<p class="small muted">Start a trade, buy stock or run a bot to see performance.</p><a href="#/invest/market" class="btn btn-sm btn-primary">Explore market</a></div>`}
    </div>
    ${s.botActive ? `<div class="tiny center ${s.botPnl >= 0 ? 'up' : 'down'}" style="margin-top:5px" data-lt-bot-line>
      ${ic('trend', 11)} ${esc(s.botTier || 'Trading bot')} · ${coins(s.botValue)} WC equity · ${s.botPnl >= 0 ? '+' : '−'}${coins(Math.abs(s.botPnl))} WC · ${s.botTrades} trade${s.botTrades === 1 ? '' : 's'}${s.botStatus === 'running' ? ' · live' : ''}
      ${s.botLast ? `<span class="muted"> · last ${esc(s.botLast.ticker || '')} ${Number(s.botLast.pnlCoins) >= 0 ? '+' : '−'}${coins(Math.abs(Number(s.botLast.pnlCoins) || 0))} WC</span>` : ''}
    </div>` : ''}
    <div class="tiny muted center wc-feed-notice" data-market-notice="1" style="margin-top:6px">Simulated market data · 24/7</div>
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

  <div class="card inv-note">${ic('shield', 14)} <span class="tiny">Prices stream from Finnhub. Crypto trades 24/7, Forex 24/5, and closed stock exchanges hold their last real print. Values include live trades and holdings at 1 WC = $0.50.</span></div>`;
};

function usd_LT(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }

LT.positionsHTML = function (userId) {
  const pos = LT.positions(userId);
  const bot = LT.botSession(userId);
  if (!pos.length && !bot) return `<div class="inv-empty">${ic('bag', 26)}<p class="small muted">No open positions. Buy a stock or start a trade to begin.</p><a href="#/invest/market" class="btn btn-sm btn-primary">Browse stocks</a></div>`;
  const botRow = bot ? (() => {
    const pnl = Math.round(((Number(bot.poolCoins) || 0) - (Number(bot.allocatedCoins) || 0)) * 100) / 100;
    return `<a class="inv-row" href="#/invest/bots">
      <span class="inv-logo" style="width:38px;height:38px;background:linear-gradient(135deg,#2ee6c9,#3aa0ff)"><b style="font-size:12px">BOT</b></span>
      <div class="grow" style="min-width:0">
        <div class="small ellipsis" style="font-weight:650">${esc(bot.tierName || 'Trading Bot')} <span class="lt-side long">Auto</span></div>
        <div class="tiny muted">${coins(Number(bot.allocatedCoins) || 0)} WC in · ${coins(Number(bot.poolCoins) || 0)} WC equity</div>
        <div class="tiny muted">${Number(bot.tradeCount) || 0} bot trade${(Number(bot.tradeCount) || 0) === 1 ? '' : 's'}${bot.status === 'running' ? ' · live' : ''}</div>
      </div>
      <div style="text-align:right">
        <div class="small ${pnl >= 0 ? 'up' : 'down'}" style="font-weight:650">${pnl >= 0 ? '+' : '−'}${coins(Math.abs(pnl))} WC</div>
        <div class="tiny muted">bot P/L</div>
      </div></a>`;
  })() : '';
  return `<div class="inv-list">${botRow}${pos.map(p => {
    const stock = INV.stock(p.ticker) || { ticker: p.ticker, name: p.ticker, color: '#3aa0ff' };
    const up = p.pnlCoins > 0, down = p.pnlCoins < 0;
    const tag = p.kind === 'trade' ? `<span class="lt-side ${p.side}">${p.side === 'short' ? 'Short' : 'Long'} ${p.lev}×</span>` : '';
    return `<a class="inv-row" href="#/invest/stock/${p.ticker}">
      ${INV.logoHTML(stock)}
      <div class="grow" style="min-width:0">
        <div class="small ellipsis" style="font-weight:650">${esc(stock.name)} ${tag}</div>
        <div class="tiny muted">${coins(p.capital)} WC in · now ${coins(p.valueCoins)} WC</div>
        <div class="div-row">${LT.dividendBadge(p.ticker)}${p.kind === 'trade'
          ? LT.dividendEstimateBadge(p.ticker, p.capital, Number(p.trade.durationMinutes) || 0, p.trade.durationLabel || 'timer')
          : LT.dividendEstimateBadge(p.ticker, p.valueCoins || p.capital, 1440, '1d')}</div>
      </div>
      <span class="lt-mini">${INV.spark(p.ticker)}</span>
      <div style="text-align:right">
        <div class="small" style="font-weight:650">${LT.px(p.ticker, p.price)}</div>
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
  if (chart && !chart.__wcLwc) {
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

App.admGenerateProducts = async function () {
  const el = document.getElementById('companyGenCount');
  const count = Math.round(Number(el && el.value) || 0);
  if (count < 50 || count > 100) return toast('Choose between 50 and 100 products', 'err');
  if (!await confirmDialog({
    title: 'Generate ' + count + ' wholesale products?',
    body: 'Adds ' + count + ' new products to the Company Marketplace across electronics, sound systems, phones, watches, bags, chargers, power banks and solar systems. Products already in the catalogue stay exactly as they are.',
    ok: 'Generate ' + count + ' products'
  })) return;
  try {
    const res = await LT.generateCompanyProducts(count);
    if (!res.ok) return toast(res.error, 'err');
    const cats = Object.keys(res.byCategory).length;
    toast(res.added + ' products added across ' + cats + ' categories · ' + res.total + ' in the company market', 'ok', 3600);
    render();
  } catch (e) {
    toast('Could not generate products: ' + e.message, 'err');
  }
};

function ltProductsCard() {
  const items = DB.companyProducts || [];
  const total = items.length;
  const withPics = items.filter(p => p.image).length;
  const cats = [...new Set(items.map(p => p.category))];
  const gen = (DB.settings && DB.settings.companyGen) || null;
  return `<div class="card mt16">
    <div class="between" style="align-items:flex-start;flex-wrap:wrap;gap:12px">
      <div style="min-width:220px;flex:1">
        <div class="card-title" style="margin:0 0 4px">Generate products</div>
        <div class="small muted" style="line-height:1.7">
          Add <b>50–100 different products</b> to the Company Marketplace so vendors have fresh stock to buy:
          electronics, sound systems, phones, watches, bags, chargers, power banks and solar systems.
          Existing products are <b>kept</b> — generating only adds new SKUs.
        </div>
      </div>
      <div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="margin:0;width:120px"><label class="label">How many</label>
          <input class="input" id="companyGenCount" type="number" min="50" max="100" step="1" value="60" inputmode="numeric"/></div>
        <button class="btn btn-primary" data-act="adm-generate-products">${ic('box', 15)} Generate products</button>
      </div>
    </div>
    <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
      <span class="badge">${total} products</span>
      <span class="badge">${cats.length} categories</span>
      <span class="badge ${withPics ? 'badge-success' : 'badge-warn'}">${withPics} with photos</span>
      <span class="badge">Vendors only</span>
    </div>
    ${cats.length ? `<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">${cats.slice(0, 14).map(c => `<span class="badge" style="font-size:10px">${esc(c)}</span>`).join('')}${cats.length > 14 ? `<span class="tiny muted">+${cats.length - 14} more</span>` : ''}</div>` : ''}
    <div class="tiny muted mt10" style="line-height:1.7">
      ${gen && gen.lastAt ? `Last run: <b>${gen.lastCount}</b> products ${timeAgo(gen.lastAt)} · ${gen.total} generated in total. ` : ''}
      Every run picks different catalogue models first, then edition variants, so the marketplace fills with
      distinct SKUs. Photos are real studio shots shipped with the app — not illustrations or emoji.</div>
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
      <div class="between mt6"><span class="tiny muted">Storefront views</span>
        <b class="small">${(Number(v.views) || 0).toLocaleString('en-US')}</b></div>
      <div class="between mt6"><span class="tiny muted">View-to-sale conversion</span>
        <b class="small">${(Number(v.views) || 0) ? ((st.units / Number(v.views)) * 100).toFixed(1) + '%' : '—'}</b></div>
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
    <div class="between"><div class="card-title" style="margin:0">Your ${esc(INV.assetTicker ? INV.assetTicker(ticker) : ticker)} history</div>
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
          <div class="small" style="font-weight:650">${t.side === 'short' ? 'Fall' : 'Rise'} ${t.leverage}×
            <span class="tiny muted">· ${esc(t.closeReason || 'closed')}</span></div>
          <div class="tiny muted">${coins(t.capitalCoins)} WC · ${this.px(t.ticker, t.entryPrice)} → ${this.px(t.ticker, t.exitPrice || 0)} · ${dateLabel(t.closedAt)}</div>
          <div class="lt-hist-levels">${Number(t.takeProfitPrice) > 0 ? `<span class="tp">TP ${usd(t.takeProfitPrice)}${Number(t.takeProfitWc) > 0 ? ' · ' + Number(t.takeProfitWc) + ' WC' : ''}</span>` : '<span>TP —</span>'}
            ${Number(t.stopLossPrice) > 0 ? `<span class="sl">${t.trailingActive ? 'TSL' : 'SL'} ${usd(t.stopLossPrice)}${Number(t.stopLossWc) > 0 ? ' · ' + Number(t.stopLossWc) + ' WC' : ''}</span>` : '<span>SL —</span>'}
            ${t.trailingActive ? `<span class="trail">trail ${Number(t.trailingStopPct).toFixed(1)}%</span>` : ''}
            ${Number(t.dividendCoins) > 0 ? `<span class="div">+${Number(t.dividendCoins)} WC div</span>` : ''}</div>
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
  const allShoppers = (DB.users || []).filter(u => u.isBot && !u.isDemoSeller);
  const generatedUsers = allShoppers.filter(u => u.isDemoUser);
  const duCfg = LT.demoUsersCfg ? LT.demoUsersCfg() : { generated: 0 };
  const orderUsers = new Set(orders.map(o => o.buyerId)).size;
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
      <span class="badge">${allShoppers.length} demo users</span>
      <span class="badge">${bots.length} scheduled shoppers</span>
      <span class="badge">${orders.length} demo orders</span>
      <span class="badge">${orderUsers} users have ordered</span>
      <span class="badge">$${(cfg.gmvUsd || 0).toFixed(2)} simulated spend</span>
    </div>
    <div class="inv-note tiny" style="margin-top:12px">${ic('shield', 13)}
      <span>Demo orders are marked <b>simulated</b> on the order, and each account carries a bot flag, so this revenue is
      always distinguishable from real sales. It must never be treated as withdrawable money.</span></div>
  </div>

  <div class="card">
    <div class="card-title">Generate demo users</div>
    <div class="tiny muted" style="line-height:1.7;margin-bottom:10px">
      Create up to <b>10,000</b> demo shopper accounts with realistic names, cities and profile photos.
      Generated users are marked <b>demo</b>, cannot be signed into, and never touch real balances.
    </div>
    <div class="row wrap" style="gap:8px;align-items:flex-end">
      <div class="field" style="margin:0;width:150px"><label class="label">How many users</label>
        <input class="input" id="demoUserCount" type="number" min="1" max="10000" step="1" value="100" inputmode="numeric"/></div>
      <button class="btn btn-primary" data-act="demo-users-generate">${ic('users', 15)} Generate users</button>
    </div>
    <div class="row gap8 mt10" style="flex-wrap:wrap">
      <span class="badge">${allShoppers.length} demo users</span>
      <span class="badge">${generatedUsers.length} generated</span>
      <span class="badge">8 portrait photos in rotation</span>
    </div>
    <div class="tiny muted mt6">Large fleets use compact records and are capped by this device's storage — if a run won't fit, the app says so and changes nothing.</div>
  </div>

  <div class="card">
    <div class="card-title">Demo orders</div>
    <div class="tiny muted" style="line-height:1.7;margin-bottom:10px">
      Choose how many demo users should place an order. Each selected user gets one simulated order
      from a demo storefront, dated within the last three weeks.
    </div>
    <div class="row wrap" style="gap:8px;align-items:flex-end">
      <div class="field" style="margin:0;width:190px"><label class="label">Users that order</label>
        <input class="input" id="demoOrderUsers" type="number" min="1" max="${Math.max(1, allShoppers.length)}" step="1" value="${Math.min(50, Math.max(1, allShoppers.length))}" inputmode="numeric"/></div>
      <button class="btn btn-primary" data-act="demo-users-orders">${ic('bag', 15)} Create orders</button>
    </div>
    <div class="tiny muted mt10">${duCfg.orderAt ? `Last run: ${duCfg.ordering} users ordered ${timeAgo(duCfg.orderAt)}. ` : ''}Orders are flagged <b>simulated</b> and appear in the Demo activity dashboard.</div>
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
  document.querySelectorAll('.lt-side-btn').forEach(b => b.dataset.side && b.classList.toggle('on', b.getAttribute('data-side') === ds.side));
  const hint = document.getElementById('ltSideHint');
  if (hint) {
    hint.innerHTML = ds.side === 'short'
      ? '▼ <b>Fall:</b> you profit when the chart moves down and lose when it moves up.'
      : '▲ <b>Rise:</b> you profit when the chart moves up and lose when it moves down.';
  }
  LT.previewTargets();
};
if (typeof INV !== 'undefined') {
  INV.dividendBadge = (t) => LT.dividendBadge(t);
  INV.dividendEstimate = (t, stake, minutes, label) => LT.dividendEstimateBadge(t, stake, minutes, label);
  INV.dividendYield = (t) => LT.dividendYield(t);
}
LT.levels = { tp: 'pct', sl: 'pct' };

LT.previewTargets = function () {
  const m = (location.hash || '').match(/^#\/invest\/stock\/([A-Z0-9.]+)/i);
  if (!m || typeof INV === 'undefined') return;
  const q = INV.quote(m[1]);
  if (!q) return;
  const capEl = document.getElementById('ltCapital');
  const capital = Number(capEl && capEl.value) || 0;
  const sideEl = document.querySelector('.lt-side-btn.on');
  const direction = sideEl && sideEl.getAttribute('data-side') === 'short' ? 'FALL' : 'RISE';
  const lev = LT.leverage();
  const tpRaw = Number((document.getElementById('ltTp') || {}).value) || 0;
  const slRaw = Number((document.getElementById('ltSl') || {}).value) || 0;
  const tp = LT.levelPrice(direction, q.price, tpRaw, LT.levels.tp, 'tp', capital, lev);
  const sl = LT.levelPrice(direction, q.price, slRaw, LT.levels.sl, 'sl', capital, lev);
  const trailOn = !!(document.getElementById('ltTrail') || {}).checked;
  const trailPct = Number((document.getElementById('ltTrailPct') || {}).value) || 0;
  const trailStop = trailOn && trailPct > 0
    ? q.price * (direction === 'FALL' ? (1 + trailPct / 100) : (1 - trailPct / 100)) : 0;
  const tpEl = document.getElementById('ltTpPreview');
  const slEl = document.getElementById('ltSlPreview');
  const fmt = (v) => (INV.priceText ? INV.priceText(m[1], v) : usd(v));
  if (tpEl) tpEl.textContent = tp > 0 ? 'Target ' + fmt(tp) + (LT.levels.tp === 'wc' ? ' · +' + Math.abs(tpRaw) + ' WC' : '') : 'Target —';
  if (slEl) slEl.textContent = trailOn
    ? (trailStop > 0 ? 'Starts ' + fmt(trailStop) + ' · trails ' + trailPct + '%' : 'Trailing stop —')
    : (sl > 0 ? 'Target ' + fmt(sl) + (LT.levels.sl === 'wc' ? ' · -' + Math.abs(slRaw) + ' WC' : '') : 'Target —');
};

LT.updateDividendEstimate = function () {
  const el = document.getElementById('ltDivEst');
  if (!el) return;
  const m = (location.hash || '').match(/^#\/invest\/stock\/([A-Z0-9.]+)/i);
  if (!m) return;
  const ticker = m[1].toUpperCase();
  const y = LT.dividendYield(ticker);
  const cap = Number((document.getElementById('ltCapital') || {}).value) || 0;
  const minutes = Number((document.getElementById('ltDuration') || {}).value) || 60;
  const label = (LT.DURATIONS.find(d => d.m === minutes) || {}).label || minutes + ' min';
  if (!(y > 0)) { el.innerHTML = 'No dividend on this stock'; el.classList.add('off'); return; }
  el.classList.remove('off');
  if (!(cap > 0)) {
    el.innerHTML = `Yield <b>${y.toFixed(2)}%</b> · enter a stake to estimate the ${label} bonus`;
    return;
  }
  const bonus = LT.dividendBonusFor(ticker, cap, minutes);
  el.innerHTML = `<b>+${coins(bonus)} WC</b> dividend bonus · yield ${y.toFixed(2)}% · ${label} · paid when the timer completes`;
};

App.ltMode = function (id, ds) {
  const k = ds && ds.k === 'sl' ? 'sl' : 'tp';
  const mode = ds && (ds.mode === 'price' || ds.mode === 'wc') ? ds.mode : 'pct';
  LT.levels[k] = mode;
  const box = document.querySelector('.lt-level-box[data-k="' + k + '"]');
  if (box) box.dataset.mode = mode;
  document.querySelectorAll('[data-act="lt-mode"][data-k="' + k + '"]').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-mode') === mode);
  });
  const pre = document.getElementById(k === 'tp' ? 'ltTpPrefix' : 'ltSlPrefix');
  if (pre) pre.textContent = mode === 'price' ? '$' : mode === 'wc' ? 'WC' : '%';
  LT.previewTargets();
};

App.ltQuick = function (id, ds) {
  const k = ds && ds.k === 'sl' ? 'sl' : 'tp';
  const input = document.getElementById(k === 'tp' ? 'ltTp' : 'ltSl');
  const wc = ds && ds.unit === 'wc';
  if (input) input.value = wc ? (Number(ds.val) || '') : (Math.abs(Number(ds && ds.pct) || 0) || '');
  App.ltMode(null, { k, mode: wc ? 'wc' : 'pct' });
};

App.ltStart = function (id, ds) {
  const capEl = document.getElementById('ltCapital');
  const capital = Number(capEl && capEl.value) || 0;
  const sideEl = document.querySelector('.lt-side-btn.on');
  const side = sideEl ? sideEl.getAttribute('data-side') : 'long';
  const q = INV.quote(ds.t);
  if (!q) return toast('No live price for ' + ds.t, 'err');
  const direction = side === 'short' ? 'FALL' : 'RISE';
  const lev = LT.leverage();
  const tpRaw = Number((document.getElementById('ltTp') || {}).value) || 0;
  const slRaw = Number((document.getElementById('ltSl') || {}).value) || 0;
  const tpPrice = LT.levelPrice(direction, q.price, tpRaw, LT.levels.tp, 'tp', capital, lev);
  const slPrice = LT.levelPrice(direction, q.price, slRaw, LT.levels.sl, 'sl', capital, lev);
  const trailOn = !!(document.getElementById('ltTrail') || {}).checked;
  const trailPct = trailOn ? (Number((document.getElementById('ltTrailPct') || {}).value) || 2) : 0;
  if ((LT.levels.tp === 'wc' && tpRaw > 0 && !(tpPrice > 0)) || (LT.levels.sl === 'wc' && slRaw > 0 && !(slPrice > 0))) {
    return toast('Enter a capital amount first — or use a smaller WC target', 'err');
  }
  const err = LT.validateLevels(direction, q.price, tpPrice, trailOn ? 0 : slPrice);
  if (err) return toast(err, 'err');
  const minutes = Number((document.getElementById('ltDuration') || {}).value) || 60;
  const modeName = (m) => m === 'price' ? 'PRICE' : m === 'wc' ? 'WC' : 'PERCENT';
  LT.start(side, ds.t, capital, {
    tpPrice, slPrice, minutes,
    tpMode: modeName(LT.levels.tp),
    slMode: trailOn ? 'TRAILING' : modeName(LT.levels.sl),
    tpWc: LT.levels.tp === 'wc' ? tpRaw : 0,
    slWc: LT.levels.sl === 'wc' ? slRaw : 0,
    trailingPct: trailPct
  });
};
App.ltTp = async function (id, ds) {
  const t = DB.trades.find(x => x.id === ds.id);
  if (!t || t.status !== 'Open') return toast('This trade is already closed', 'err');
  if (!(LT.calc(t).pnlCoins > 0)) return toast('No profit to take yet', 'err');
  /* the backend skim is atomic; fall back to the local bookkeeping offline */
  if (typeof Remote !== 'undefined' && Remote && Remote.enabled) {
    try {
      const r = await Remote.fetchJSON('/api/market/trade/take-profit', {
        method: 'POST',
        body: JSON.stringify({ userId: me().id, tradeId: t.id })
      }, 8000);
      if (r.res && r.res.ok && r.data && r.data.ok) {
        await Remote.refresh(true);
        toast(`Profit taken — ${coins(Number(r.data.profit) || 0)} WC credited. Trade continues`, 'ok');
        return;
      }
      if (r.data && r.data.error) return toast(r.data.error, 'err');
    } catch (e) { /* offline: local skim below */ }
  }
  LT.takeProfit(t, 'Take Profit Taken');
};
App.ltClaimProfit = async function (id, ds) {
  const tradeId = ds.trade;
  const profitId = ds.profit;
  const t = (DB.trades || []).find((x) => x && x.id === tradeId);
  const rec = t && (t.securedProfits || []).find((x) => x && x.id === profitId);
  if (!t || !rec) return toast('That secured profit was not found', 'err');
  if (rec.claimed) return toast('This profit has already been claimed', 'err');
  if (typeof Remote !== 'undefined' && Remote && Remote.enabled) {
    try {
      const r = await Remote.fetchJSON('/api/market/secure-profit/claim', {
        method: 'POST',
        body: JSON.stringify({ userId: me().id, tradeId, profitId })
      }, 8000);
      if (r.res && r.res.ok && r.data && r.data.ok) {
        await Remote.refresh(true);
        toast(`Take profit claimed — +${coins(Number(r.data.coins) || 0)} WC credited`, 'ok');
        return;
      }
      if (r.data && r.data.error) return toast(r.data.error, 'err');
    } catch (e) { /* fall through to local */ }
  }
  const u = findUser(t.userId);
  if (!u) return toast('User not found', 'err');
  u.balance = Math.round(((Number(u.balance) || 0) + (Number(rec.coins) || 0)) * 100) / 100;
  rec.claimed = true;
  rec.claimedAt = Date.now();
  tx(u.id, 'secured-profit-claim', `Secured profit claimed · ${t.ticker} · +${coins(rec.coins)} WC`, rec.coins,
    { tradeId: t.id, profitId: rec.id });
  notify(u.id, 'Secured profit credited', `+${coins(rec.coins)} WC from ${t.ticker} was added to your balance.`, '#/wallet', 'check');
  persist(); render();
  toast(`Take profit claimed — +${coins(rec.coins)} WC credited`, 'ok');
};

async function ltManualClose(t, action, reason) {
  if (typeof Remote !== 'undefined' && Remote && Remote.enabled) {
    try {
      const r = await Remote.fetchJSON('/api/market/trade/close', {
        method: 'POST',
        body: JSON.stringify({ userId: me().id, tradeId: t.id, action })
      }, 8000);
      if (r.res && r.res.ok && r.data && r.data.ok) {
        await Remote.refresh(true);
        toast(action === 'sl' ? `Take loss — ${coins(Number(r.data.payout) || 0)} WC returned` : `Trade stopped — ${coins(Number(r.data.payout) || 0)} WC returned`, 'ok');
        return true;
      }
      if (r.data && r.data.error) { toast(r.data.error, 'err'); return false; }
    } catch (e) { /* offline: local close below */ }
  }
  return LT.settle(t, reason);
}
App.ltStop = async function (id, ds) {
  const t = DB.trades.find(x => x.id === ds.id);
  if (!t || t.status !== 'Open') return toast('This trade is already closed', 'err');
  await ltManualClose(t, 'stop', 'Stopped by user');
};
App.ltSl = async function (id, ds) {
  const t = DB.trades.find(x => x.id === ds.id);
  if (!t || t.status !== 'Open') return toast('This trade is already closed', 'err');
  if (!(LT.calc(t).pnlCoins < 0)) return toast('The trade is not in loss — take loss is only available while losing', 'err');
  await ltManualClose(t, 'sl', 'Stop Loss Hit');
};

App.ltEditTpsl = function (id, ds) {
  const t = DB.trades.find(x => x.id === ds.id);
  if (!t || t.status !== 'Open') return toast('This trade is already closed', 'err');
  const dir = LT.dirOf(t);
  const entry = Number(t.entryPrice) || 0;
  const { tp, sl } = LT.tpslOf(t);
  const trailOn = !!t.trailingActive;
  const trailPct = Number(t.trailingStopPct) || 2;
  const body = `
    <div class="lt-lvl-head">
      <span class="lt-side ${t.side}">${dir === 'RISE' ? 'Rise' : 'Fall'} ${t.leverage}×</span>
      <b>${esc(LT.label(t.ticker))}</b><span class="tiny muted">Entry ${LT.px(t.ticker, entry)}</span>
    </div>
    <div class="field"><label class="label">Take Profit price (USD)</label>
      <input class="input" id="ltEditTp" type="number" step="0.01" min="0" value="${tp || ''}" placeholder="optional"/>
      <div class="lt-quick">
        <button type="button" data-act="lt-edit-quick" data-id="${t.id}" data-k="tp" data-pct="10">+10%</button>
        <button type="button" data-act="lt-edit-quick" data-id="${t.id}" data-k="tp" data-pct="25">+25%</button>
        <button type="button" data-act="lt-edit-quick" data-id="${t.id}" data-k="tp" data-pct="50">+50%</button>
        <button type="button" data-act="lt-edit-quick-wc" data-id="${t.id}" data-k="tp" data-wc="25">+25 WC</button>
        <button type="button" data-act="lt-edit-quick-wc" data-id="${t.id}" data-k="tp" data-wc="50">+50 WC</button>
        <button type="button" class="lt-clear" data-act="lt-edit-clear" data-id="${t.id}" data-k="tp">Clear</button>
      </div></div>
    <div class="field"><label class="label">Stop Loss price (USD)</label>
      <input class="input" id="ltEditSl" type="number" step="0.01" min="0" value="${sl || ''}" placeholder="optional"/>
      <div class="lt-quick">
        <button type="button" data-act="lt-edit-quick" data-id="${t.id}" data-k="sl" data-pct="10">-10%</button>
        <button type="button" data-act="lt-edit-quick" data-id="${t.id}" data-k="sl" data-pct="25">-25%</button>
        <button type="button" data-act="lt-edit-quick" data-id="${t.id}" data-k="sl" data-pct="50">-50%</button>
        <button type="button" data-act="lt-edit-quick-wc" data-id="${t.id}" data-k="sl" data-wc="25">-25 WC</button>
        <button type="button" data-act="lt-edit-quick-wc" data-id="${t.id}" data-k="sl" data-wc="50">-50 WC</button>
        <button type="button" class="lt-clear" data-act="lt-edit-clear" data-id="${t.id}" data-k="sl">Clear</button>
      </div></div>
    <label class="lt-trail-row">
      <input type="checkbox" id="ltEditTrail" ${trailOn ? 'checked' : ''}/>
      <span class="small">Trailing stop</span>
      <span class="lt-trail-dist"><input class="input" id="ltEditTrailPct" type="number" step="0.1" min="0.5" max="50" value="${trailPct}"/>% behind price</span>
    </label>
    <div class="tiny muted">${dir === 'RISE' ? 'Rise trade: TP above entry, SL below entry.' : 'Fall trade: TP below entry, SL above entry.'} A trailing stop starts at the SL price (or one trail-width behind entry) and only moves in your favour.</div>`;
  openModal(modalShell('Take Profit / Stop Loss', body,
    `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button>
     <button class="btn btn-ghost" id="ltTpClearBoth" style="flex:1">Remove both</button>
     <button class="btn btn-primary" id="ltTpSave" style="flex:1">Save</button>`), { locked: false });
  const save = (tpVal, slVal, trailWanted) => {
    const trailPctVal = trailWanted ? Math.max(0.5, Math.min(50, Number((document.getElementById('ltEditTrailPct') || {}).value) || 2)) : 0;
    const initialTrail = trailPctVal > 0
      ? (slVal > 0 ? slVal : entry * (dir === 'FALL' ? (1 + trailPctVal / 100) : (1 - trailPctVal / 100)))
      : 0;
    const err = LT.validateLevels(dir, entry, tpVal, trailPctVal > 0 ? initialTrail : slVal);
    if (err) return toast(err, 'err');
    t.takeProfitPrice = tpVal > 0 ? Math.round(tpVal * 10000) / 10000 : null;
    if (trailPctVal > 0) {
      t.trailingActive = true;
      t.trailingStopPct = trailPctVal;
      t.trailingStopPrice = Math.round(initialTrail * 10000) / 10000;
      t.stopLossPrice = t.trailingStopPrice;
      t.stopLossMode = 'TRAILING';
    } else {
      t.trailingActive = false;
      t.trailingStopPct = 0;
      t.trailingStopPrice = null;
      t.stopLossPrice = slVal > 0 ? Math.round(slVal * 10000) / 10000 : null;
      t.stopLossMode = 'PRICE';
    }
    t.tpPct = 0; t.slPct = 0;
    closeModal(); try { sync(); } catch (e) {}
    persist(); toast('TP / SL updated', 'ok'); render();
  };
  document.getElementById('ltTpSave').onclick = () => {
    save(Number(document.getElementById('ltEditTp').value) || 0,
         Number(document.getElementById('ltEditSl').value) || 0,
         !!(document.getElementById('ltEditTrail') || {}).checked);
  };
  document.getElementById('ltTpClearBoth').onclick = () => save(0, 0, false);
};

App.ltEditQuick = function (id, ds) {
  const t = DB.trades.find(x => x.id === ds.id);
  if (!t) return;
  const k = ds.k === 'sl' ? 'sl' : 'tp';
  const dir = LT.dirOf(t);
  const price = LT.levelPrice(dir, Number(t.entryPrice) || 0, ds.pct, 'pct', k);
  const input = document.getElementById(k === 'tp' ? 'ltEditTp' : 'ltEditSl');
  if (input) input.value = price;
};

App.ltEditQuickWc = function (id, ds) {
  const t = DB.trades.find(x => x.id === ds.id);
  if (!t) return;
  const k = ds.k === 'sl' ? 'sl' : 'tp';
  const price = LT.levelPrice(LT.dirOf(t), Number(t.entryPrice) || 0, ds.wc, 'wc', k, t.capitalCoins, t.leverage);
  const input = document.getElementById(k === 'tp' ? 'ltEditTp' : 'ltEditSl');
  if (input) input.value = price;
};

App.ltEditClear = function (id, ds) {
  const input = document.getElementById(ds.k === 'sl' ? 'ltEditSl' : 'ltEditTp');
  if (input) input.value = '';
};

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
  const block = LT.securedBlock(me().id) + LT.activeBlock();
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
  host.innerHTML = LT.securedBlock(me().id) + LT.activeBlock() + LT.closedBlock();
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
  try {
    const st = INV.stock(ticker);
    const admin = me() && me().role === 'admin';
    if (st && INV.classEnabled && INV.classOf && !INV.classEnabled(INV.classOf(st)) && !admin) return;
  } catch (e) {}

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
    LT.previewTargets();
  });
  ['ltTp', 'ltSl', 'ltTrailPct'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', LT.previewTargets);
  });
  const trail = document.getElementById('ltTrail');
  if (trail) trail.addEventListener('change', LT.previewTargets);
  const dur = document.getElementById('ltDuration');
  if (dur) dur.addEventListener('change', LT.updateDividendEstimate);
  if (cap) cap.addEventListener('input', LT.updateDividendEstimate);
  LT.previewTargets();
  LT.updateDividendEstimate();
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
