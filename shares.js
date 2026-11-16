'use strict';
/* =========================================================================
   WhaleChat Shares — company share investment plans
   - admin-defined plans: min/max investment, duration, % return
   - users buy shares at the live simulated WhaleChat share price
   - earnings accrue in real time and mature automatically (server-side, so
     plans keep earning while the app is closed)
   - one simulated share price feed powers the movement chart for every user
   ========================================================================= */

const crypto = require('crypto');

const COINS_PER_USD = 2;                 // 1 WC = $0.50
const BASE_SHARE_PRICE = 12.5;           // USD per WhaleChat share
const DAY = 86400000;

const DEFAULT_PLANS = [
  { id: 'starter', name: 'Whale Starter', minUsd: 10, maxUsd: 500, durationValue: 30, durationUnit: 'days', returnPct: 8, enabled: true, sort: 1, blurb: 'Short 30-day plan for first-time shareholders.' },
  { id: 'growth', name: 'Whale Growth', minUsd: 50, maxUsd: 2500, durationValue: 3, durationUnit: 'months', returnPct: 22, enabled: true, sort: 2, blurb: 'Quarterly plan with a balanced fixed return.' },
  { id: 'elite', name: 'Whale Elite', minUsd: 250, maxUsd: 25000, durationValue: 6, durationUnit: 'months', returnPct: 45, enabled: true, sort: 3, blurb: 'Long-horizon allocation for larger portfolios.' }
];

const round = (v, n) => Math.round((Number(v) || 0) * Math.pow(10, n)) / Math.pow(10, n);
function nid(prefix) { return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
function clamp(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }

function durationMs(value, unit) {
  const v = Math.max(1, Math.round(Number(value) || 1));
  if (unit === 'years') return v * 365 * DAY;
  if (unit === 'months') return v * 30 * DAY;
  return v * DAY;
}

function durationLabel(value, unit) {
  const v = Math.max(1, Math.round(Number(value) || 1));
  const u = unit === 'years' ? 'year' : unit === 'months' ? 'month' : 'day';
  return v + ' ' + u + (v === 1 ? '' : 's');
}

class ShareService {
  constructor(opts) {
    this.getDb = opts.getDb;
    this.persist = opts.persist || (() => {});
    this.broadcast = opts.broadcast || (() => {});
    this.timer = null;
    this.running = false;
    this.lastPersistAt = 0;
    this.lastError = '';
  }

  ensureDefaults(db) {
    if (!db) return false;
    let changed = false;
    /* seed the example plans once, then let admins freely edit or remove them */
    if (!Array.isArray(db.sharePlans)) {
      db.sharePlans = DEFAULT_PLANS.map((p) => Object.assign({}, p));
      db.sharePlanSeeded = true;
      changed = true;
    } else if (!db.sharePlans.length && !db.sharePlanSeeded) {
      db.sharePlans = DEFAULT_PLANS.map((p) => Object.assign({}, p));
      db.sharePlanSeeded = true;
      changed = true;
    }
    if (!Array.isArray(db.shareInvestments)) { db.shareInvestments = []; changed = true; }
    if (!db.shareMarket || typeof db.shareMarket !== 'object') {
      db.shareMarket = { priceUsd: BASE_SHARE_PRICE, basePriceUsd: BASE_SHARE_PRICE, history: [], updatedAt: Date.now() };
      changed = true;
    }
    if (!Array.isArray(db.shareMarket.history) || !db.shareMarket.history.length) {
      db.shareMarket.basePriceUsd = Number(db.shareMarket.basePriceUsd) || BASE_SHARE_PRICE;
      db.shareMarket.priceUsd = Number(db.shareMarket.priceUsd) || BASE_SHARE_PRICE;
      db.shareMarket.history = [{ t: Date.now() - 3600000, p: round(db.shareMarket.priceUsd, 4) }];
      changed = true;
    }
    return changed;
  }

  plans() {
    const db = this.getDb && this.getDb();
    if (!db) return DEFAULT_PLANS.slice();
    this.ensureDefaults(db);
    return db.sharePlans.slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
  }

  plan(id) { return this.plans().find((p) => p && p.id === id) || null; }

  market() {
    const db = this.getDb && this.getDb();
    if (!db) return { priceUsd: BASE_SHARE_PRICE, history: [] };
    this.ensureDefaults(db);
    return db.shareMarket;
  }

  sharePrice() {
    const m = this.market();
    const p = Number(m.priceUsd);
    return p > 0 ? p : BASE_SHARE_PRICE;
  }

  notify(db, userId, title, body, icon) {
    db.notifications = db.notifications || [];
    db.notifications.unshift({ id: nid('nt_'), userId, title, body, link: '#/invest/shares', icon: icon || 'trend', read: false, createdAt: Date.now() });
    if (db.notifications.length > 400) db.notifications.length = 400;
  }

  tx(db, userId, label, coins, type, meta) {
    db.txs = db.txs || [];
    db.txs.unshift({ id: nid('tx_'), userId, type: type || 'shares', label, coins: round(coins, 2), meta: meta || {}, createdAt: Date.now() });
    if (db.txs.length > 2000) db.txs.length = 2000;
  }

  changed(source) {
    try { this.persist(); } catch (e) {}
    try { this.broadcast('change', { rev: null, source: source || 'shares', at: Date.now() }); } catch (e) {}
  }

  /* --------------------------------- views --------------------------------- */
  /* Market-linked payout: the admin plan % is the participation rate applied to
     the WhaleChat share price move since the user bought in.
       marketReturn = (priceNow - entryPrice) / entryPrice
       roi          = planPct/100 × marketReturn
       profit       = capital × roi            (negative when the price falls) */
  planPnl(inv, price) {
    const amount = Number(inv.amountCoins) || 0;
    const entry = Number(inv.entryPriceUsd) || 0;
    const rate = (Number(inv.returnPct) || 0) / 100;
    const px = Number(price) || entry;
    const marketReturn = entry > 0 ? (px - entry) / entry : 0;
    return { marketReturn, roi: rate * marketReturn, profit: round(amount * rate * marketReturn, 6) };
  }

  investmentView(inv) {
    const now = Date.now();
    const start = Number(inv.startAt) || now;
    const end = Number(inv.endAt) || now;
    const amount = Number(inv.amountCoins) || 0;
    const duration = Math.max(1, end - start);
    const elapsed = Math.max(0, Math.min(duration, now - start));
    const matured = inv.status === 'completed' || now >= end;
    const priceNow = this.sharePrice();
    const pnl = this.planPnl(inv, priceNow);
    const profitCoins = round(inv.status === 'completed' ? (Number(inv.profitCoins) || 0) : pnl.profit, 6);
    const accrued = profitCoins;
    const progress = inv.status === 'completed' ? 100 : Math.min(100, (elapsed / duration) * 100);
    const shares = Number(inv.shares) || (Number(inv.amountUsd) || 0) / (Number(inv.entryPriceUsd) || priceNow);
    const planPct = Number(inv.returnPct) || 0;
    return {
      id: inv.id, planId: inv.planId, planName: inv.planName,
      amountUsd: round(inv.amountUsd, 2), amountCoins: round(amount, 2),
      returnPct: planPct, planPct,
      status: inv.status, startAt: start, endAt: end,
      durationLabel: inv.durationLabel || '',
      entryPriceUsd: round(inv.entryPriceUsd, 4),
      marketPriceUsd: round(priceNow, 4),
      marketReturnPct: round(pnl.marketReturn * 100, 4),
      planRoiPct: round(pnl.roi * 100, 6),
      shares: round(shares, 6),
      accruedCoins: round(accrued, 6), accruedUsd: round(accrued * 0.5, 4),
      targetProfitCoins: round(amount * (planPct / 100) * Math.max(0, pnl.marketReturn), 6),
      targetProfitUsd: round(amount * (planPct / 100) * Math.max(0, pnl.marketReturn) * 0.5, 2),
      currentValueCoins: round(Math.max(0, amount + accrued), 2),
      currentValueUsd: round(Math.max(0, amount + accrued) * 0.5, 2),
      progressPct: round(progress, 2),
      payoutTodayCoins: round(Math.max(0, amount + accrued), 2),
      payoutTodayUsd: round(Math.max(0, amount + accrued) * 0.5, 2),
      cumulativeRoiPct: round(pnl.roi * 100, 4),
      daily: (() => {
        const rate = planPct / 100;
        const from = new Date(start).toISOString().slice(0, 10);
        return (this.market().daily || []).filter((d) => d && d.d >= from).slice(-90).map((d) => {
          const turn = Number(d.open) > 0 ? (Number(d.close) - Number(d.open)) / Number(d.open) : 0;
          return {
            d: d.d, open: round(Number(d.open), 4), close: round(Number(d.close), 4),
            turnPct: round(turn * 100, 4), roiPct: round(rate * turn * 100, 6),
            profitCoins: round(amount * rate * turn, 6)
          };
        });
      })(),
      remainingMs: inv.status === 'completed' ? 0 : Math.max(0, end - now),
      completedAt: inv.completedAt || null,
      equityHistory: Array.isArray(inv.equityHistory) ? inv.equityHistory.slice(-120) : [],
      matured, wcRate: 0.5
    };
  }

  publicState(userId) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw new Error('User not found');
    this.ensureDefaults(db);
    const all = (db.shareInvestments || []).filter((x) => x && x.userId === userId);
    const active = all.filter((x) => x.status === 'active');
    const completed = all.filter((x) => x.status === 'completed').sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)).slice(0, 20);
    const views = active.map((x) => this.investmentView(x)).sort((a, b) => b.startAt - a.startAt);
    const accrued = views.reduce((a, v) => a + v.accruedCoins, 0);
    const invested = views.reduce((a, v) => a + v.amountCoins, 0);
    const shares = views.reduce((a, v) => a + v.shares, 0);
    const target = views.reduce((a, v) => a + Math.max(0, v.accruedCoins), 0);
    const completedProfit = completed.reduce((a, v) => a + (Number(v.profitCoins) || 0), 0);
    const market = this.market();
    return {
      ok: true,
      balance: round(u.balance, 2),
      coinsPerUsd: COINS_PER_USD,
      plans: this.plans().filter((p) => p.enabled !== false).map((p) => Object.assign({}, p, {
        durationLabel: durationLabel(p.durationValue, p.durationUnit),
        minCoins: round(p.minUsd * COINS_PER_USD, 2),
        maxCoins: round(p.maxUsd * COINS_PER_USD, 2)
      })),
      investments: views,
      completed: completed.map((x) => this.investmentView(x)),
      summary: {
        activeCount: views.length,
        investedCoins: round(invested, 2), investedUsd: round(invested * 0.5, 2),
        accruedCoins: round(accrued, 6), accruedUsd: round(accrued * 0.5, 4),
        targetProfitCoins: round(target, 6), targetProfitUsd: round(target * 0.5, 2),
        completedProfitCoins: round(completedProfit, 2), completedProfitUsd: round(completedProfit * 0.5, 2),
        totalEarnedCoins: round(accrued + completedProfit, 6), totalEarnedUsd: round((accrued + completedProfit) * 0.5, 4),
        shares: round(shares, 6),
        sharePriceUsd: round(this.sharePrice(), 4), sharePriceCoins: round(this.sharePrice() * COINS_PER_USD, 2)
      },
      shareMarket: {
        priceUsd: round(this.sharePrice(), 4),
        priceCoins: round(this.sharePrice() * COINS_PER_USD, 2),
        dailyChangePct: round(Number(market.dailyChangePct) || 0, 4),
        dayOpenUsd: round(Number(market.day && market.day.open) || 0, 4),
        daily: (market.daily || []).slice(-120),
        updatedAt: market.updatedAt || Date.now(),
        history: (market.history || []).slice(-240)
      },
      serverTime: Date.now()
    };
  }

  /* --------------------------------- invest -------------------------------- */
  invest(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw new Error('User not found');
    const plan = this.plan(String(opts.planId || ''));
    if (!plan || plan.enabled === false) throw new Error('That investment plan is not available');

    let amountUsd = Number(opts.amountUsd);
    if (!(amountUsd > 0) && Number(opts.amountCoins) > 0) amountUsd = Number(opts.amountCoins) * 0.5;
    amountUsd = round(amountUsd, 2);
    if (!(amountUsd > 0)) throw new Error('Enter the amount you want to invest');
    if (amountUsd < Number(plan.minUsd)) throw new Error('Minimum investment for this plan is $' + Number(plan.minUsd).toFixed(2) + ' (' + round(Number(plan.minUsd) * 2, 2) + ' WC)');
    if (amountUsd > Number(plan.maxUsd)) throw new Error('Maximum investment for this plan is $' + Number(plan.maxUsd).toFixed(2) + ' (' + round(Number(plan.maxUsd) * 2, 2) + ' WC)');

    const costCoins = round(amountUsd * COINS_PER_USD, 2);
    if ((Number(u.balance) || 0) < costCoins) throw new Error(`Not enough WC — you need ${costCoins.toFixed(2)} WC ($${amountUsd.toFixed(2)})`);

    const now = Date.now();
    const ms = durationMs(plan.durationValue, plan.durationUnit);
    const price = this.sharePrice();
    u.balance = round(Number(u.balance) - costCoins, 2);

    const inv = {
      id: nid('shi_'), userId, planId: plan.id, planName: plan.name,
      amountUsd, amountCoins: costCoins,
      returnPct: Number(plan.returnPct) || 0,
      durationLabel: durationLabel(plan.durationValue, plan.durationUnit),
      entryPriceUsd: round(price, 4), shares: round(amountUsd / price, 6),
      startAt: now, endAt: now + ms, status: 'active',
      profitCoins: 0, lastAccrualAt: now,
      equityHistory: [{ t: now, coins: costCoins }],
      createdAt: now
    };
    db.shareInvestments.unshift(inv);

    this.tx(db, userId, `Bought ${inv.shares} WhaleChat shares · ${plan.name} ($${amountUsd.toFixed(2)})`, -costCoins, 'share-invest', {
      planId: plan.id, amountUsd, amountCoins: costCoins, returnPct: inv.returnPct, shares: inv.shares, entryPriceUsd: inv.entryPriceUsd, endAt: inv.endAt
    });
    this.notify(db, userId, 'WhaleChat shares purchased', `${inv.shares} shares at $${inv.entryPriceUsd.toFixed(2)} · ${plan.name} matures ${new Date(inv.endAt).toLocaleDateString()} with ${inv.returnPct}% market participation.`, 'trend');
    this.changed('share-invest');
    return { ok: true, investment: this.investmentView(inv), balance: u.balance, shares: inv.shares, entryPriceUsd: inv.entryPriceUsd };
  }

  /* ---------------------------------- admin -------------------------------- */
  adminState() {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    this.ensureDefaults(db);
    const invs = db.shareInvestments || [];
    const active = invs.filter((x) => x.status === 'active');
    return {
      ok: true,
      plans: this.plans(),
      market: {
        priceUsd: round(this.sharePrice(), 4), priceCoins: round(this.sharePrice() * 2, 2),
        dailyChangePct: round(Number(this.market().dailyChangePct) || 0, 4),
        daily: (this.market().daily || []).slice(-120),
        updatedAt: this.market().updatedAt
      },
      units: ['days', 'months', 'years'],
      stats: {
        plans: this.plans().length,
        active: active.length,
        shareholders: new Set(invs.map((x) => x.userId)).size,
        investedCoins: round(invs.reduce((a, x) => a + (Number(x.amountCoins) || 0), 0), 2),
        reservedCoins: round(active.reduce((a, x) => a + (Number(x.amountCoins) || 0), 0), 2),
        completed: invs.filter((x) => x.status === 'completed').length
      }
    };
  }

  savePlans(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    this.ensureDefaults(db);
    if (!Array.isArray(opts.plans)) throw new Error('plans array required');
    if (opts.plans.length > 30) throw new Error('Too many plans (max 30)');
    const seen = new Set();
    const saved = [];
    let sort = 0;
    for (const raw of opts.plans) {
      sort += 1;
      const name = String(raw.name || '').trim().slice(0, 60);
      if (!name) continue;
      const minUsd = clamp(raw.minUsd, 0.01, 100000000, 10);
      const maxUsd = Math.max(minUsd, clamp(raw.maxUsd, minUsd, 100000000, 1000));
      const unit = ['days', 'months', 'years'].includes(raw.durationUnit) ? raw.durationUnit : 'days';
      const id = String(raw.id || '').trim() || nid('shp_');
      if (seen.has(id)) continue;
      seen.add(id);
      const existing = (db.sharePlans || []).find((p) => p && p.id === id);
      const plan = existing || { id, createdAt: Date.now() };
      Object.assign(plan, {
        name, minUsd: round(minUsd, 2), maxUsd: round(maxUsd, 2),
        durationValue: clamp(raw.durationValue, 1, 3650, 30),
        durationUnit: unit,
        returnPct: clamp(raw.returnPct, 0, 1000, 10),
        enabled: raw.enabled !== false,
        sort,
        blurb: String(raw.blurb || plan.blurb || '').slice(0, 160)
      });
      saved.push(plan);
    }
    if (!saved.length) throw new Error('Add at least one plan');
    db.sharePlans = saved;
    this.changed('share-plans');
    return this.adminState();
  }

  /* --------------------------------- worker -------------------------------- */
  tick() {
    const db = this.getDb && this.getDb();
    if (!db || !Array.isArray(db.users)) return 0;
    this.ensureDefaults(db);
    const now = Date.now();
    const market = db.shareMarket;
    const base = Number(market.basePriceUsd) || BASE_SHARE_PRICE;
    let price = Number(market.priceUsd) || base;
    /* small random walk with gentle mean reversion around the base price */
    const noise = (Math.random() - 0.5) * 0.006;
    const drift = (base - price) / base * 0.004;
    price = Math.max(1, price * (1 + noise + drift));
    market.priceUsd = round(price, 4);
    market.updatedAt = now;
    const dayKey = new Date(now).toISOString().slice(0, 10);
    market.day = market.day || { date: dayKey, open: market.priceUsd };
    if (market.day.date !== dayKey) market.day = { date: dayKey, open: market.priceUsd };
    market.dailyChangePct = market.day.open > 0 ? round(((market.priceUsd - market.day.open) / market.day.open) * 100, 4) : 0;
    /* durable daily ledger: open / high / low / close for the admin turn-up table */
    market.daily = market.daily || [];
    let dayRow = market.daily[market.daily.length - 1];
    if (!dayRow || dayRow.d !== dayKey) {
      dayRow = { d: dayKey, open: market.priceUsd, high: market.priceUsd, low: market.priceUsd, close: market.priceUsd };
      market.daily.push(dayRow);
      if (market.daily.length > 400) market.daily.splice(0, market.daily.length - 400);
    } else {
      dayRow.close = market.priceUsd;
      dayRow.high = Math.max(Number(dayRow.high) || market.priceUsd, market.priceUsd);
      dayRow.low = Math.min(Number(dayRow.low) || market.priceUsd, market.priceUsd);
    }
    market.history = market.history || [];
    const lastPt = market.history[market.history.length - 1];
    if (!lastPt || now - (Number(lastPt.t) || 0) >= 4500) {
      market.history.push({ t: now, p: market.priceUsd });
      if (market.history.length > 720) market.history.splice(0, market.history.length - 720);
    }

    let changed = false;
    for (const inv of (db.shareInvestments || []).slice()) {
      if (!inv || inv.status !== 'active') continue;
      const end = Number(inv.endAt) || 0;
      const amount = Number(inv.amountCoins) || 0;
      if (end && now >= end) {
        this.complete(db, inv, null);
        changed = true;
        continue;
      }
      const pnl = this.planPnl(inv, price);
      const accrued = round(pnl.profit, 6);
      inv.profitCoins = accrued;
      inv.marketReturnPct = round(pnl.marketReturn * 100, 4);
      inv.planRoiPct = round(pnl.roi * 100, 6);
      if (now - (Number(inv.lastAccrualAt) || 0) >= 30000) {
        inv.lastAccrualAt = now;
        inv.equityHistory = inv.equityHistory || [];
        const lastE = inv.equityHistory[inv.equityHistory.length - 1];
        if (!lastE || now - Number(lastE.t) >= 25000) {
          inv.equityHistory.push({ t: now, coins: round(amount + accrued, 2) });
          if (inv.equityHistory.length > 240) inv.equityHistory.splice(0, inv.equityHistory.length - 240);
        }
        changed = true;
      }
    }
    if (changed || now - this.lastPersistAt > 60000) { this.lastPersistAt = now; this.changed('share-tick'); }
    return changed ? 1 : 0;
  }

  complete(db, inv, targetProfit) {
    const u = (db.users || []).find((x) => x.id === inv.userId);
    if (!u) return;
    const now = Date.now();
    const pnl = this.planPnl(inv, this.sharePrice());
    const profit = round(targetProfit != null ? targetProfit : pnl.profit, 2);
    const payout = round(Math.max(0, (Number(inv.amountCoins) || 0) + profit), 2);
    inv.status = 'completed';
    inv.completedAt = now;
    inv.profitCoins = profit;
    inv.payoutCoins = payout;
    inv.endAt = Math.min(Number(inv.endAt) || now, now);
    inv.equityHistory = inv.equityHistory || [];
    inv.equityHistory.push({ t: now, coins: payout });
    if (inv.equityHistory.length > 240) inv.equityHistory.splice(0, inv.equityHistory.length - 240);
    u.balance = round((Number(u.balance) || 0) + payout, 2);
    this.tx(db, inv.userId, `WhaleChat shares matured · ${inv.planName}`, payout, 'share-maturity', {
      investmentId: inv.id, principalCoins: inv.amountCoins, profitCoins: profit, payoutCoins: payout,
      returnPct: inv.returnPct, marketReturnPct: round(pnl.marketReturn * 100, 4), entryPriceUsd: inv.entryPriceUsd
    });
    this.notify(db, inv.userId, 'Investment matured', `Your ${inv.planName} plan paid out ${payout.toFixed(2)} WC ($${(payout * 0.5).toFixed(2)}) — ${profit.toFixed(2)} WC profit credited.`, 'check');
  }

  startTimers() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { this.lastError = e.message; console.error('[shares] tick failed:', e.message); }
    }, 5000);
    if (this.timer.unref) this.timer.unref();
    setTimeout(() => { try { this.tick(); } catch (e) {} }, 2000);
    console.log('[shares] WhaleChat share price + investment worker started');
  }

  stopTimers() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { ShareService, DEFAULT_PLANS, BASE_SHARE_PRICE, COINS_PER_USD, durationMs, durationLabel };
