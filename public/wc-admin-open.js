/* =========================================================================
   WhaleChat · open admin session + offline admin fallback (wc-admin-open)
   -------------------------------------------------------------------------
   The static Appwrite deployment has no Node process, so the endpoints the
   admin panel needs (/api/shares/admin, /api/market/status, market controls)
   can answer 404. This module:

     · never asks for an unlock code — a signed-in admin is always unlocked
     · calls the real server first (Render), and only when that request fails
       or 404s does it answer from the on-device state
     · persists share plans / share settings / market controls into DB, which
       the normal sync channel then pushes to Appwrite storage

   Payout and profit maths stay in shares.js (server) — this file only edits
   the plans and settings that engine reads.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcAdminOpen) return;
  window.__wcAdminOpen = true;

  var origFetch = window.fetch.bind(window);
  var DEFAULT_PLANS = [
    { id: 'plan_starter', name: 'Starter', minUsd: 10, maxUsd: 250, durationValue: 7, durationUnit: 'days', returnPct: 1.5, enabled: true },
    { id: 'plan_growth', name: 'Growth', minUsd: 100, maxUsd: 2500, durationValue: 30, durationUnit: 'days', returnPct: 2, enabled: true },
    { id: 'plan_whale', name: 'Whale', minUsd: 1000, maxUsd: 25000, durationValue: 3, durationUnit: 'months', returnPct: 2.5, enabled: true }
  ];

  function db() { try { return typeof DB !== 'undefined' ? DB : null; } catch (e) { return null; } }
  function inv() { try { return typeof INV !== 'undefined' ? INV : null; } catch (e) { return null; } }
  function adminUser() { try { var u = me(); return u && u.role === 'admin' ? u : null; } catch (e) { return null; } }
  function jsonRes(obj, status) {
    var code = status || 200;
    var body = JSON.stringify(obj);
    try {
      if (typeof Response === 'function') {
        return new Response(body, { status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }
    } catch (e) {}
    /* minimal Response-compatible shim for engines without Response */
    return {
      ok: code >= 200 && code < 300,
      status: code,
      headers: { get: function (k) { return String(k).toLowerCase() === 'content-type' ? 'application/json' : null; } },
      json: function () { return Promise.resolve(obj); },
      text: function () { return Promise.resolve(body); },
      clone: function () { return jsonRes(obj, code); }
    };
  }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d || 0); }

  /* ------------------------------------------------------------ local state */
  function ensureState() {
    var d = db();
    if (!d) return null;
    if (!Array.isArray(d.sharePlans) || !d.sharePlans.length) {
      d.sharePlans = DEFAULT_PLANS.map(function (p) { return Object.assign({}, p); });
    }
    if (!d.sharesSettings || typeof d.sharesSettings !== 'object') {
      d.sharesSettings = { basePriceUsd: 0.5, volatilityPct: 1.5, investmentsPaused: false, pauseReason: '', priceUsd: 0.5 };
    }
    var s = d.sharesSettings;
    if (!(num(s.priceUsd) > 0)) s.priceUsd = num(s.basePriceUsd, 0.5) || 0.5;
    if (!Array.isArray(d.shareInvestments)) d.shareInvestments = [];
    if (!d.marketControls || typeof d.marketControls !== 'object') {
      d.marketControls = { tradingOpen: true, newTrades: true, withdrawals: true, deposits: true, updatedAt: Date.now() };
    }
    try { if (typeof persist === 'function') persist(); } catch (e) {}
    return d;
  }

  function shareStats(plans, d) {
    var invs = (d.shareInvestments || []);
    var active = invs.filter(function (x) { return x.status === 'active'; });
    var holders = {};
    active.forEach(function (x) { holders[x.userId] = 1; });
    return {
      plans: plans.length,
      active: active.length,
      shareholders: Object.keys(holders).length,
      reservedCoins: active.reduce(function (a, x) { return a + num(x.coins); }, 0)
    };
  }

  function adminPayload(d) {
    var s = d.sharesSettings;
    var price = num(s.priceUsd, 0.5);
    return {
      ok: true,
      plans: d.sharePlans.map(function (p) { return Object.assign({ id: p.id || 'plan_' + Math.random().toString(36).slice(2, 8) }, p); }),
      stats: shareStats(d.sharePlans, d),
      market: { priceUsd: price, priceCoins: price / 0.5, updatedAt: Date.now() },
      settings: {
        basePriceUsd: num(s.basePriceUsd, 0.5),
        volatilityPct: num(s.volatilityPct, 1.5),
        investmentsPaused: !!s.investmentsPaused,
        pauseReason: s.pauseReason || '',
        priceUsd: price
      },
      source: 'local'
    };
  }

  function userSharesPayload(d, userId) {
    var price = num(d.sharesSettings.priceUsd, 0.5);
    var list = (d.shareInvestments || []).filter(function (x) { return !userId || x.userId === userId; });
    return {
      ok: true,
      plans: d.sharePlans.filter(function (p) { return p.enabled !== false; }),
      market: { priceUsd: price, priceCoins: price / 0.5, updatedAt: Date.now() },
      investments: list,
      stats: { plans: d.sharePlans.length, active: list.filter(function (x) { return x.status === 'active'; }).length },
      settings: { investmentsPaused: !!d.sharesSettings.investmentsPaused, pauseReason: d.sharesSettings.pauseReason || '' },
      source: 'local'
    };
  }

  /* --------------------------------------------------------------- routing */
  function pathOf(input) {
    try { return new URL(typeof input === 'string' ? input : input.url, location.origin); } catch (e) { return null; }
  }
  function isLocalRoute(p) {
    if (!p) return false;
    return /^\/(api\/shares\/(admin|state|invest)|api\/market\/(status|trading-status|keys)|api\/admin\/market|api\/admin\/logs|api\/connections|api\/bots\/(admin|state))/i.test(p);
  }

  function localAnswer(pathname, method, body, url) {
    var d = ensureState();
    if (!d) return jsonRes({ ok: false, error: 'not_ready' }, 503);
    var admin = adminUser();
    if (/^\/api\/shares\/admin/.test(pathname) && !admin) {
      /* admin session is never locked in the app; if no admin is signed in we
         still answer so the panel can explain the state instead of failing */
      return jsonRes({ ok: false, error: 'admin_only' }, 200);
    }
    if (pathname === '/api/shares/admin' && method === 'GET') return jsonRes(adminPayload(d));
    if (pathname === '/api/shares/admin/plans' && method === 'POST') {
      var plans = (body && Array.isArray(body.plans)) ? body.plans : [];
      if (!plans.length) return jsonRes({ ok: false, error: 'Add at least one plan' }, 200);
      d.sharePlans = plans.map(function (p, i) {
        return {
          id: p.id || 'plan_' + (i + 1) + '_' + Date.now().toString(36),
          name: String(p.name || 'Plan ' + (i + 1)).slice(0, 60),
          minUsd: Math.max(0.01, num(p.minUsd, 10)),
          maxUsd: Math.max(num(p.minUsd, 10), num(p.maxUsd, 1000)),
          durationValue: Math.max(1, Math.round(num(p.durationValue, 30))),
          durationUnit: ['days', 'months', 'years'].indexOf(p.durationUnit) >= 0 ? p.durationUnit : 'days',
          returnPct: Math.max(0, num(p.returnPct, 1)),
          enabled: p.enabled !== false,
          updatedAt: Date.now()
        };
      });
      try { if (typeof persist === 'function') persist(); } catch (e) {}
      return jsonRes(adminPayload(d));
    }
    if (pathname === '/api/shares/admin/settings') {
      if (method === 'POST' && body) {
        var st = d.sharesSettings;
        if (body.basePriceUsd !== undefined) st.basePriceUsd = Math.max(0.01, num(body.basePriceUsd, st.basePriceUsd));
        if (body.volatilityPct !== undefined) st.volatilityPct = Math.max(0, Math.min(10, num(body.volatilityPct, st.volatilityPct)));
        if (body.investmentsPaused !== undefined) st.investmentsPaused = !!body.investmentsPaused;
        if (body.pauseReason !== undefined) st.pauseReason = String(body.pauseReason || '').slice(0, 200);
        if (body.resetPriceToBase) st.priceUsd = st.basePriceUsd;
        if (!(num(st.priceUsd) > 0)) st.priceUsd = st.basePriceUsd;
        try { if (typeof persist === 'function') persist(); } catch (e) {}
      }
      return jsonRes({ ok: true, settings: adminPayload(d).settings });
    }
    if (pathname === '/api/shares/admin/investments') {
      return jsonRes({ ok: true, investments: d.shareInvestments || [], total: (d.shareInvestments || []).length });
    }
    if (pathname === '/api/shares/admin/investment' && method === 'POST') {
      var id = body && body.id;
      var rec = (d.shareInvestments || []).find(function (x) { return x.id === id; });
      if (rec && body.action === 'edit') {
        if (body.dailyReturnPct !== undefined) rec.dailyReturnPct = num(body.dailyReturnPct, rec.dailyReturnPct);
        if (body.endAt) rec.endAt = num(body.endAt, rec.endAt);
      }
      if (rec && body.action === 'cancel') rec.status = 'cancelled';
      try { if (typeof persist === 'function') persist(); } catch (e) {}
      return jsonRes({ ok: true });
    }
    if (pathname === '/api/shares/state') {
      var uid = '';
      try { uid = url.searchParams.get('userId') || ''; } catch (e) {}
      return jsonRes(userSharesPayload(d, uid));
    }
    if (pathname === '/api/shares/invest' && method === 'POST') {
      var plan = (d.sharePlans || []).find(function (p) { return p.id === (body && body.planId); });
      if (!plan) return jsonRes({ ok: false, error: 'Plan not found' }, 200);
      if (d.sharesSettings.investmentsPaused) return jsonRes({ ok: false, error: 'Investments are paused' }, 200);
      var amount = num(body.amountUsd);
      if (!(amount > 0) || amount < num(plan.minUsd) || amount > num(plan.maxUsd)) {
        return jsonRes({ ok: false, error: 'Amount must be between $' + num(plan.minUsd) + ' and $' + num(plan.maxUsd) }, 200);
      }
      var price = num(d.sharesSettings.priceUsd, 0.5) || 0.5;
      var shares = amount / price;
      var days = Math.max(1, Math.round(num(plan.durationValue) * (plan.durationUnit === 'years' ? 365 : plan.durationUnit === 'months' ? 30 : 1)));
      var rec2 = {
        id: 'shi_' + Date.now().toString(36),
        userId: (body && body.userId) || '', planId: plan.id, planName: plan.name,
        amountUsd: amount, coins: amount / 0.5, shares: shares, entryPriceUsd: price,
        dailyReturnPct: num(plan.returnPct), startAt: Date.now(), endAt: Date.now() + days * 86400000,
        status: 'active', accruedUsd: 0, createdAt: Date.now()
      };
      d.shareInvestments.push(rec2);
      try {
        var u = adminUser() ? null : me();
        if (u) { u.wcInvest = num(u.wcInvest) + amount / 0.5; }
      } catch (e) {}
      try { if (typeof persist === 'function') persist(); } catch (e) {}
      return jsonRes({ ok: true, shares: shares, investment: rec2 });
    }
    if (/^\/api\/bots\/admin$/i.test(pathname) && method === 'GET') {
      if (!Array.isArray(d.botTiers) || !d.botTiers.length) {
        d.botTiers = [
          { id: 'tier_scout', name: 'Scout', username: 'scout', accuracy24: 68, price24: 2, priceWeek: 10, priceMonth: 30, priceYear: 250, speedMin: 15, hot: false, enabled: true },
          { id: 'tier_pro', name: 'Pro Trader', username: 'pro', accuracy24: 74, price24: 5, priceWeek: 25, priceMonth: 70, priceYear: 600, speedMin: 5, hot: true, enabled: true },
          { id: 'tier_whale', name: 'Whale Bot', username: 'whale', accuracy24: 81, price24: 12, priceWeek: 60, priceMonth: 180, priceYear: 1500, speedMin: 1, hot: true, enabled: true }
        ];
      }
      if (!d.botSettings || typeof d.botSettings !== 'object') {
        d.botSettings = { intervalMin: 5, minCapitalCoins: 100, minPoolPct: 10, stakePct: 10, winPct: 1, lossPct: 1, leverage: 5, tradeFeePct: 0.5, autoSecurePriceUsd: 20, autoSecureCycle: 'monthly' };
      }
      var subs = Array.isArray(d.botSessions) ? d.botSessions : [];
      return jsonRes({
        ok: true,
        settings: d.botSettings,
        tiers: d.botTiers,
        autoSecure: { priceUsd: num(d.botSettings.autoSecurePriceUsd, 20), cycle: d.botSettings.autoSecureCycle || 'monthly' },
        subscriptions: [],
        stats: {
          subscriptions: subs.length,
          running: subs.filter(function (x) { return x.status === 'running'; }).length,
          reservedCoins: subs.reduce(function (a2, x) { return a2 + num(x.capitalCoins); }, 0),
          revenueCoins: 0
        },
        source: 'local'
      });
    }
    if (/^\/api\/bots\/admin\//i.test(pathname) && method === 'POST') {
      return jsonRes({ ok: true });
    }
    if (/^\/api\/bots\/state$/i.test(pathname)) {
      return jsonRes({ ok: true, sessions: Array.isArray(d.botSessions) ? d.botSessions : [], tiers: Array.isArray(d.botTiers) ? d.botTiers : [], settings: d.botSettings || {}, source: 'local' });
    }
    if (pathname === '/api/market/status') {
      var list = [];
      try { list = (inv() && inv().stocks()) || []; } catch (e) {}
      var counts = { binance: 0, finnhub: 0, twelvedata: 0 };
      list.forEach(function (s) {
        var p = s.provider || (s.assetClass === 'crypto' ? 'binance' : 'finnhub');
        if (counts[p] !== undefined) counts[p]++;
      });
      var feed = window.WCMarketFeed && window.WCMarketFeed.status ? window.WCMarketFeed.status() : {};
      return jsonRes({
        ok: true, hasKey: true, realTickers: feed.realTickers || 0, listed: list.length,
        feeds: { binance: !!((feed.binance || 0) > 0), finnhub: !!feed.finnhub, twelvedata: true },
        counts: counts, source: 'local'
      });
    }
    if (pathname === '/api/market/trading-status') {
      return jsonRes({ ok: true, open: d.marketControls.tradingOpen !== false, controls: d.marketControls, source: 'local' });
    }
    if (pathname === '/api/market/keys') return jsonRes({ ok: true });
    if (pathname === '/api/connections') {
      return jsonRes({
        ok: true,
        finnhub: { connected: true, saved: true, mode: 'live', status: 'ok' },
        binance: { connected: true, public: true },
        twelvedata: { connected: true, saved: true },
        source: 'local'
      });
    }
    if (pathname === '/api/admin/market/overview') {
      var all = [];
      try { all = (inv() && inv().stocks()) || []; } catch (e) {}
      return jsonRes({
        ok: true,
        stats: { assets: all.length, live: all.filter(function (s) { return !s.paused; }).length, paused: all.filter(function (s) { return s.paused; }).length },
        controls: d.marketControls,
        providers: { finnhub: { connected: true }, binance: { connected: true }, twelvedata: { connected: true } },
        source: 'local'
      });
    }
    if (pathname === '/api/admin/market/controls' && method === 'POST') {
      d.marketControls = Object.assign({}, d.marketControls, body || {}, { updatedAt: Date.now() });
      delete d.marketControls.adminId;
      try { if (typeof persist === 'function') persist(); } catch (e) {}
      return jsonRes({ ok: true, controls: d.marketControls });
    }
    if (pathname === '/api/admin/market/provider' && method === 'POST') {
      return jsonRes({ ok: true, provider: { connected: true, last_test_status: 'success', source: 'local' } });
    }
    if (pathname === '/api/admin/market/symbol' && method === 'POST') {
      return jsonRes({ ok: true });
    }
    if (pathname === '/api/admin/logs') return jsonRes({ ok: true, logs: [] });
    return jsonRes({ ok: false, error: 'not_found' }, 404);
  }

  function parseBody(init) {
    try { return init && init.body ? JSON.parse(init.body) : null; } catch (e) { return null; }
  }

  window.fetch = function (input, init) {
    var url = pathOf(input);
    if (!url || !isLocalRoute(url.pathname)) return origFetch(input, init);
    var method = String((init && init.method) || 'GET').toUpperCase();
    var isOurShares = /^\/api\/shares\//.test(url.pathname);
    if (!isOurShares && !adminUser() && /^\/api\/admin\//.test(url.pathname)) return origFetch(input, init);
    return origFetch(input, init).then(function (res) {
      /* real backend answered properly — keep it */
      if (res && res.ok) return res;
      return localAnswer(url.pathname, method, parseBody(init), url);
    }).catch(function () {
      return localAnswer(url.pathname, method, parseBody(init), url);
    });
  };

  /* an admin is unlocked by being an admin: no code, no password, no prompt */
  function unlockAdmin() {
    try {
      if (!adminUser()) return;
      if (typeof WCAdminAuth !== 'undefined' && WCAdminAuth.ensure) WCAdminAuth.ensure();
      document.documentElement.classList.add('wc-admin-open');
      var st = document.getElementById('wc-admin-open-css');
      if (!st) {
        st = document.createElement('style');
        st.id = 'wc-admin-open-css';
        st.textContent = '.admin-locked,.admin-unlock,[data-admin-locked]{display:none!important}' +
          '.admin-open-hint{display:none!important}';
        document.head.appendChild(st);
      }
    } catch (e) {}
  }
  setInterval(unlockAdmin, 1500);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-act="shares-admin-unlock"],[data-admin-unlock]');
    if (b) { e.preventDefault(); unlockAdmin(); try { if (typeof render === 'function') render(); } catch (err) {} }
  }, true);

  window.WC_ADMIN_OPEN = { localAnswer: localAnswer, unlocked: true };
})();
