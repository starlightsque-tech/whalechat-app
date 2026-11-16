/* =========================================================================
   WhaleChat shared subscription registry  (wc-subs)

   One single source of truth for every tool / bot a user can subscribe to.
   A subscription made on the Tools page, on the stock trading page or on the
   Trading Bots page is written once and then reflected on EVERY page where
   that tool or bot appears — so a user can never pay twice for the same tool.

   Records live on u.investAcct.tools[toolId] and are mirrored to the server
   bot record (autoSecured) so the bot engine and the UI agree.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_SUBS && window.WC_SUBS.__ready) return;

  var S = window.WC_SUBS = window.WC_SUBS || {};
  S.__ready = true;
  S.VERSION = '1.0.0';

  /* Canonical catalogue. `bot` marks tools that also exist in the server-side
     bot engine (bots.js) so the two records can be mirrored. */
  var CATALOG = [
    {
      id: 'autosecure', name: 'Auto Secure Take Profit', price: 9.99, bot: 'autoSecure',
      desc: 'Automatically secures available profit before it reverses.',
      surfaces: ['tools', 'bots', 'stock']
    },
    {
      id: 'botassist', name: 'Bot Assisted Trading', price: 19.99, bot: null,
      desc: 'Bot monitors active trades and helps manage entries and exits.',
      surfaces: ['tools', 'stock']
    },
    {
      id: 'riskguard', name: 'Risk Shield / Take Loss Guard', price: 7.99, bot: null,
      desc: 'Adds an extra automatic loss guard to open positions.',
      surfaces: ['tools', 'stock']
    },
    {
      id: 'signals', name: 'Pro Chart Signals', price: 4.99, bot: null,
      desc: 'Live structure and momentum signals on the 24/7 chart.',
      surfaces: ['tools', 'stock']
    }
  ];

  var MONTH = 30 * 864e5;
  var listeners = [];

  function escS(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function money(v) { return '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
  function user() { try { return typeof me === 'function' ? me() : (window.DB && DB.users && DB.users[0]) || null; } catch (e) { return null; } }
  function save() { try { if (typeof persist === 'function') persist(); } catch (e) {} try { if (typeof sync === 'function') sync(); } catch (e) {} }
  function repaint() { try { if (typeof render === 'function') render(); } catch (e) {} }
  function tmsg(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }

  /* ---- catalogue accessors ------------------------------------------------- */
  function catalog() {
    try {
      if (typeof DB !== 'undefined' && DB) {
        if (!DB.settings) DB.settings = {};
        if (!Array.isArray(DB.settings.toolCatalog) || !DB.settings.toolCatalog.length) {
          DB.settings.toolCatalog = CATALOG.map(function (t) { return Object.assign({}, t); });
        }
        return DB.settings.toolCatalog;
      }
    } catch (e) {}
    return CATALOG;
  }
  function def(id) {
    var found = null;
    catalog().forEach(function (t) { if (t.id === id) found = t; });
    if (!found) CATALOG.forEach(function (t) { if (t.id === id) found = t; });
    return found;
  }
  function priceOf(id) {
    var d = def(id);
    if (d) { var p = Number(d.price); if (p >= 0) return p; }
    return 0;
  }

  /* ---- account record ------------------------------------------------------ */
  function acct(u) {
    u = u || user();
    if (!u) return null;
    if (!u.investAcct) {
      u.investAcct = {
        usd: 0, payout: 0, wcBalance: 0,
        portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 },
        tools: {}, b2b: {}, b2bFav: [], b2bAlerts: [], b2bProfit: 0,
        disputes: [], requests: [], ledger: [], autoReinvest: false
      };
    }
    if (!u.investAcct.tools) u.investAcct.tools = {};
    return u.investAcct;
  }

  /* ---- the public API ------------------------------------------------------ */
  S.catalog = catalog;
  S.def = def;
  S.price = priceOf;
  S.account = acct;

  S.record = function (id, u) {
    var a = acct(u); if (!a) return null;
    return a.tools[id] || null;
  };

  /* is the tool paid-up and live right now? */
  S.is = function (id, u) {
    var r = S.record(id, u);
    if (r && r.active && Number(r.expiresAt) > Date.now()) return true;
    return false;
  };

  /* 'active' | 'expired' | 'paused' | 'none' */
  S.status = function (id, u) {
    var r = S.record(id, u);
    if (!r) return 'none';
    if (r.paused) return 'paused';
    if (r.active && Number(r.expiresAt) > Date.now()) return 'active';
    return 'expired';
  };

  /* write a record without charging (used by mirroring + admin actions) */
  S.set = function (id, rec, opts) {
    var a = acct(); if (!a) return null;
    var prev = a.tools[id];
    a.tools[id] = Object.assign({}, prev || {}, rec || {}, { id: id, updatedAt: Date.now() });
    if (!(opts && opts.silent)) {
      save();
      notify();
      if (!(opts && opts.noRender)) repaint();
    }
    return a.tools[id];
  };

  S.clear = function (id, opts) {
    var a = acct(); if (!a) return;
    delete a.tools[id];
    if (!(opts && opts.silent)) { save(); notify(); if (!(opts && opts.noRender)) repaint(); }
  };

  S.onChange = function (fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  };
  function notify() {
    listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  function ledgerLine(label, usd, coins, meta) {
    var a = acct(); if (!a) return;
    a.ledger.unshift({ id: 'il_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label: label, usd: Number(usd) || 0, coins: Number(coins) || 0, meta: meta || null, at: Date.now() });
    if (a.ledger.length > 300) a.ledger.length = 300;
  }
  S.ledger = ledgerLine;

  async function pinOk() { return true; }

  /* Mirror the server-side bot record into the shared record so the Tools page
     shows the same state as the Trading Bots page (and vice versa). */
  S.reconcile = function (opts) {
    var a = acct(); if (!a) return;
    var changed = false;
    var st = (window.WC_BOTS && window.WC_BOTS.state) || null;
    var auto = st && st.autoSecure;
    if (auto && auto.active) {
      var r = a.tools.autosecure;
      if (!r || !r.active) {
        a.tools.autosecure = {
          id: 'autosecure', active: true, paused: auto.enabled === false,
          expiresAt: Number(auto.expiresAt) || (Date.now() + MONTH),
          price: Number(auto.priceUsd) > 0 ? Number(auto.priceUsd) : priceOf('autosecure'),
          priceCoins: Number(auto.priceCoins) || 0,
          source: 'bots', mirroredAt: Date.now()
        };
        changed = true;
      } else if (auto.enabled === false && !r.paused) {
        r.paused = true; changed = true;
      }
    }
    var tiers = (st && st.tiers) || [];
    tiers.forEach(function (t) {
      if (!t || !t.owned) return;
      if (!a.tools[t.id]) {
        a.tools[t.id] = {
          id: t.id, active: true, expiresAt: Date.now() + MONTH,
          price: Number(t.priceUsd) || 0, botTier: true, name: t.name, source: 'bots', mirroredAt: Date.now()
        };
        changed = true;
      }
    });
    if (changed && !(opts && opts.silent)) { save(); }
    return changed;
  };

  /* Push the shared record back to the server bot engine so the bot actually
     secures profit for a user who subscribed from the Tools / stock page. */
  async function pushToBotEngine(rec) {
    if (typeof Remote === 'undefined' || !Remote || !Remote.enabled) return { skipped: true };
    var u = user(); if (!u) return { skipped: true };
    try {
      var path = (function (p) { try { return Remote.url(p); } catch (e) { return p; } })('/api/bots/auto-secure/subscribe');
      var r = await Remote.fetchJSON(path, { method: 'POST', body: JSON.stringify({ userId: u.id }) }, 25000);
      try { if (window.WC_BOTS) window.WC_BOTS.state = null; } catch (e) {}
      return r && (r.data || r) || { ok: true };
    } catch (e) {
      return { error: e && e.message ? e.message : 'bot engine unavailable' };
    }
  }

  /* Subscribe. Returns { ok, already, error }. Charges exactly once. */
  S.subscribe = async function (id, opts) {
    opts = opts || {};
    var d = def(id);
    if (!d) return { ok: false, error: 'unknown tool' };
    if (S.is(id)) return { ok: false, already: true, error: 'already subscribed' };
    var a = acct(); if (!a) return { ok: false, error: 'no account' };

    var price = priceOf(id);
    var paid = false;
    var method = opts.method || 'credit';

    if (method === 'credit') {
      if (!(Number(a.usd) >= price)) return { ok: false, error: 'Not enough investment balance' };
      if (!opts.skipPin && !(await pinOk('Confirm subscription', d.name + ' · ' + money(price) + ' / month'))) return { ok: false, error: 'cancelled' };
      a.usd = Math.round((Number(a.usd) - price) * 100) / 100;
      paid = true;
    } else if (method === 'engine') {
      /* the server bot engine charges its own balance — nothing to do here */
      if (!opts.skipPin && !(await pinOk('Confirm subscription', d.name))) return { ok: false, error: 'cancelled' };
      if (d.bot) {
        var res = await pushToBotEngine();
        if (res && res.error) return { ok: false, error: res.error };
      }
    }

    var rec = {
      id: id, active: true, paused: false,
      expiresAt: Date.now() + MONTH,
      price: price, paidUsd: paid ? price : 0,
      source: opts.source || 'tools', startedAt: Date.now()
    };
    S.set(id, rec, { silent: true });
    ledgerLine('Tool subscription · ' + d.name, paid ? -price : 0, 0, { tool: id, source: rec.source });
    save();
    S.reconcile({ silent: true });
    notify();
    if (!opts.noRender) repaint();
    return { ok: true, record: S.record(id) };
  };

  /* Cancel / pause from any surface. */
  S.cancel = async function (id, opts) {
    opts = opts || {};
    if (!S.record(id)) return { ok: false, error: 'not subscribed' };
    if (!opts.skipPin && !(await pinOk('Turn off tool', 'This stops future billing. Paid time is not refunded.'))) return { ok: false, error: 'cancelled' };
    var u = user();
    if (typeof Remote !== 'undefined' && Remote && Remote.enabled && def(id) && def(id).bot) {
      try {
        var p = (function (x) { try { return Remote.url(x); } catch (e) { return x; } })('/api/bots/auto-secure/toggle');
        await Remote.fetchJSON(p, { method: 'POST', body: JSON.stringify({ userId: u.id, enabled: false }) }, 20000);
        try { if (window.WC_BOTS) window.WC_BOTS.state = null; } catch (e) {}
      } catch (e) {}
    }
    S.set(id, { active: false, paused: true, cancelledAt: Date.now() }, { silent: true });
    save(); notify();
    if (!opts.noRender) repaint();
    return { ok: true };
  };

  /* Monthly renewal for shared records (mirrors the Tools page behaviour). */
  S.renew = function () {
    var a = acct(); if (!a) return false;
    var now = Date.now(); var changed = false;
    catalog().forEach(function (t) {
      var r = a.tools[t.id];
      if (!r || !r.active) return;
      if (Number(r.expiresAt) > now) return;
      if (r.source === 'bots' && r.mirroredAt) { r.active = false; r.expiredAt = now; changed = true; return; }
      var price = Number(t.price) || 0;
      if (Number(a.usd) >= price) {
        a.usd = Math.round((Number(a.usd) - price) * 100) / 100;
        r.expiresAt = now + MONTH; r.price = price;
        ledgerLine('Tool auto-renewal · ' + t.name, -price, 0, { tool: t.id });
        changed = true;
      } else {
        r.active = false; r.expiredAt = now; changed = true;
      }
    });
    if (changed) save();
    return changed;
  };

  /* Small, consistent status badge usable by any page. */
  S.badge = function (id) {
    var st = S.status(id);
    if (st === 'active') return '<span class="badge badge-success" data-sub-badge="' + escS(id) + '">Subscribed</span>';
    if (st === 'paused') return '<span class="badge badge-warn" data-sub-badge="' + escS(id) + '">Paused</span>';
    if (st === 'expired') return '<span class="badge badge-warn" data-sub-badge="' + escS(id) + '">Expired</span>';
    return '<span class="badge" data-sub-badge="' + escS(id) + '">Not subscribed</span>';
  };

  /* Reconcile once the app is up, and whenever the bot state arrives. */
  var tries = 0;
  (function boot() {
    if (typeof render !== 'function' || typeof DB === 'undefined') {
      if (tries++ < 60) return setTimeout(boot, 500);
      return;
    }
    try { S.reconcile({ silent: true }); } catch (e) {}
    try {
      setInterval(function () {
        try { if (S.reconcile()) repaint(); } catch (e) {}
        try { if (S.renew()) repaint(); } catch (e) {}
      }, 60000);
    } catch (e) {}
  })();
})();
