'use strict';
/* =========================================================================
   WhaleChat trading bot assistant
   - four subscription tiers with admin-editable price / billing cycle
   - reserved (locked) trading capital per user
   - fully server-side simulation so bots keep trading while users are offline
   - automatic stop when capital is exhausted, subscription expires, or the
     user stops the bot (remaining capital is merged back into the wallet)
   The bot never touches funds outside its reserved pool and never runs when
   the user has no live subscription.
   ========================================================================= */

const crypto = require('crypto');

const COINS_PER_USD = 2;                    // 1 WC = $0.50

function invAcct(u) {
  if (!u) return null;
  if (!u.investAcct) u.investAcct = { usd: 0, payout: 0, wcBalance: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 }, stockProfit: 0 };
  const a = u.investAcct;
  if (!a.portfolios) a.portfolios = { stock: 0, wc: 0, b2b: 0, bot: 0 };
  return a;
}
function pf(u, key) { const a = invAcct(u); return round(Number(a && a.portfolios && a.portfolios[key]) || 0, 2); }
function setPf(u, key, v) { const a = invAcct(u); a.portfolios[key] = round(Number(v) || 0, 2); return a.portfolios[key]; }
const CYCLE_MS = { daily: 86400000, weekly: 604800000, monthly: 2592000000, yearly: 31536000000, one_time: null };
const CYCLE_LABEL = { daily: '24 hrs', weekly: 'week', monthly: 'month', yearly: 'year', one_time: 'one-time' };
const DURATIONS = ['daily', 'weekly', 'monthly', 'yearly'];
/* default price multipliers vs the monthly price; admin can override every duration per bot */
const DURATION_FACTOR = { daily: 0.1, weekly: 0.35, monthly: 1, yearly: 10 };

const DEFAULT_TIERS = [
  { id: 'low', name: 'Low-Level Grade Bot', accuracy: 45, priceUsd: 20, billingCycle: 'monthly', intervalMin: 0, enabled: true, sort: 1, blurb: 'Steady starter automation for small allocations.' },
  { id: 'medium', name: 'Medium-Level Grade Bot', accuracy: 50, priceUsd: 50, billingCycle: 'monthly', intervalMin: 0, enabled: true, sort: 2, blurb: 'Balanced risk with more frequent simulated entries.' },
  { id: 'premium', name: 'Premium-Level Grade Bot', accuracy: 70, priceUsd: 120, billingCycle: 'monthly', intervalMin: 0, enabled: true, sort: 3, blurb: 'Higher hit-rate for users scaling their capital.' },
  { id: 'high', name: 'High-Performance Bot', accuracy: 85, priceUsd: 250, billingCycle: 'monthly', intervalMin: 0, enabled: true, sort: 4, blurb: 'Top tier accuracy for serious allocations.' }
];

const DEFAULT_SETTINGS = {
  intervalMin: 5,          // how often the bot places a trade while offline
  minCapitalCoins: 5,      // smallest allocation allowed
  minPoolPct: 10,          // auto-stop when remaining pool <= this % of allocation
  stakePct: 20,            // % of the pool used per simulated trade
  winPct: 4,               // % gain on the stake when the trade wins
  lossPct: 6,              // % loss on the stake when the trade loses
  leverage: 5,             // profit = stake × price move % × leverage
  tradeFeePct: 0.5,        // payout = stake + profit − (stake × fee %)
  currency: 'WC',
  autoSecurePriceUsd: 20,
  autoSecureCycle: 'monthly'
};

const round = (v, n) => Math.round(Number(v || 0) * Math.pow(10, n)) / Math.pow(10, n);
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
function nid(prefix) { return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

class BotService {
  constructor(opts) {
    this.getDb = opts.getDb;
    this.persist = opts.persist || (() => {});
    this.broadcast = opts.broadcast || (() => {});
    this.getQuote = opts.getQuote || (() => null);
    this.market = opts.market || null;
    this.timer = null;
    this.running = false;
    this.lastError = '';
    this.lastTickAt = 0;
  }

  /* --------------------------- defaults / helpers --------------------------- */
  ensureDefaults(db) {
    if (!db) return false;
    let changed = false;
    if (!Array.isArray(db.botTiers) || !db.botTiers.length) {
      db.botTiers = DEFAULT_TIERS.map((t) => Object.assign({}, t));
      changed = true;
    } else {
      /* keep the catalogue complete if a new tier is introduced later */
      for (const def of DEFAULT_TIERS) {
        if (!db.botTiers.some((t) => t && t.id === def.id)) {
          db.botTiers.push(Object.assign({}, def));
          changed = true;
        }
      }
    }
    db.botSettings = Object.assign({}, DEFAULT_SETTINGS, db.botSettings || {});
    if (!Array.isArray(db.botSubscriptions)) { db.botSubscriptions = []; changed = true; }
    if (!Array.isArray(db.botSessions)) { db.botSessions = []; changed = true; }
    if (!Array.isArray(db.autoSecureSubs)) { db.autoSecureSubs = []; changed = true; }
    if (!Array.isArray(db.botAccounts)) { db.botAccounts = []; changed = true; }
    if (!Array.isArray(db.botEvents)) { db.botEvents = []; changed = true; }
    return changed;
  }

  settings() {
    const db = this.getDb && this.getDb();
    if (!db) return Object.assign({}, DEFAULT_SETTINGS);
    this.ensureDefaults(db);
    return db.botSettings;
  }

  tiers() {
    const db = this.getDb && this.getDb();
    if (!db) return DEFAULT_TIERS.slice();
    this.ensureDefaults(db);
    return db.botTiers.slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
  }

  tier(id) { return this.tiers().find((t) => t && t.id === id) || null; }

  cycleMs(cycle) { return Object.prototype.hasOwnProperty.call(CYCLE_MS, cycle) ? CYCLE_MS[cycle] : CYCLE_MS.monthly; }

  priceCoins(tier) { return round((Number(tier.priceUsd) || 0) * COINS_PER_USD, 2); }

  /* price of one bot for each duration (24 hrs / weekly / monthly / yearly) */
  tierPrices(tier) {
    const own = (tier && tier.prices && typeof tier.prices === 'object') ? tier.prices : {};
    const base = Number(tier && tier.priceUsd) || 0;
    const f = DURATION_FACTOR[tier && tier.billingCycle];
    const monthly = f ? base / f : base;
    const out = {};
    for (const d of DURATIONS) {
      const v = Number(own[d]);
      out[d] = (own[d] != null && own[d] !== '' && Number.isFinite(v) && v >= 0) ? round(v, 2) : round(monthly * DURATION_FACTOR[d], 2);
    }
    return out;
  }

  priceFor(tier, cycle) {
    const p = this.tierPrices(tier);
    return Object.prototype.hasOwnProperty.call(p, cycle) ? p[cycle] : (Number(tier.priceUsd) || 0);
  }

  /* Bot Assisted Trading is a one-time unlock that opens the bot marketplace */
  hasBotAccess(u) {
    const t = invAcct(u).tools;
    const r = t && t.botassist;
    return !!(r && r.active);
  }

  /* renew an expired bot subscription from the user's investment trade capital */
  tryAutoRenew(db, s, now) {
    if (s.autoRenew === false) return false;
    const tier = this.tier(s.tierId);
    if (!tier || tier.enabled === false) return false;
    const ms = this.cycleMs(s.billingCycle);
    if (!ms) return false;
    const u = (db.users || []).find((x) => x.id === s.userId);
    if (!u) return false;
    const ia = invAcct(u);
    const hasOverride = s.priceOverride != null && Number.isFinite(Number(s.priceOverride)) && Number(s.priceOverride) >= 0;
    const price = hasOverride ? round(Number(s.priceOverride), 2) : this.priceFor(tier, s.billingCycle);
    if (!(price >= 0) || (Number(ia.usd) || 0) < price) return false;
    ia.usd = round((Number(ia.usd) || 0) - price, 2);
    const coins = round(price * COINS_PER_USD, 2);
    s.expiresAt = now + ms;
    s.renewedAt = now;
    s.priceUsd = price;
    s.priceCoins = coins;
    this.tx(db, s.userId, `Auto-renewed ${tier.name} · $${price.toFixed(2)} / ${CYCLE_LABEL[s.billingCycle] || s.billingCycle}`, -coins, 'bot-subscription', {
      tierId: tier.id, billingCycle: s.billingCycle, priceUsd: price, expiresAt: s.expiresAt, renewal: true
    });
    this.notify(db, s.userId, 'Bot renewed', `${tier.name} was renewed for $${price.toFixed(2)} from your investment trade capital. Next renewal ${new Date(s.expiresAt).toLocaleString()}.`, 'star');
    this.changed('bot-renew');
    return true;
  }

  activeSubs(db, userId) {
    const now = Date.now();
    return (db.botSubscriptions || []).filter((s) => s && s.userId === userId && s.status === 'active' && (!s.expiresAt || s.expiresAt > now));
  }

  subFor(db, userId, tierId) {
    return this.activeSubs(db, userId).find((s) => s.tierId === tierId) || null;
  }

  sessionFor(db, userId) {
    return (db.botSessions || []).find((s) => s && s.userId === userId && ['running', 'paused', 'cooling'].includes(s.status)) || null;
  }

  accountFor(db, userId) {
    if (!Array.isArray(db.botAccounts)) db.botAccounts = [];
    let a = db.botAccounts.find((x) => x && x.userId === userId);
    if (!a) {
      a = { userId, capitalCoins: 0, profitCoins: 0, totalPayoutCoins: 0, createdAt: Date.now() };
      db.botAccounts.push(a);
    }
    return a;
  }

  event(db, userId, type, label, amountCoins, meta) {
    if (!Array.isArray(db.botEvents)) db.botEvents = [];
    db.botEvents.unshift({
      id: nid('be_'), userId, type: String(type || 'event'), label: String(label || '').slice(0, 160),
      amountCoins: round(amountCoins || 0, 2), meta: meta || {}, at: Date.now()
    });
    if (db.botEvents.length > 800) db.botEvents.length = 800;
  }

  notify(db, userId, title, body, icon) {
    db.notifications = db.notifications || [];
    db.notifications.unshift({
      id: nid('nt_'), userId, title, body, link: '#/invest/bots', icon: icon || 'trend', read: false, createdAt: Date.now()
    });
    if (db.notifications.length > 400) db.notifications.length = 400;
  }

  tx(db, userId, label, coins, type, meta) {
    db.txs = db.txs || [];
    db.txs.unshift({
      id: nid('tx_'), userId, type: type || 'bot', label, coins: round(coins, 2),
      meta: meta || {}, createdAt: Date.now()
    });
    if (db.txs.length > 2000) db.txs.length = 2000;
  }

  changed(source) {
    try { this.persist(); } catch (e) {}
    try { this.broadcast('change', { rev: null, source: source || 'bot', at: Date.now() }); } catch (e) {}
  }

  /* --------------------------- auto-secure bot tool ------------------------- */
  autoSecureSub(db, userId) {
    const now = Date.now();
    return (db.autoSecureSubs || []).find((s) => s && s.userId === userId && s.status === 'active' && (!s.expiresAt || Number(s.expiresAt) > now)) || null;
  }

  autoSecureView(db, userId) {
    const sub = this.autoSecureSub(db, userId);
    const priceUsd = Number(this.settings().autoSecurePriceUsd) || 20;
    let count = 0;
    let coins = 0;
    (db.trades || []).forEach((t) => {
      if (!t || t.userId !== userId) return;
      (t.securedProfits || []).forEach((p) => {
        if (!p || p.claimed) return;
        count += 1;
        coins = round(coins + (Number(p.coins) || 0), 2);
      });
    });
    return {
      active: !!sub,
      enabled: !!(sub && sub.enabled !== false),
      status: sub ? sub.status : 'inactive',
      startedAt: sub ? sub.startedAt : null,
      expiresAt: sub ? (sub.expiresAt || null) : null,
      priceUsd,
      priceCoins: round(priceUsd * COINS_PER_USD, 2),
      billedAs: this.settings().autoSecureCycle || 'monthly',
      securedCount: count,
      securedCoins: coins
    };
  }

  /* Runs every second so profit is secured as soon as it appears. */
  autoSecureSweep() {
    const db = this.getDb && this.getDb();
    if (!db || !Array.isArray(db.trades)) return 0;
    if (!this.market || typeof this.market.secureProfitTrade !== 'function') return 0;
    let changed = 0;
    for (const t of db.trades.slice()) {
      if (!t || t.type !== 'live' || t.status !== 'Open') continue;
      try { if (this.market.secureProfitTrade(t.userId, t.id) > 0) changed += 1; }
      catch (e) { this.lastError = e.message; }
    }
    return changed;
  }

  subscribeAutoSecure(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw nextError('User not found');
    const priceUsd = Number(this.settings().autoSecurePriceUsd) || 20;
    const feeCoins = round(priceUsd * COINS_PER_USD, 2);
    if (!(priceUsd > 0)) throw nextError('This tool is not priced yet');
    const ia = invAcct(u);
    if ((Number(ia.usd) || 0) < priceUsd) throw nextError(`Not enough investment USD — the Auto Secure tool costs $${priceUsd.toFixed(2)}`);
    const now = Date.now();
    const cycle = Object.prototype.hasOwnProperty.call(CYCLE_MS, this.settings().autoSecureCycle) ? this.settings().autoSecureCycle : 'monthly';
    const ms = CYCLE_MS[cycle];
    ia.usd = round((Number(ia.usd) || 0) - priceUsd, 2);
    const old = (db.autoSecureSubs || []).find((s) => s && s.userId === userId);
    const sub = old || { id: nid('as_'), userId };
    Object.assign(sub, {
      status: 'active', enabled: true, startedAt: now,
      expiresAt: ms ? now + ms : null,
      priceUsd: round(priceUsd, 2), priceCoins: feeCoins,
      billedAs: cycle, renewedAt: old ? now : null
    });
    if (!old) db.autoSecureSubs.push(sub);
    this.tx(db, userId, `Auto Secure Take Profit tool · $${priceUsd.toFixed(2)} ${cycle}`, -feeCoins, 'auto-secure-subscription', {
      priceUsd, priceCoins: feeCoins, expiresAt: sub.expiresAt
    });
    this.notify(db, userId, 'Auto Secure activated',
      `The bot will secure available profit on your active trades, even while you are offline. Claim each secured profit from Orders.`, 'lock');
    this.changed('auto-secure-subscribe');
    try { this.autoSecureSweep(); } catch (e) {}
    return { ok: true, autoSecure: this.autoSecureView(db, userId), balance: pf(u, 'stock'), usd: ia.usd, subscription: sub };
  }

  toggleAutoSecure(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const sub = this.autoSecureSub(db, userId);
    if (!sub) throw nextError('Subscribe to the Auto Secure tool first');
    sub.enabled = opts.enabled === undefined ? sub.enabled === false : !!opts.enabled;
    sub.toggledAt = Date.now();
    this.changed('auto-secure-toggle');
    if (sub.enabled !== false) { try { this.autoSecureSweep(); } catch (e) {} }
    return { ok: true, autoSecure: this.autoSecureView(db, userId) };
  }

  /* ------------------------------- public state ----------------------------- */
  publicState(userId) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw nextError('User not found');
    this.ensureDefaults(db);
    const subs = this.activeSubs(db, userId);
    const tiers = this.tiers().map((t) => {
      const sub = subs.find((s) => s.tierId === t.id) || null;
      return Object.assign({}, t, {
        priceCoins: this.priceCoins(t),
        prices: this.tierPrices(t),
        owned: !!sub,
        lapsedAt: (!sub && (db.botSubscriptions || []).some((s) => s && s.userId === userId && s.tierId === t.id && s.status === 'expired')) ? 1 : null,
        subscription: sub ? {
          id: sub.id, startedAt: sub.startedAt, expiresAt: sub.expiresAt || null,
          billingCycle: sub.billingCycle, priceUsd: sub.priceUsd, priceCoins: sub.priceCoins,
          autoRenew: sub.autoRenew !== false
        } : null
      });
    });
    const session = this.sessionFor(db, userId);
    const history = (db.botSessions || [])
      .filter((s) => s && s.userId === userId && s.status === 'stopped')
      .sort((a, b) => (b.stoppedAt || 0) - (a.stoppedAt || 0))
      .slice(0, 10)
      .map((s) => this.sessionView(s));
    const auto = this.autoSecureView(db, userId);
    const account = this.accountFor(db, userId);
    const events = (db.botEvents || []).filter((e) => e && e.userId === userId).slice(0, 60);
    const stockUsd = pf(u, 'stock');
    return {
      ok: true,
      balance: stockUsd,
      balanceUsd: stockUsd,
      stockUsd: stockUsd,
      botAccess: this.hasBotAccess(u),
      investUsd: round(Number(invAcct(u).usd) || 0, 2),
      durations: DURATIONS.slice(),
      account: {
        capitalCoins: round(account.capitalCoins, 2),
        profitCoins: round(account.profitCoins, 2),
        totalPayoutCoins: round(account.totalPayoutCoins || 0, 2),
        capitalUsd: round(account.capitalCoins * 0.5, 2),
        profitUsd: round(account.profitCoins * 0.5, 2),
        botUsd: pf(u, 'bot')
      },
      events,
      coinsPerUsd: COINS_PER_USD,
      settings: {
        intervalMin: this.settings().intervalMin,
        minCapitalCoins: this.settings().minCapitalCoins,
        minPoolPct: this.settings().minPoolPct,
        autoSecurePriceUsd: Number(this.settings().autoSecurePriceUsd) || 20,
        autoSecureCycle: this.settings().autoSecureCycle || 'monthly'
      },
      autoSecure: auto,
      tiers,
      subscriptions: subs.map((s) => ({ id: s.id, tierId: s.tierId, startedAt: s.startedAt, expiresAt: s.expiresAt || null, billingCycle: s.billingCycle })),
      session: session ? this.sessionView(session) : null,
      history,
      serverTime: Date.now()
    };
  }

  sessionView(s) {
    const db = this.getDb && this.getDb();
    const tier = this.tier(s.tierId);
    const account = db ? this.accountFor(db, s.userId) : { capitalCoins: 0, profitCoins: 0, totalPayoutCoins: 0 };
    const interval = Math.max(1, Number(s.intervalMin) || 1);
    const nextAt = s.status === 'running' ? (Number(s.lastTradeAt) || Date.now()) + interval * 60000 : null;
    return {
      id: s.id, userId: s.userId, tierId: s.tierId,
      tierName: tier ? tier.name : s.tierId,
      tierUsername: tier ? (tier.username || '') : '',
      tierAvatar: tier ? (tier.avatar || '') : '',
      accuracy: tier ? Number(tier.accuracy) || 0 : 0,
      status: s.status,
      allocatedCoins: round(s.allocatedCoins, 2),
      capitalCoins: round(account.capitalCoins, 2),
      profitCoins: round(account.profitCoins, 2),
      totalPayoutCoins: round(account.totalPayoutCoins || 0, 2),
      poolCoins: round(account.capitalCoins, 2),
      minTradeCoins: round(s.minTradeCoins || 0, 2),
      maxTradeCoins: round(s.maxTradeCoins || 0, 2),
      stopAt: s.stopAt || null,
      coolingUntil: s.coolingUntil || null,
      coolingReason: s.coolingReason || '',
      totalProfitCoins: round(s.totalProfitCoins || 0, 2),
      totalLossCoins: round(s.totalLossCoins || 0, 2),
      tradeCount: (s.trades || []).length,
      startedAt: s.startedAt, stoppedAt: s.stoppedAt || null,
      stopReason: s.stopReason || '',
      intervalMin: interval,
      nextTradeAt: nextAt,
      trades: (s.trades || []).slice(0, 60)
    };
  }

  /* ------------------------------- marketplace ------------------------------ */
  subscribe(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw nextError('User not found');
    const tier = this.tier(String(opts.tierId || ''));
    if (!tier || tier.enabled === false) throw nextError('That bot tier is not available');
    const existing = this.subFor(db, userId, tier.id);
    if (existing) throw nextError('You already own this bot — it is active until ' + (existing.expiresAt ? new Date(existing.expiresAt).toLocaleString() : 'forever'));

    const cycle = DURATIONS.includes(String(opts.duration || '')) ? String(opts.duration) : (DURATIONS.includes(tier.billingCycle) ? tier.billingCycle : 'monthly');
    const priceUsd = this.priceFor(tier, cycle);
    const feeCoins = round(priceUsd * COINS_PER_USD, 2);
    if (!(feeCoins > 0)) throw nextError('This bot has no price yet — contact support');
    const ia = invAcct(u);
    if (!this.hasBotAccess(u)) throw nextError('Unlock Bot Assisted Trading first (one-time payment), then pick any bot trader. If you just paid, wait a few seconds and try again.');
    if ((Number(ia.usd) || 0) < priceUsd) throw nextError(`Not enough investment USD — you need $${priceUsd.toFixed(2)}`);

    const now = Date.now();
    const ms = this.cycleMs(cycle);
    ia.usd = round((Number(ia.usd) || 0) - priceUsd, 2);

    /* refresh an expired record for the same tier instead of duplicating it */
    const old = (db.botSubscriptions || []).find((s) => s && s.userId === userId && s.tierId === tier.id);
    const sub = old || { id: nid('bs_'), userId, tierId: tier.id };
    Object.assign(sub, {
      status: 'active', startedAt: now, expiresAt: ms ? now + ms : null,
      billingCycle: cycle, priceUsd, priceCoins: feeCoins, autoRenew: true, priceOverride: null,
      renewedAt: old ? now : null
    });
    if (!old) db.botSubscriptions.push(sub);

    this.tx(db, userId, `Subscribed to ${tier.name} · $${priceUsd.toFixed(2)} / ${CYCLE_LABEL[cycle] || cycle}`, -feeCoins, 'bot-subscription', {
      tierId: tier.id, billingCycle: cycle, priceUsd, expiresAt: sub.expiresAt
    });
    this.notify(db, userId, 'Bot unlocked', `${tier.name} is now active on your account (${tier.accuracy}% simulated accuracy). Allocate capital to start it.`, 'star');
    this.changed('bot-subscribe');
    return { ok: true, subscription: sub, balance: pf(u, 'stock'), usd: ia.usd, tier };
  }

  /* ------------------------------- bot session ------------------------------ */
  start(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw nextError('User not found');
    let tier = null;
    if (opts.tierId) tier = this.tier(String(opts.tierId));
    if (!tier) {
      const owned = this.activeSubs(db, userId).map((s) => this.tier(s.tierId)).filter(Boolean);
      tier = owned[0] || null;
    }
    if (!tier) throw nextError('Subscribe to a bot assistant first');
    if (!this.subFor(db, userId, tier.id)) throw nextError('Your subscription for this assistant is not active');

    const current = this.sessionFor(db, userId);
    if (current && current.status === 'running') throw nextError('This bot is already running');
    if (current && current.status === 'cooling') throw nextError('This bot is cooling down — top up capital and press Resume trading');
    if (current && current.status === 'paused') throw nextError('This bot is paused — press Resume trading');

    const account = this.accountFor(db, userId);
    let topupUsd = Number(opts.topupUsd);
    if (!(topupUsd > 0) && Number(opts.topupCoins) > 0) topupUsd = Number(opts.topupCoins) * 0.5;
    topupUsd = round(topupUsd, 2);
    if (topupUsd > 0) {
      /* Bot capital can be topped up with ANY amount: spend the reserved bot
         allocation first, then draw the remainder straight from the user's
         stock trading balance (portfolios.stock = stock cash). */
      const availUsd = pf(u, 'bot');
      const stockUsd = pf(u, 'stock');
      const totalUsd = round(availUsd + stockUsd, 2);
      if (topupUsd > totalUsd + 1e-9) throw nextError(`Top-up is higher than your available balance ($${totalUsd.toFixed(2)})`);
      const fromBot = Math.min(availUsd, topupUsd);
      const fromStock = round(topupUsd - fromBot, 2);
      if (fromBot > 0) setPf(u, 'bot', round(availUsd - fromBot, 2));
      if (fromStock > 0) setPf(u, 'stock', round(stockUsd - fromStock, 2));
      account.capitalCoins = round((Number(account.capitalCoins) || 0) + topupUsd * COINS_PER_USD, 2);
      this.event(db, userId, 'topup', `Bot capital top-up · $${topupUsd.toFixed(2)} USD ($${fromBot.toFixed(2)} allocation + $${fromStock.toFixed(2)} stock balance)`, topupUsd, { source: 'portfolio' });
    }

    const minCapital = Math.max(1, Number(this.settings().minCapitalCoins) || 5);
    if (account.capitalCoins < minCapital) throw nextError(`Bot trading capital is ${round(account.capitalCoins, 2)} WC — top up at least ${minCapital} WC to start trading`);

    let minTrade = Number(opts.minTradeCoins);
    if (!(minTrade > 0) && Number(opts.minTradeUsd) > 0) minTrade = Number(opts.minTradeUsd) * COINS_PER_USD;
    minTrade = round(minTrade > 0 ? minTrade : Math.max(1, account.capitalCoins * 0.05), 2);
    let maxTrade = Number(opts.maxTradeCoins);
    if (!(maxTrade > 0) && Number(opts.maxTradeUsd) > 0) maxTrade = Number(opts.maxTradeUsd) * COINS_PER_USD;
    maxTrade = round(maxTrade > 0 ? maxTrade : Math.max(minTrade, account.capitalCoins * 0.25), 2);
    if (!(minTrade > 0)) throw nextError('Minimum amount per trade must be greater than zero');
    if (maxTrade < minTrade) throw nextError('Maximum amount per trade must be at least the minimum');
    if (minTrade > account.capitalCoins) throw nextError('Minimum trade amount is higher than the bot capital balance');

    const now = Date.now();
    const interval = Math.max(1, Math.round(Number(tier.intervalMin) || Number(this.settings().intervalMin) || 5));
    let stopAt = 0;
    if (Number(opts.durationMinutes) > 0) stopAt = now + Number(opts.durationMinutes) * 60000;
    else if (Number(opts.stopAt) > now) stopAt = Number(opts.stopAt);

    const session = {
      id: nid('bt_'), userId, tierId: tier.id, status: 'running',
      allocatedCoins: account.capitalCoins,
      startedAt: now, stoppedAt: null, lastTradeAt: now - interval * 60000,
      intervalMin: interval, minTradeCoins: minTrade, maxTradeCoins: maxTrade,
      stopAt: stopAt || null, coolingUntil: null, coolingReason: '',
      totalProfitCoins: 0, totalLossCoins: 0, trades: [], autoStopped: false
    };
    db.botSessions.unshift(session);
    this.event(db, userId, 'start', `Bot started · ${tier.name} · capital ${account.capitalCoins} WC · trades ${minTrade}-${maxTrade} WC${stopAt ? ' · stops at ' + new Date(stopAt).toLocaleString() : ''}`, account.capitalCoins, { sessionId: session.id, tierId: tier.id });
    this.notify(db, userId, 'Bot trading started', `${tier.name} is trading real stocks from the available market. Capital balance ${account.capitalCoins.toFixed(2)} WC.`, 'trend');
    this.changed('bot-start');
    return { ok: true, session: this.sessionView(session), account: this.accountFor(db, userId), balance: pf(u, 'stock'), stockUsd: pf(u, 'stock') };
  }

  /* ---------------------------- bot account money --------------------------- */
  topup(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw nextError('User not found');
    let amountUsd = Number(opts.amountUsd);
    if (!(amountUsd > 0) && Number(opts.amountCoins) > 0) amountUsd = Number(opts.amountCoins) * 0.5;
    amountUsd = round(amountUsd, 2);
    if (!(amountUsd > 0)) throw nextError('Enter a top-up amount');
    /* any amount, from the bot allocation first and then the stock balance */
    const availUsd = pf(u, 'bot');
    const stockUsd = pf(u, 'stock');
    const totalUsd = round(availUsd + stockUsd, 2);
    if (amountUsd > totalUsd + 1e-9) throw nextError(`Top-up is higher than your available balance ($${totalUsd.toFixed(2)})`);
    const fromBot = Math.min(availUsd, amountUsd);
    const fromStock = round(amountUsd - fromBot, 2);
    if (fromBot > 0) setPf(u, 'bot', round(availUsd - fromBot, 2));
    if (fromStock > 0) setPf(u, 'stock', round(stockUsd - fromStock, 2));
    const account = this.accountFor(db, userId);
    account.capitalCoins = round((Number(account.capitalCoins) || 0) + amountUsd * COINS_PER_USD, 2);
    this.event(db, userId, 'topup', `Top-up · $${amountUsd.toFixed(2)} USD ($${fromBot.toFixed(2)} allocation + $${fromStock.toFixed(2)} stock balance)`, amountUsd, { source: 'portfolio' });
    this.notify(db, userId, 'Bot capital topped up', `$${amountUsd.toFixed(2)} USD added to the bot trading capital balance.`, 'wallet');
    this.changed('bot-topup');
    return { ok: true, account, balance: pf(u, 'stock'), stockUsd: pf(u, 'stock') };
  }

  transfer(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw nextError('User not found');
    const source = opts.source === 'profit' ? 'profit' : 'capital';
    let amountUsd = Number(opts.amountUsd);
    if (!(amountUsd > 0) && Number(opts.amountCoins) > 0) amountUsd = Number(opts.amountCoins) * 0.5;
    amountUsd = round(amountUsd, 2);
    if (!(amountUsd > 0)) throw nextError('Enter an amount to transfer');
    const account = this.accountFor(db, userId);
    const availableCoins = source === 'profit' ? Number(account.profitCoins) || 0 : Number(account.capitalCoins) || 0;
    const amountCoins = round(amountUsd * COINS_PER_USD, 2);
    if (amountCoins > availableCoins) throw nextError(`Not enough ${source} balance ($${(availableCoins * 0.5).toFixed(2)})`);
    if (source === 'profit') account.profitCoins = round(availableCoins - amountCoins, 2);
    else account.capitalCoins = round(availableCoins - amountCoins, 2);
    setPf(u, 'stock', pf(u, 'stock') + amountUsd);
    this.event(db, userId, 'transfer', `Transfer ${source} → stock trading balance · $${amountUsd.toFixed(2)} USD`, -amountUsd, { source, target: 'stock' });
    this.notify(db, userId, 'Bot funds transferred', `$${amountUsd.toFixed(2)} USD moved from your bot ${source} balance to your stock trading balance.`, 'wallet');
    this.changed('bot-transfer');
    return { ok: true, account, balance: pf(u, 'stock'), stockUsd: pf(u, 'stock') };
  }

  resume(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    const userId = String(opts.userId || '');
    const session = this.sessionFor(db, userId);
    if (!session) throw nextError('No bot session to resume');
    if (session.status === 'running') return { ok: true, session: this.sessionView(session) };
    const account = this.accountFor(db, userId);
    if ((Number(account.capitalCoins) || 0) < Math.max(1, Number(session.minTradeCoins) || 1)) {
      throw nextError('Top up the bot trading capital before resuming');
    }
    session.status = 'running';
    session.coolingUntil = null;
    session.coolingReason = '';
    session.lastTradeAt = Date.now() - Math.max(1, Number(session.intervalMin) || 1) * 60000;
    this.event(db, userId, 'resume', `Bot resumed · capital ${account.capitalCoins} WC`, account.capitalCoins, { sessionId: session.id });
    this.changed('bot-resume');
    return { ok: true, session: this.sessionView(session), account };
  }

  stop(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    const userId = String(opts.userId || '');
    const session = this.sessionFor(db, userId);
    if (!session) throw nextError('No active bot session');
    return this.stopSession(db, session, String(opts.reason || 'Stopped by user'), 'bot-stop');
  }

  stopSession(db, session, reason, source) {
    const now = Date.now();
    const account = this.accountFor(db, session.userId);
    session.status = 'stopped';
    session.stoppedAt = now;
    session.stopReason = reason;
    session.lastTradeAt = now;
    session.poolCoins = round(account.capitalCoins, 2);
    this.event(db, session.userId, 'stop', `Bot stopped · ${reason} · capital ${account.capitalCoins} WC · profit ${account.profitCoins} WC`, account.capitalCoins, { sessionId: session.id, reason });
    this.notify(db, session.userId, reason === 'Capital exhausted' ? 'Bot cooling down' : 'Bot stopped',
      `Trading stopped. Capital ${round(account.capitalCoins, 2)} WC and profit ${round(account.profitCoins, 2)} WC remain in your bot balances — transfer or top up to continue.`,
      reason === 'Capital exhausted' ? 'ban' : 'check');
    this.changed(source || 'bot-stop');
    const uu = (db.users || []).find((x) => x.id === session.userId) || {};
    return { ok: true, session: this.sessionView(session), account, balance: pf(uu, 'stock'), stockUsd: pf(uu, 'stock') };
  }

  history(userId) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const account = this.accountFor(db, userId);
    const events = (db.botEvents || []).filter((e) => e && e.userId === userId).slice(0, 300);
    const sessions = (db.botSessions || []).filter((x) => x && x.userId === userId).slice(0, 30).map((x) => this.sessionView(x));
    const txs = (db.txs || []).filter((t) => t && t.userId === userId && /bot|auto-secure/.test(String(t.type || ''))).slice(0, 100);
    return { ok: true, account, events, sessions, txs, serverTime: Date.now() };
  }

  /* --------------------------------- admin --------------------------------- */  /* --------------------------------- admin --------------------------------- */
  adminState() {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const sessions = db.botSessions || [];
    const autoSubs = (db.autoSecureSubs || []);
    const autoActive = autoSubs.filter((s) => s && s.status === 'active');
    const autoRevenue = round((db.txs || [])
      .filter((t) => t && t.type === 'auto-secure-subscription')
      .reduce((a, t) => a - (Number(t.coins) || 0), 0), 2);
    let securedOpen = 0;
    (db.trades || []).forEach((t) => {
      (t.securedProfits || []).forEach((p) => { if (p && !p.claimed) securedOpen = round(securedOpen + (Number(p.coins) || 0), 2); });
    });
    return {
      ok: true,
      tiers: this.tiers(),
      settings: this.settings(),
      cycleOptions: Object.keys(CYCLE_MS),
      durations: DURATIONS.slice(),
      subscriptions: (db.botSubscriptions || []).filter(Boolean)
        .sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0)).slice(0, 200)
        .map((s) => {
          const uu = (db.users || []).find((x) => x.id === s.userId);
          const tt = this.tier(s.tierId);
          return {
            id: s.id, userId: s.userId, username: uu ? (uu.username || uu.name || '') : '',
            tierId: s.tierId, tierName: tt ? tt.name : s.tierId, billingCycle: s.billingCycle,
            priceUsd: s.priceUsd, priceOverride: s.priceOverride == null ? null : s.priceOverride,
            expiresAt: s.expiresAt || null, status: s.status, autoRenew: s.autoRenew !== false
          };
        }),
      autoSecure: {
        priceUsd: Number(this.settings().autoSecurePriceUsd) || 20,
        billingCycle: this.settings().autoSecureCycle || 'monthly',
        activeSubs: autoActive.length,
        enabledSubs: autoActive.filter((s) => s.enabled !== false).length,
        revenueCoins: autoRevenue,
        revenueUsd: round(autoRevenue * 0.5, 2),
        securedPendingCoins: securedOpen
      },
      stats: {
        subscriptions: (db.botSubscriptions || []).filter((s) => s.status === 'active').length,
        running: sessions.filter((s) => s.status === 'running').length,
        reservedCoins: round(sessions.filter((s) => s.status === 'running' || s.status === 'paused').reduce((a, s) => a + (Number(s.poolCoins) || 0), 0), 2),
        revenueCoins: round((db.txs || []).filter((t) => t.type === 'bot-subscription').reduce((a, t) => a - (Number(t.coins) || 0), 0), 2),
        autoSecureRevenueCoins: autoRevenue,
        autoSecureSubs: autoActive.length,
        sessions: sessions.length
      }
    };
  }

  /* admin: change a user's bot subscription renewal date, amount, duration or auto-renew */
  adminEditSub(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const s = (db.botSubscriptions || []).find((x) => x && x.id === String(opts.subId || ''));
    if (!s) throw nextError('Subscription not found');
    if (opts.billingCycle != null) {
      if (!DURATIONS.includes(String(opts.billingCycle))) throw nextError('Unknown duration');
      s.billingCycle = String(opts.billingCycle);
    }
    if (opts.priceUsd !== undefined) {
      if (opts.priceUsd === null || opts.priceUsd === '') s.priceOverride = null;
      else {
        const v = Number(opts.priceUsd);
        if (!(v >= 0)) throw nextError('Invalid amount');
        s.priceOverride = round(v, 2);
        s.priceUsd = round(v, 2);
      }
    }
    if (opts.autoRenew != null) s.autoRenew = !!opts.autoRenew;
    if (opts.expiresAt != null) {
      const e = Number(opts.expiresAt);
      if (!Number.isFinite(e) || e <= 0) throw nextError('Invalid renewal date');
      s.expiresAt = e;
      if (e > Date.now() && s.status === 'expired') { s.status = 'active'; delete s.expiredAt; }
    }
    const tier = this.tier(s.tierId);
    this.notify(db, s.userId, 'Bot subscription updated', `An admin updated ${tier ? tier.name : s.tierId}. Next renewal: ${s.expiresAt ? new Date(s.expiresAt).toLocaleString() : 'none'}.`, 'clock');
    this.changed('bot-admin-sub');
    return this.adminState();
  }

  saveAdminConfig(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    if (Array.isArray(opts.tiers)) {
      if (!Array.isArray(db.botTiers)) db.botTiers = [];
      let sort = Math.max(0, ...db.botTiers.map((x) => Number(x && x.sort) || 0));
      for (const incoming of opts.tiers) {
        let t = db.botTiers.find((x) => x && x.id === incoming.id);
        if (!t) {
          if (db.botTiers.length >= 60) continue;
          let id = String(incoming.id || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 28);
          if (!id) id = nid('tier_');
          while (db.botTiers.some((x) => x && x.id === id)) id = id.slice(0, 24) + '_' + Math.random().toString(36).slice(2, 5);
          sort += 1;
          t = {
            id, name: 'Bot assistant', accuracy: 50, priceUsd: 50,
            billingCycle: 'monthly', intervalMin: 0, enabled: true,
            blurb: 'Automated trading assistant.', hot: false,
            createdAt: Date.now(), sort
          };
          db.botTiers.push(t);
        }
        if (incoming.name != null) t.name = String(incoming.name).slice(0, 60) || t.name;
        if (incoming.username != null) t.username = String(incoming.username).replace(/^@+/, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
        if (incoming.avatar !== undefined) {
          if (!incoming.avatar) delete t.avatar;
          else {
            const a = String(incoming.avatar);
            if (/^data:image\//i.test(a) && a.length <= 320000) t.avatar = a;
          }
        }
        if (incoming.accuracy != null) t.accuracy = clamp(incoming.accuracy, 1, 100, t.accuracy);
        if (incoming.priceUsd != null) t.priceUsd = Math.max(0, round(incoming.priceUsd, 2));
        if (incoming.billingCycle != null && CYCLE_MS.hasOwnProperty(incoming.billingCycle)) t.billingCycle = incoming.billingCycle;
        if (incoming.prices && typeof incoming.prices === 'object') {
          const np = Object.assign({}, this.tierPrices(t));
          for (const d of DURATIONS) {
            if (incoming.prices[d] != null && incoming.prices[d] !== '') {
              const v = Number(incoming.prices[d]);
              if (Number.isFinite(v) && v >= 0) np[d] = round(v, 2);
            }
          }
          t.prices = np;
          t.priceUsd = np.monthly;
          t.billingCycle = 'monthly';
        }
        if (incoming.intervalMin != null) t.intervalMin = clamp(incoming.intervalMin, 0, 10080, t.intervalMin);
        if (incoming.enabled != null) t.enabled = !!incoming.enabled;
        if (incoming.hot != null) t.hot = !!incoming.hot;
        if (incoming.blurb != null) t.blurb = String(incoming.blurb).slice(0, 140);
      }
    }
    if (opts.settings && typeof opts.settings === 'object') {
      const s = db.botSettings;
      if (opts.settings.intervalMin != null) s.intervalMin = clamp(opts.settings.intervalMin, 1, 10080, s.intervalMin);
      if (opts.settings.minCapitalCoins != null) s.minCapitalCoins = clamp(opts.settings.minCapitalCoins, 1, 1000000, s.minCapitalCoins);
      if (opts.settings.minPoolPct != null) s.minPoolPct = clamp(opts.settings.minPoolPct, 1, 100, s.minPoolPct);
      if (opts.settings.stakePct != null) s.stakePct = clamp(opts.settings.stakePct, 1, 100, s.stakePct);
      if (opts.settings.winPct != null) s.winPct = clamp(opts.settings.winPct, 0.1, 100, s.winPct);
      if (opts.settings.lossPct != null) s.lossPct = clamp(opts.settings.lossPct, 0.1, 100, s.lossPct);
      if (opts.settings.leverage != null) s.leverage = clamp(opts.settings.leverage, 1, 100, s.leverage);
      if (opts.settings.tradeFeePct != null) { const f = Number(opts.settings.tradeFeePct); if (Number.isFinite(f) && f >= 0 && f <= 50) s.tradeFeePct = f; }
      if (opts.settings.autoSecurePriceUsd != null) s.autoSecurePriceUsd = clamp(opts.settings.autoSecurePriceUsd, 0, 100000, s.autoSecurePriceUsd);
      if (opts.settings.autoSecureCycle != null && Object.prototype.hasOwnProperty.call(CYCLE_MS, opts.settings.autoSecureCycle)) {
        s.autoSecureCycle = opts.settings.autoSecureCycle;
      }
    }
    this.changed('bot-admin-config');
    return this.adminState();
  }

  /* ------------------------------ background tick --------------------------- */
  tick() {
    const db = this.getDb && this.getDb();
    if (!db || !Array.isArray(db.users)) return 0;
    this.ensureDefaults(db);
    const now = Date.now();
    this.lastTickAt = now;
    let changed = false;

    /* 1 · expire subscriptions */
    for (const s of db.botSubscriptions || []) {
      if (s && s.status === 'active' && s.expiresAt && s.expiresAt <= now) {
        let renewedOk = false;
        try { renewedOk = this.tryAutoRenew(db, s, now); } catch (e) { this.lastError = e.message; }
        if (renewedOk) { changed = true; continue; }
        s.status = 'expired';
        s.expiredAt = now;
        this.notify(db, s.userId, 'Bot subscription expired', `${this.tier(s.tierId) ? this.tier(s.tierId).name : s.tierId} ${s.autoRenew === false ? 'has ended.' : 'could not be renewed automatically (not enough investment trade capital). The bot is turned off.'} Renew it manually to resume trading.`, 'clock');
        changed = true;
        /* an expired subscription stops its running session and returns capital */
        const session = (db.botSessions || []).find((x) => x && x.userId === s.userId && x.tierId === s.tierId && (x.status === 'running' || x.status === 'paused'));
        if (session) {
          try { this.stopSession(db, session, 'Subscription expired', 'bot-expired'); } catch (e) { this.lastError = e.message; }
        }
      }
    }

    /* 2 · auto-secure tool: expire subscriptions and secure open profits */
    for (const sub of db.autoSecureSubs || []) {
      if (sub && sub.status === 'active' && sub.expiresAt && Number(sub.expiresAt) <= now) {
        sub.status = 'expired';
        sub.enabled = false;
        sub.expiredAt = now;
        this.notify(db, sub.userId, 'Auto Secure tool expired', 'Renew the tool to keep securing take profit while offline.', 'clock');
        changed = true;
      }
    }
    if (this.autoSecureSweep() > 0) changed = true;

    /* 3 · advance running bots */
    for (const session of (db.botSessions || []).slice()) {
      if (!session || session.status !== 'running') continue;
      const user = (db.users || []).find((x) => x.id === session.userId);
      if (!user) continue;
      if (!this.subFor(db, session.userId, session.tierId)) {
        try { this.stopSession(db, session, 'Subscription expired', 'bot-expired'); } catch (e) { this.lastError = e.message; }
        changed = true;
        continue;
      }
      if (session.stopAt && now >= Number(session.stopAt)) {
        try { this.coolSession(db, session, 'Time limit reached'); } catch (e) { this.lastError = e.message; }
        changed = true;
        continue;
      }
      const interval = Math.max(1, Number(session.intervalMin) || 1);
      if (now - (Number(session.lastTradeAt) || 0) < interval * 60000) continue;
      if (this.trade(db, session, user)) changed = true;
    }

    if (changed) this.changed('bot-tick');
    return changed ? 1 : 0;
  }

  coolSession(db, session, reason) {
    session.status = 'cooling';
    session.coolingReason = reason;
    session.coolingUntil = null;
    session.lastTradeAt = Date.now();
    const account = this.accountFor(db, session.userId);
    this.event(db, session.userId, 'cooling', `Bot cooling down · ${reason} · capital ${round(account.capitalCoins, 2)} WC`, account.capitalCoins, { sessionId: session.id, reason });
    this.notify(db, session.userId, 'Bot cooling down', `${reason}. Top up the bot trading capital and press Resume trading to continue.`, 'pause');
  }

  trade(db, session, user) {
    const tier = this.tier(session.tierId);
    if (!tier) return false;
    const s = this.settings();
    const now = Date.now();
    if (session.stopAt && now >= Number(session.stopAt)) {
      this.coolSession(db, session, 'Time limit reached');
      return true;
    }
    const account = this.accountFor(db, session.userId);
    const capital = Math.max(0, Number(account.capitalCoins) || 0);
    const minStake = Math.max(1, Number(session.minTradeCoins) || Number(s.minCapitalCoins) || 5);
    const maxStake = Math.max(minStake, Number(session.maxTradeCoins) || capital);
    if (capital < minStake) {
      this.coolSession(db, session, 'Capital exhausted');
      return true;
    }

    const classes = (db.invest && db.invest.classes) || {};
    const stocks = (db.stocks || []).filter((x) => x && x.ticker && classes[x.assetClass || 'us'] !== false);
    if (!stocks.length) {
      this.coolSession(db, session, 'No tradable stocks available');
      return true;
    }
    const pick = stocks[Math.floor(Math.random() * stocks.length)];
    const ticker = String(pick.ticker);
    let quote = null;
    try { quote = this.getQuote(ticker); } catch (e) {}
    const price = quote && Number(quote.price) > 0 ? round(quote.price, 4) : round(20 + Math.random() * 480, 2);

    const desired = round(capital * (clamp(s.stakePct, 1, 100, 20) / 100), 2);
    const stake = round(Math.min(capital, Math.max(minStake, Math.min(maxStake, desired))), 2);
    if (!(stake > 0)) return false;
    const accuracy = clamp(tier.accuracy, 1, 100, 50);
    const win = Math.random() * 100 < accuracy;
    const move = win ? clamp(s.winPct, 0.1, 100, 4) : -clamp(s.lossPct, 0.1, 100, 6);
    /* profit = capital × price move % × leverage
       payout = capital + profit − (capital × trade fee %) */
    const lev = clamp(s.leverage, 1, 100, 5);
    const feePct = Number.isFinite(Number(s.tradeFeePct)) && Number(s.tradeFeePct) >= 0 ? Number(s.tradeFeePct) : 0.5;
    const pnl = round(Math.max(-stake, stake * (move / 100) * lev), 2);
    const fee = round(Math.min(stake * feePct / 100, Math.max(0, stake + pnl)), 2);
    const payout = round(Math.max(0, stake + pnl - fee), 2);

    account.capitalCoins = round(capital - stake, 2);
    account.profitCoins = round((Number(account.profitCoins) || 0) + payout, 2);
    account.totalPayoutCoins = round((Number(account.totalPayoutCoins) || 0) + payout, 2);

    const entry = {
      id: nid('btr_'), at: now, ticker, side: win ? 'WIN' : 'LOSS',
      stakeCoins: stake, pnlCoins: pnl, payoutCoins: payout, feeCoins: fee, leverage: lev, movePct: move, win,
      priceUsd: price, capitalAfter: account.capitalCoins, profitAfter: account.profitCoins,
      poolAfter: account.capitalCoins, accuracy
    };
    session.trades = session.trades || [];
    session.trades.unshift(entry);
    if (session.trades.length > 120) session.trades.length = 120;
    session.lastTradeAt = now;
    if (win) session.totalProfitCoins = round((Number(session.totalProfitCoins) || 0) + pnl, 2);
    else session.totalLossCoins = round((Number(session.totalLossCoins) || 0) + Math.abs(pnl), 2);
    session.tradeCount = (Number(session.tradeCount) || 0) + 1;

    this.event(db, session.userId, 'trade', `${win ? 'Win' : 'Loss'} · ${ticker} · stake ${stake} WC · ${move > 0 ? '+' : ''}${move}% × ${lev}x = ${pnl >= 0 ? '+' : ''}${pnl} WC · fee ${fee} WC · payout ${payout} WC → profit balance`, payout, {
      sessionId: session.id, ticker, stakeCoins: stake, pnlCoins: pnl, feeCoins: fee, leverage: lev, capitalAfter: account.capitalCoins, profitAfter: account.profitCoins
    });

    if (session.stopAt && now >= Number(session.stopAt)) this.coolSession(db, session, 'Time limit reached');
    else if (account.capitalCoins < minStake) this.coolSession(db, session, 'Capital exhausted');
    return true;
  }

  startTimers() {
    if (this.running) return;
    this.running = true;
    /* every 10s: cheap, and each session still obeys its own minute interval */
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { this.lastError = e.message; console.error('[bots] tick failed:', e.message); }
    }, 10000);
    if (this.timer.unref) this.timer.unref();
    /* Auto Secure reacts on every tick, so profit is locked the moment it appears */
    this.autoTimer = setInterval(() => {
      try { this.autoSecureSweep(); } catch (e) { this.lastError = e.message; }
    }, 1000);
    if (this.autoTimer.unref) this.autoTimer.unref();
    setTimeout(() => { try { this.tick(); } catch (e) {} }, 4000);
    console.log('[bots] background trading worker started');
  }

  stopTimers() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.timer = null;
    this.autoTimer = null;
  }
}

function nextError(message) { const e = new Error(message); return e; }

module.exports = { BotService, DEFAULT_TIERS, DEFAULT_SETTINGS, COINS_PER_USD, CYCLE_MS, CYCLE_LABEL };
