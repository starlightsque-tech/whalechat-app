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
const CYCLE_MS = { daily: 86400000, weekly: 604800000, monthly: 2592000000, one_time: null };
const CYCLE_LABEL = { daily: 'day', weekly: 'week', monthly: 'month', one_time: 'one-time' };

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

  activeSubs(db, userId) {
    const now = Date.now();
    return (db.botSubscriptions || []).filter((s) => s && s.userId === userId && s.status === 'active' && (!s.expiresAt || s.expiresAt > now));
  }

  subFor(db, userId, tierId) {
    return this.activeSubs(db, userId).find((s) => s.tierId === tierId) || null;
  }

  sessionFor(db, userId) {
    return (db.botSessions || []).find((s) => s && s.userId === userId && (s.status === 'running' || s.status === 'paused')) || null;
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

  subscribeAutoSecure(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw nextError('User not found');
    const priceUsd = Number(this.settings().autoSecurePriceUsd) || 20;
    const feeCoins = round(priceUsd * COINS_PER_USD, 2);
    if (!(feeCoins > 0)) throw nextError('This tool is not priced yet');
    if ((Number(u.balance) || 0) < feeCoins) throw nextError(`Not enough WC — the Auto Secure tool costs ${feeCoins.toFixed(2)} WC ($${priceUsd.toFixed(2)})`);
    const now = Date.now();
    const cycle = this.settings().autoSecureCycle || 'monthly';
    const ms = this.cycleMs(cycle) || CYCLE_MS.monthly;
    u.balance = round(Number(u.balance) - feeCoins, 2);
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
    return { ok: true, autoSecure: this.autoSecureView(db, userId), balance: u.balance, subscription: sub };
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
        owned: !!sub,
        subscription: sub ? {
          id: sub.id, startedAt: sub.startedAt, expiresAt: sub.expiresAt || null,
          billingCycle: sub.billingCycle, priceUsd: sub.priceUsd, priceCoins: sub.priceCoins
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
    return {
      ok: true,
      balance: round(u.balance, 2),
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
    const tier = this.tier(s.tierId);
    const allocated = round(s.allocatedCoins, 2);
    const pool = round(s.poolCoins, 2);
    const interval = Math.max(1, Number(s.intervalMin) || 1);
    const nextAt = s.status === 'running' ? (Number(s.lastTradeAt) || Date.now()) + interval * 60000 : null;
    return {
      id: s.id, userId: s.userId, tierId: s.tierId,
      tierName: tier ? tier.name : s.tierId,
      accuracy: tier ? Number(tier.accuracy) || 0 : 0,
      status: s.status, allocatedCoins: allocated, poolCoins: pool,
      profitCoins: round(pool - allocated, 2),
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

    const feeCoins = this.priceCoins(tier);
    if (!(feeCoins > 0)) throw nextError('This bot has no price yet — contact support');
    if ((Number(u.balance) || 0) < feeCoins) throw nextError(`Not enough WC — you need ${feeCoins.toFixed(2)} WC ($${(Number(tier.priceUsd) || 0).toFixed(2)})`);

    const now = Date.now();
    const ms = this.cycleMs(tier.billingCycle);
    u.balance = round(Number(u.balance) - feeCoins, 2);

    /* refresh an expired record for the same tier instead of duplicating it */
    const old = (db.botSubscriptions || []).find((s) => s && s.userId === userId && s.tierId === tier.id);
    const sub = old || { id: nid('bs_'), userId, tierId: tier.id };
    Object.assign(sub, {
      status: 'active', startedAt: now, expiresAt: ms ? now + ms : null,
      billingCycle: tier.billingCycle, priceUsd: round(tier.priceUsd, 2), priceCoins: feeCoins,
      renewedAt: old ? now : null
    });
    if (!old) db.botSubscriptions.push(sub);

    this.tx(db, userId, `Subscribed to ${tier.name} · $${(Number(tier.priceUsd) || 0).toFixed(2)} ${tier.billingCycle.replace('_', '-')}`, -feeCoins, 'bot-subscription', {
      tierId: tier.id, billingCycle: tier.billingCycle, priceUsd: tier.priceUsd, expiresAt: sub.expiresAt
    });
    this.notify(db, userId, 'Bot unlocked', `${tier.name} is now active on your account (${tier.accuracy}% simulated accuracy). Allocate capital to start it.`, 'star');
    this.changed('bot-subscribe');
    return { ok: true, subscription: sub, balance: u.balance, tier };
  }

  /* ------------------------------- bot session ------------------------------ */
  start(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const userId = String(opts.userId || '');
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw nextError('User not found');
    const tiers = this.tiers();
    let tier = null;
    if (opts.tierId) tier = this.tier(String(opts.tierId));
    if (!tier) {
      const owned = this.activeSubs(db, userId).map((s) => this.tier(s.tierId)).filter(Boolean);
      tier = owned[0] || null;
    }
    if (!tier) throw nextError('Subscribe to a bot tier first');
    if (!this.subFor(db, userId, tier.id)) throw nextError('Your subscription for this bot is not active');

    const current = this.sessionFor(db, userId);
    if (current && current.status === 'running') throw nextError('Your bot is already running — stop it before starting a new session');
    if (current && current.status === 'paused') throw nextError('Your bot is paused — stop it to return the reserved capital first');

    let allocated = Number(opts.allocatedCoins);
    if (!(allocated > 0) && Number(opts.allocatedUsd) > 0) allocated = Number(opts.allocatedUsd) * COINS_PER_USD;
    allocated = round(allocated, 2);
    const minCapital = Math.max(1, Number(this.settings().minCapitalCoins) || 5);
    if (!(allocated > 0)) throw nextError('Enter the capital you want the bot to trade with');
    if (allocated < minCapital) throw nextError(`Minimum allocation is ${minCapital} WC`);
    if (allocated > (Number(u.balance) || 0)) throw nextError(`Allocation is higher than your available balance (${round(u.balance, 2)} WC)`);

    const now = Date.now();
    u.balance = round(Number(u.balance) - allocated, 2);
    const interval = Math.max(1, Math.round(Number(tier.intervalMin) || Number(this.settings().intervalMin) || 5));
    const session = {
      id: nid('bt_'), userId, tierId: tier.id, status: 'running',
      allocatedCoins: allocated, poolCoins: allocated,
      startedAt: now, stoppedAt: null, lastTradeAt: now - interval * 60000,
      intervalMin: interval, totalProfitCoins: 0, totalLossCoins: 0,
      trades: [], autoStopped: false
    };
    db.botSessions.unshift(session);
    this.tx(db, userId, `Trading bot capital reserved · ${tier.name}`, -allocated, 'bot-reserve', { sessionId: session.id, tierId: tier.id, allocatedCoins: allocated });
    this.notify(db, userId, 'Bot running', `${tier.name} is trading ${allocated.toFixed(2)} WC of reserved capital every ${interval} min.`, 'trend');
    this.changed('bot-start');
    return { ok: true, session: this.sessionView(session), balance: u.balance };
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
    const u = (db.users || []).find((x) => x.id === session.userId);
    if (!u) throw nextError('User not found');
    const now = Date.now();
    const returned = round(Math.max(0, Number(session.poolCoins) || 0), 2);
    u.balance = round((Number(u.balance) || 0) + returned, 2);
    session.status = 'stopped';
    session.stoppedAt = now;
    session.stopReason = reason;
    session.poolCoins = returned;
    session.lastTradeAt = now;
    this.tx(db, session.userId, `Trading bot stopped · ${reason}`, returned, 'bot-return', {
      sessionId: session.id, tierId: session.tierId, allocatedCoins: session.allocatedCoins, returnedCoins: returned,
      profitCoins: round(returned - (Number(session.allocatedCoins) || 0), 2)
    });
    this.notify(db, session.userId, reason === 'Capital exhausted' ? 'Bot auto-stopped' : 'Bot stopped',
      `${returned.toFixed(2)} WC returned to your available balance.`, reason === 'Capital exhausted' ? 'ban' : 'check');
    this.changed(source || 'bot-stop');
    return { ok: true, session: this.sessionView(session), balance: u.balance, returnedCoins: returned };
  }

  /* --------------------------------- admin --------------------------------- */
  adminState() {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    const sessions = db.botSessions || [];
    return {
      ok: true,
      tiers: this.tiers(),
      settings: this.settings(),
      cycleOptions: Object.keys(CYCLE_MS),
      stats: {
        subscriptions: (db.botSubscriptions || []).filter((s) => s.status === 'active').length,
        running: sessions.filter((s) => s.status === 'running').length,
        reservedCoins: round(sessions.filter((s) => s.status === 'running' || s.status === 'paused').reduce((a, s) => a + (Number(s.poolCoins) || 0), 0), 2),
        revenueCoins: round((db.txs || []).filter((t) => t.type === 'bot-subscription').reduce((a, t) => a - (Number(t.coins) || 0), 0), 2),
        sessions: sessions.length
      }
    };
  }

  saveAdminConfig(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw nextError('Database not ready');
    this.ensureDefaults(db);
    if (Array.isArray(opts.tiers)) {
      for (const incoming of opts.tiers) {
        const t = db.botTiers.find((x) => x && x.id === incoming.id);
        if (!t) continue;
        if (incoming.name != null) t.name = String(incoming.name).slice(0, 60);
        if (incoming.accuracy != null) t.accuracy = clamp(incoming.accuracy, 1, 100, t.accuracy);
        if (incoming.priceUsd != null) t.priceUsd = Math.max(0, round(incoming.priceUsd, 2));
        if (incoming.billingCycle != null && CYCLE_MS.hasOwnProperty(incoming.billingCycle)) t.billingCycle = incoming.billingCycle;
        if (incoming.intervalMin != null) t.intervalMin = clamp(incoming.intervalMin, 0, 10080, t.intervalMin);
        if (incoming.enabled != null) t.enabled = !!incoming.enabled;
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
        s.status = 'expired';
        s.expiredAt = now;
        this.notify(db, s.userId, 'Bot subscription expired', `${this.tier(s.tierId) ? this.tier(s.tierId).name : s.tierId} has ended. Renew it to keep trading.`, 'clock');
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
    if (this.market && typeof this.market.secureProfitTrade === 'function') {
      for (const t of (db.trades || []).slice()) {
        if (!t || t.type !== 'live' || t.status !== 'Open') continue;
        try { if (this.market.secureProfitTrade(t.userId, t.id) > 0) changed = true; } catch (e) { this.lastError = e.message; }
      }
    }

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
      const interval = Math.max(1, Number(session.intervalMin) || 1);
      if (now - (Number(session.lastTradeAt) || 0) < interval * 60000) continue;
      if (this.trade(db, session, user)) changed = true;
    }

    if (changed) this.changed('bot-tick');
    return changed ? 1 : 0;
  }

  trade(db, session, user) {
    const tier = this.tier(session.tierId);
    if (!tier) return false;
    const s = this.settings();
    const now = Date.now();
    let pool = Math.max(0, Number(session.poolCoins) || 0);
    if (!(pool > 0)) return false;

    const stake = Math.max(0.5, round(pool * (clamp(s.stakePct, 1, 100, 20) / 100), 2));
    const accuracy = clamp(tier.accuracy, 1, 100, 50);
    const win = Math.random() * 100 < accuracy;
    const move = win ? clamp(s.winPct, 0.1, 100, 4) : -clamp(s.lossPct, 0.1, 100, 6);
    const pnl = round(stake * (move / 100), 2);
    pool = Math.round((pool + pnl) * 100) / 100;
    if (pool < 0) pool = 0;

    const classes = (db.invest && db.invest.classes) || {};
    const stocks = (db.stocks || []).filter((x) => x && x.ticker && classes[x.assetClass || 'us'] !== false);
    const pick = stocks.length ? stocks[Math.floor(Math.random() * stocks.length)] : null;
    const ticker = pick ? String(pick.ticker) : 'BTCUSDT';
    let quote = null;
    try { quote = this.getQuote(ticker); } catch (e) {}
    const price = quote && Number(quote.price) > 0 ? round(quote.price, 4) : round(20 + Math.random() * 480, 2);

    const entry = {
      id: nid('btr_'), at: now, ticker, side: win ? 'SELL · WIN' : 'SELL · LOSS',
      stakeCoins: stake, pnlCoins: pnl, win, priceUsd: price,
      poolAfter: pool, accuracy
    };
    session.trades = session.trades || [];
    session.trades.unshift(entry);
    if (session.trades.length > 60) session.trades.length = 60;
    session.poolCoins = pool;
    session.lastTradeAt = now;
    if (win) session.totalProfitCoins = round((Number(session.totalProfitCoins) || 0) + pnl, 2);
    else session.totalLossCoins = round((Number(session.totalLossCoins) || 0) + Math.abs(pnl), 2);
    session.tradeCount = (Number(session.tradeCount) || 0) + 1;

    const floor = Math.max(0.5, round((Number(session.allocatedCoins) || 0) * (clamp(s.minPoolPct, 1, 100, 10) / 100), 2));
    if (pool <= floor) {
      session.autoStopped = true;
      try { this.stopSession(db, session, 'Capital exhausted', 'bot-auto-stop'); } catch (e) { this.lastError = e.message; }
    }
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
    setTimeout(() => { try { this.tick(); } catch (e) {} }, 4000);
    console.log('[bots] background trading worker started');
  }

  stopTimers() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function nextError(message) { const e = new Error(message); return e; }

module.exports = { BotService, DEFAULT_TIERS, DEFAULT_SETTINGS, COINS_PER_USD, CYCLE_MS, CYCLE_LABEL };
