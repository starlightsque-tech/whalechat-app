'use strict';
/* =========================================================================
   WhaleChat Spot Stocks — buy / sell real Finnhub-priced stock positions
   -------------------------------------------------------------------------
   • A user buys a position at the current live Finnhub market price. The
     total cost is deducted from the WC wallet immediately and the position
     is stored with symbol, entry price, quantity, invested capital and
     optional Take Profit / Stop Loss targets.
   • Selling (manual, TP or SL) sells the whole position at the current live
     market price: payout = quantity × live price, credited to the wallet,
     and the trade is moved to Order History.
   • A background worker checks every open position once per second against
     the shared backend quote cache. The critical section below is fully
     synchronous, and a position is removed before the payout is credited,
     so a manual sell racing a TP/SL tick can never credit twice.
   • Admins can set a profit margin (%) per stock. It is added to the live
     Finnhub price when a user buys (the platform's edge) while every chart,
     quote and TP/SL check keeps using the raw live market price.
   ========================================================================= */

const crypto = require('crypto');

const COINS_PER_USD = 2;                 // 1 WC = $0.50
const MAX_PCT = 100;                     // admin margin cap (%)
const round = (v, n) => Math.round((Number(v) || 0) * Math.pow(10, n)) / Math.pow(10, n);
function nid(prefix) { return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

class SpotService {
  constructor(opts) {
    this.getDb = opts.getDb;
    this.persist = opts.persist || (() => {});
    this.broadcast = opts.broadcast || (() => {});
    this.getQuote = opts.getQuote || (() => null);
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.lastError = '';
    this.lastTickAt = 0;
    this.settledTotal = 0;
  }

  /* ------------------------------- helpers -------------------------------- */
  ensureDefaults(db) {
    if (!db) return false;
    let changed = false;
    if (!Array.isArray(db.holdings)) { db.holdings = []; changed = true; }
    if (!Array.isArray(db.trades)) { db.trades = []; changed = true; }
    return changed;
  }

  user(db, userId) {
    return (db.users || []).find((u) => u && u.id === String(userId || '')) || null;
  }

  stock(db, ticker) {
    const t = String(ticker || '').toUpperCase();
    return (db.stocks || []).find((s) => s && String(s.ticker).toUpperCase() === t) || null;
  }

  paused(db, ticker) {
    const t = String(ticker || '').toUpperCase();
    const inv = db.invest || {};
    if (inv.paused && inv.paused[t]) return true;
    const s = this.stock(db, ticker);
    return !!(s && s.paused);
  }

  livePrice(ticker) {
    let q = null;
    try { q = this.getQuote(String(ticker || '').toUpperCase()); } catch (e) { q = null; }
    const p = q && Number(q.price);
    return p > 0 ? round(p, 6) : 0;
  }

  /* Admin profit margin (%) for one stock. Read from the synced catalogue so
     admins can edit it in Admin → Stocks and every device sees the same value. */
  adminPct(db, ticker) {
    const s = this.stock(db, ticker);
    const n = Number(s && s.profitPct);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(MAX_PCT, round(n, 4));
  }

  /** Live Finnhub price + the admin margin applied to a purchase. */
  pricing(db, ticker) {
    const live = this.livePrice(ticker);
    const pct = this.adminPct(db, ticker);
    const exec = live > 0 ? round(live * (1 + pct / 100), 6) : 0;
    return { live, pct, exec };
  }

  holding(db, userId, ticker) {
    const t = String(ticker || '').toUpperCase();
    return (db.holdings || []).find((h) => h && h.userId === String(userId || '') && String(h.ticker).toUpperCase() === t && Number(h.shares) > 1e-9) || null;
  }

  notify(db, userId, title, body, icon) {
    db.notifications = db.notifications || [];
    db.notifications.unshift({ id: nid('nt_'), userId, title, body, link: '#/invest/orders', icon: icon || 'trend', read: false, createdAt: Date.now() });
    if (db.notifications.length > 400) db.notifications.length = 400;
  }

  tx(db, userId, label, coins, type, meta) {
    db.txs = db.txs || [];
    db.txs.unshift({ id: nid('tx_'), userId, type: type || 'spot', label, coins: round(coins, 2), meta: meta || {}, createdAt: Date.now() });
    if (db.txs.length > 2000) db.txs.length = 2000;
  }

  changed(source) {
    try { this.persist(); } catch (e) {}
    try { this.broadcast('change', { rev: null, source: source || 'spot', at: Date.now() }); } catch (e) {}
  }

  positionView(h, priceOverride) {
    const live = priceOverride != null ? Number(priceOverride) : this.livePrice(h.ticker);
    const shares = Number(h.shares) || 0;
    const entry = Number(h.avgPrice) || 0;
    const invested = Number(h.investedCoins) || round(shares * entry * COINS_PER_USD, 2);
    const valueCoins = round(shares * (live || entry) * COINS_PER_USD, 2);
    const pnlCoins = round(valueCoins - invested, 2);
    return {
      id: h.id, userId: h.userId, ticker: h.ticker,
      symbol: h.ticker, entryPrice: entry, quantity: shares, shares,
      investedCoins: invested, investedUsd: round(invested * 0.5, 2),
      livePrice: live, marketPriceUsd: live,
      valueCoins, pnlCoins, pnlPct: invested ? round((pnlCoins / invested) * 100, 2) : 0,
      takeProfitPrice: Number(h.takeProfitPrice) || 0,
      stopLossPrice: Number(h.stopLossPrice) || 0,
      adminProfitPct: Number(h.adminProfitPct) || 0,
      openedAt: h.createdAt || h.entryAt || null, updatedAt: h.updatedAt || null
    };
  }

  positions(db, userId) {
    return (db.holdings || [])
      .filter((h) => h && h.userId === String(userId || '') && Number(h.shares) > 1e-9)
      .map((h) => this.positionView(h));
  }

  /* --------------------------------- buy ---------------------------------- */
  buy(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = this.user(db, userId);
    if (!u) throw new Error('User not found');
    const ticker = String(opts.ticker || '').toUpperCase();
    const s = this.stock(db, ticker);
    if (!s) throw new Error('That stock is not listed');
    if (this.paused(db, ticker)) throw new Error(`${ticker} trading is paused by an administrator`);

    const { live, pct, exec } = this.pricing(db, ticker);
    if (!(live > 0) || !(exec > 0)) throw new Error('Waiting for a live market price — try again in a moment');

    let amountUsd = Number(opts.amountUsd);
    if (!(amountUsd > 0) && Number(opts.amountCoins) > 0) amountUsd = Number(opts.amountCoins) * 0.5;
    let shares = Number(opts.shares);
    if (!(shares > 0) && amountUsd > 0) shares = amountUsd / exec;
    if (!(shares > 0)) throw new Error('Enter an investment amount (WC) or a number of shares');
    if (!(amountUsd > 0)) amountUsd = shares * exec;

    shares = round(shares, 8);
    if (!(shares > 0)) throw new Error('Quantity is too small');
    const investedUsd = round(shares * exec, 6);
    const investedCoins = round(investedUsd * COINS_PER_USD, 2);
    if (!(investedCoins > 0)) throw new Error('Investment is too small');
    if ((Number(u.balance) || 0) + 1e-9 < investedCoins) {
      throw new Error(`Not enough WC — this purchase needs ${investedCoins.toFixed(2)} WC (you have ${round(u.balance, 2)} WC)`);
    }

    const tp = Number(opts.tpPrice) || 0;
    const sl = Number(opts.slPrice) || 0;
    if (tp > 0 && tp <= exec) throw new Error('Take Profit must be above the execution price');
    if (sl > 0 && sl >= exec) throw new Error('Stop Loss must be below the execution price');

    /* --- critical section: fully synchronous, no awaits ------------------- */
    u.balance = round((Number(u.balance) || 0) - investedCoins, 2);

    const now = Date.now();
    let h = this.holding(db, userId, ticker);
    if (h) {
      const prevShares = Number(h.shares) || 0;
      const nextShares = round(prevShares + shares, 8);
      const prevInvested = Number(h.investedCoins) || round(prevShares * (Number(h.avgPrice) || 0) * COINS_PER_USD, 2);
      h.avgPrice = round((prevShares * (Number(h.avgPrice) || 0) + investedUsd) / nextShares, 8);
      h.shares = nextShares;
      h.investedCoins = round(prevInvested + investedCoins, 2);
      h.investedUsd = round((Number(h.investedCoins) || 0) * 0.5, 2);
      h.adminProfitPct = pct;
      h.updatedAt = now;
      if (tp > 0) h.takeProfitPrice = round(tp, 6);
      if (sl > 0) h.stopLossPrice = round(sl, 6);
      h.lastBuyAt = now;
    } else {
      h = {
        id: nid('hd'), userId, ticker, name: s.name || ticker,
        shares, avgPrice: exec,
        investedCoins, investedUsd: round(investedUsd, 2),
        takeProfitPrice: tp > 0 ? round(tp, 6) : 0,
        stopLossPrice: sl > 0 ? round(sl, 6) : 0,
        adminProfitPct: pct, marketPriceUsd: live,
        kind: 'spot', status: 'open',
        createdAt: now, updatedAt: now
      };
      db.holdings.push(h);
    }

    const order = {
      id: nid('tr'), userId, ticker, name: s.name || ticker,
      side: 'buy', type: 'spot', status: 'Completed',
      shares, priceUsd: exec, marketPriceUsd: live,
      adminProfitPct: pct, coins: investedCoins, feeCoins: 0,
      takeProfitPrice: h.takeProfitPrice || 0, stopLossPrice: h.stopLossPrice || 0,
      plUsd: 0, plCoins: 0, createdAt: now
    };
    db.trades.unshift(order);
    if (db.trades.length > 3000) db.trades.length = 3000;

    this.tx(db, userId, `Bought ${shares.toFixed(6)} ${ticker} @ $${exec.toFixed(4)}`, -investedCoins, 'spot-buy', {
      orderId: order.id, ticker, shares, priceUsd: exec, marketPriceUsd: live, adminProfitPct: pct
    });
    this.notify(db, userId, 'Buy order filled',
      `${shares.toFixed(6)} ${ticker} bought at $${exec.toFixed(4)} · ${investedCoins.toFixed(2)} WC deducted from your balance.`,
      'trend');
    /* ---------------------------------------------------------------------- */

    this.changed('spot-buy');
    return { ok: true, order, position: this.positionView(h, live), balance: u.balance };
  }

  /* --------------------------------- sell --------------------------------- */
  /* reason: 'Manual sell' | 'Take Profit Hit' | 'Stop Loss Hit' */
  sell(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = this.user(db, userId);
    if (!u) throw new Error('User not found');
    const ticker = String(opts.ticker || '').toUpperCase();
    const h = this.holding(db, userId, ticker);
    if (!h) throw new Error('No open position for ' + ticker);

    const price = this.livePrice(ticker);
    if (!(price > 0)) throw new Error('Waiting for a live market price — try again in a moment');

    const requested = Number(opts.shares);
    const totalShares = Number(h.shares) || 0;
    const shares = requested > 0 && requested < totalShares - 1e-9 ? round(requested, 8) : totalShares;
    if (!(shares > 0)) throw new Error('Nothing to sell');

    const entry = Number(h.avgPrice) || 0;
    const payout = round(shares * price * COINS_PER_USD, 2);
    const costBasis = round(shares * entry * COINS_PER_USD, 2);
    const plCoins = round(payout - costBasis, 2);
    const reason = String(opts.reason || 'Manual sell');

    /* --- critical section: remove/trim the position BEFORE crediting ----- */
    const idx = db.holdings.findIndex((x) => x && x.id === h.id);
    if (idx < 0) throw new Error('That position is already closed');
    const prevHolding = Object.assign({}, h);
    const prevBalance = Number(u.balance) || 0;
    try {
      if (shares >= totalShares - 1e-9) {
        db.holdings.splice(idx, 1);
      } else {
        h.shares = round(totalShares - shares, 8);
        h.investedCoins = round((Number(h.investedCoins) || 0) * (h.shares / totalShares), 2);
        h.investedUsd = round((Number(h.investedCoins) || 0) * 0.5, 2);
        h.updatedAt = Date.now();
      }
      u.balance = round(prevBalance + payout, 2);

      const now = Date.now();
      const order = {
        id: nid('tr'), userId, ticker, name: (this.stock(db, ticker) || {}).name || ticker,
        side: 'sell', type: 'spot', status: 'Completed',
        shares, priceUsd: price, marketPriceUsd: price,
        entryPriceUsd: entry, coins: payout, feeCoins: 0,
        plUsd: round(plCoins * 0.5, 2), plCoins,
        closeReason: reason,
        openedAt: h.createdAt || null, createdAt: now, closedAt: now
      };
      db.trades.unshift(order);
      if (db.trades.length > 3000) db.trades.length = 3000;

      this.tx(db, userId, `${reason} · sold ${shares.toFixed(6)} ${ticker} @ $${price.toFixed(4)}`, payout, 'spot-sell', {
        orderId: order.id, ticker, shares, priceUsd: price, entryPriceUsd: entry, plCoins, reason
      });
      this.notify(db, userId,
        reason === 'Take Profit Hit' ? 'Take Profit Hit — position sold' : reason === 'Stop Loss Hit' ? 'Stop Loss Hit — position sold' : 'Sell order filled',
        `${shares.toFixed(6)} ${ticker} sold at $${price.toFixed(4)}. ${payout.toFixed(2)} WC credited (${plCoins >= 0 ? '+' : '−'}${Math.abs(plCoins).toFixed(2)} WC P/L).`,
        reason === 'Stop Loss Hit' ? 'down' : 'check');
      this.settledTotal += 1;
      this.changed('spot-sell');
      return { ok: true, order, payout, plCoins, balance: u.balance, reason };
    } catch (e) {
      /* roll back so a failed bookkeeping step can never lose the position */
      u.balance = prevBalance;
      if (idx >= 0 && !db.holdings.some((x) => x && x.id === prevHolding.id)) db.holdings.splice(idx, 0, prevHolding);
      throw e;
    }
    /* ---------------------------------------------------------------------- */
  }

  /* ------------------------------- TP / SL -------------------------------- */
  setTargets(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const ticker = String(opts.ticker || '').toUpperCase();
    const h = this.holding(db, userId, ticker);
    if (!h) throw new Error('No open position for ' + ticker);
    const tp = Number(opts.tpPrice) || 0;
    const sl = Number(opts.slPrice) || 0;
    const entry = Number(h.avgPrice) || 0;
    if (tp > 0 && tp <= entry) throw new Error('Take Profit must be above the entry price');
    if (sl > 0 && sl >= entry) throw new Error('Stop Loss must be below the entry price');
    h.takeProfitPrice = tp > 0 ? round(tp, 6) : 0;
    h.stopLossPrice = sl > 0 ? round(sl, 6) : 0;
    h.updatedAt = Date.now();
    this.changed('spot-targets');
    return { ok: true, position: this.positionView(h) };
  }

  /* ------------------------------- admin ---------------------------------- */
  setAdminProfitPct(db, ticker, pct) {
    const s = this.stock(db, ticker);
    if (!s) throw new Error('Stock not found');
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > MAX_PCT) throw new Error(`Profit margin must be between 0 and ${MAX_PCT}%`);
    s.profitPct = round(n, 4);
    s.updatedAt = Date.now();
    this.changed('spot-admin-pct');
    return { ok: true, ticker: s.ticker, profitPct: s.profitPct };
  }

  /* ------------------------------ worker ---------------------------------- */
  settle() {
    if (this.busy) return 0;
    const db = this.getDb && this.getDb();
    if (!db || !Array.isArray(db.holdings) || !db.holdings.length) return 0;
    this.busy = true;
    this.lastTickAt = Date.now();
    let closed = 0;
    try {
      /* snapshot ids only: the critical sections below re-read current state */
      const candidates = (db.holdings || [])
        .filter((h) => h && (Number(h.takeProfitPrice) > 0 || Number(h.stopLossPrice) > 0))
        .map((h) => ({ userId: h.userId, ticker: h.ticker, tp: Number(h.takeProfitPrice) || 0, sl: Number(h.stopLossPrice) || 0 }));
      for (const c of candidates) {
        const price = this.livePrice(c.ticker);
        if (!(price > 0)) continue;
        /* skip if the position disappeared (manual sell won the race) */
        if (!this.holding(db, c.userId, c.ticker)) continue;
        let reason = '';
        if (c.tp > 0 && price >= c.tp) reason = 'Take Profit Hit';
        else if (c.sl > 0 && price <= c.sl) reason = 'Stop Loss Hit';
        if (!reason) continue;
        try {
          this.sell({ userId: c.userId, ticker: c.ticker, reason });
          closed += 1;
          console.log(`[spot] ${reason} · ${c.ticker} · user ${c.userId} · live $${price}`);
        } catch (e) {
          /* already closed by another path — never retried, never double-paid */
          if (!/No open position|already closed/.test(e.message)) this.lastError = e.message;
        }
      }
    } finally {
      this.busy = false;
    }
    return closed;
  }

  startTimers() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      try { this.settle(); } catch (e) { this.lastError = e.message; console.error('[spot] settle failed:', e.message); }
    }, 1000);
    if (this.timer.unref) this.timer.unref();
    console.log('[spot] TP/SL worker started (1s scan)');
  }

  stopTimers() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    const db = this.getDb && this.getDb();
    return {
      running: this.running,
      openPositions: db ? (db.holdings || []).filter((h) => h && Number(h.shares) > 1e-9).length : 0,
      settled: this.settledTotal,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError
    };
  }
}

module.exports = { SpotService, COINS_PER_USD, MAX_PCT };
