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
      id: 'botassist', name: 'Bot Assisted Trading', price: 19.99, bot: null, oneTime: true,
      desc: 'One-time unlock: see every bot trader and subscribe to any of them for 24 hrs, a week, a month or a year.',
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
    },
    {
      id: 'autobuysell', name: 'Auto Buy / Sell (B2B)', price: 14.99, bot: null,
      desc: 'On the B2B-Investing desk: buys an asset at your estimated buy price and sells it at your estimated sell price, automatically, for every asset where you select "Use Auto Buy/Sell".',
      surfaces: ['tools', 'b2b']
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
  var ONE_TIME_DESC = 'One-time unlock: see every bot trader and subscribe to any of them for 24 hrs, a week, a month or a year.';
  function isOneTime(id) { return id === 'botassist'; }
  var FOREVER = 100 * 365 * 864e5;
  function catalog() {
    var l = catalogRaw();
    l.forEach(function (t) { if (t && isOneTime(t.id)) { t.oneTime = true; t.desc = ONE_TIME_DESC; } });
    return l;
  }
  function catalogRaw() {
    try {
      if (typeof DB !== 'undefined' && DB) {
        if (!DB.settings) DB.settings = {};
        if (!Array.isArray(DB.settings.toolCatalog) || !DB.settings.toolCatalog.length) {
          DB.settings.toolCatalog = CATALOG.map(function (t) { return Object.assign({}, t); });
        }
        /* tools added in a later release (e.g. Auto Buy / Sell) join the saved catalogue,
           keeping every price the admin already set */
        CATALOG.forEach(function (t) {
          if (!DB.settings.toolCatalog.some(function (x) { return x && x.id === t.id; })) DB.settings.toolCatalog.push(Object.assign({}, t));
        });
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
    if (r && r.active && (isOneTime(id) || Number(r.expiresAt) > Date.now())) return true;
    return false;
  };

  /* 'active' | 'expired' | 'paused' | 'none' */
  S.status = function (id, u) {
    var r = S.record(id, u);
    if (!r) return 'none';
    if (r.paused) return 'paused';
    if (r.active && (isOneTime(id) || Number(r.expiresAt) > Date.now())) return 'active';
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
    var m = meta || null;
    var tid = String((m && m.tool) || '').toLowerCase();
    var scope = tid === 'autobuysell' ? 'b2b' : tid === 'autosecure' ? 'stock' : (/^bot|tier/.test(tid) ? 'bot' : 'general');
    a.ledger.unshift({ id: 'il_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label: label, usd: Number(usd) || 0, coins: Number(coins) || 0, scope: scope, meta: m, at: Date.now() });
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
      expiresAt: Date.now() + (isOneTime(id) ? FOREVER : MONTH),
      oneTime: isOneTime(id), price: price, paidUsd: paid ? price : 0,
      source: opts.source || 'tools', startedAt: Date.now()
    };
    S.set(id, rec, { silent: true });
    ledgerLine((isOneTime(id) ? 'Tool one-time unlock · ' : 'Tool subscription · ') + d.name, paid ? -price : 0, 0, { tool: id, source: rec.source });
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
      if (isOneTime(t.id)) {
        if (Number(r.expiresAt) < now + 50 * 365 * 864e5) { r.expiresAt = now + FOREVER; r.oneTime = true; changed = true; }
        return;
      }
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

  /* ---- Auto Buy / Sell (B2B desk) -------------------------------------------
     The tool trades an asset only when: the tool is subscribed, it is switched on,
     the asset's price alert has "Use Auto Buy/Sell" selected, and a buy and/or sell
     price is set. The server watches every price tick and fills at exactly the
     price the user set. These helpers are shared by every alert form. */
  var AUTO_ID = 'autobuysell';
  S.AUTO_ID = AUTO_ID;
  S.autoSubscribed = function (u) { return S.status(AUTO_ID, u) === 'active'; };
  S.autoOn = function (u) { var a = acct(u); return !!(a && S.autoSubscribed(u) && a.autoBuySellOn !== false); };
  function unitsTxt(n) { return Number(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 6 }); }
  function sfxId(k, sfx) { return 'wcAuto' + k + '_' + String(sfx || '').replace(/[^A-Za-z0-9_-]/g, '_'); }

  S.autoStatusText = function (al) {
    if (!al || !al.auto) return '';
    var tag = S.autoOn() ? '<b class="up">Auto Buy/Sell ON</b>' : '<b class="warn">Auto Buy/Sell selected · tool off</b>';
    if (al.autoError) return tag + ' · <span class="down">' + escS(al.autoError) + '</span>';
    var st = al.autoState;
    if (st === 'buy') return tag + ' · waiting to buy ' + money(al.autoAmount) + ' at ' + money(al.buy) + (Number(al.sell) > 0 ? ', then sell at ' + money(al.sell) : '');
    if (st === 'sell') return tag + ' · ' + (Number(al.autoUnits) > 0 ? 'holding ' + unitsTxt(al.autoUnits) + ' units bought at ' + money(al.autoBuyPrice || al.buy) + ', ' : 'will sell your holding ') + 'selling at ' + money(al.sell);
    if (st === 'held') return tag + ' · bought ' + unitsTxt(al.autoUnits) + ' units at ' + money(al.autoBuyPrice || al.buy) + ' · no sell price set';
    if (st === 'done') return '<b>Auto Buy/Sell finished</b>' + (Number(al.autoSellPrice) > 0 ? ' · sold at ' + money(al.autoSellPrice) : '') + ' · save the alert again to start a new round';
    return tag;
  };
  S.autoLogHTML = function (al) {
    var log = (al && Array.isArray(al.autoLog)) ? al.autoLog : [];
    if (!log.length) return '';
    return '<div class="tiny muted" style="margin-top:4px">' + log.slice(0, 5).map(function (x) {
      var when = new Date(Number(x.at) || Date.now()).toLocaleString();
      return x.side === 'buy'
        ? 'Auto bought ' + unitsTxt(x.units) + ' at ' + money(x.price) + ' for ' + money(x.amount) + ' · ' + escS(when)
        : 'Auto sold ' + unitsTxt(x.units) + ' at ' + money(x.price) + ' · payout ' + (Number(x.payout) >= 0 ? '+' : '') + money(x.payout) + ' · ' + escS(when);
    }).join('<br/>') + '</div>';
  };
  /* the "Use Auto Buy/Sell" fields for one asset's alert form */
  S.autoFields = function (ticker, al, sfx) {
    al = al || {};
    var sub = S.autoSubscribed();
    var dis = sub ? '' : ' disabled';
    return '<div class="wc-auto-box" style="margin-top:8px;padding:8px;border:1px dashed var(--border);border-radius:10px">' +
      '<label class="row" style="gap:8px;align-items:center;font-size:12px"><input type="checkbox" id="' + sfxId('On', sfx) + '"' + (al.auto ? ' checked' : '') + dis + '/> <b>Use Auto Buy/Sell</b> to buy and sell ' + escS(ticker) + ' at these prices</label>' +
      '<div class="field" style="margin:6px 0 0"><label class="label">Auto-buy amount (USD from B2B capital)</label>' +
        '<input class="input" id="' + sfxId('Amt', sfx) + '" type="number" step="0.01" min="0" placeholder="Up to $100" value="' + (Number(al.autoAmount) > 0 ? Number(al.autoAmount) : '') + '"' + dis + '/>' +
        '<div class="tiny muted">Leave blank and the tool uses up to $100 of your B2B capital.</div></div>' +
      '<label class="row" style="gap:8px;align-items:center;font-size:11px;margin-top:6px"><input type="checkbox" id="' + sfxId('Rep', sfx) + '"' + (al.autoRepeat ? ' checked' : '') + dis + '/> Buy again at the buy price after each auto sell</label>' +
      (sub
        ? (S.autoOn() ? '' : '<div class="tiny warn" style="margin-top:4px">Auto Buy/Sell is switched off — turn it on from the B2B desk.</div>')
        : '<div class="tiny muted" style="margin-top:4px">Subscribe to <a href="#/investment/tools">Auto Buy / Sell</a> (' + money(priceOf(AUTO_ID)) + ' / month) to let it trade for you. Without it you get the alert by email and buy or sell yourself.</div>') +
      (al.auto ? '<div class="tiny" style="margin-top:4px">' + S.autoStatusText(al) + '</div>' + S.autoLogHTML(al) : '') +
      '</div>';
  };
  S.readAuto = function (sfx) {
    var on = document.getElementById(sfxId('On', sfx));
    if (!on) return null;
    var amt = document.getElementById(sfxId('Amt', sfx));
    var rep = document.getElementById(sfxId('Rep', sfx));
    return { auto: !!on.checked && !on.disabled, amount: Math.round((Number(amt && amt.value) || 0) * 100) / 100, repeat: !!(rep && rep.checked) };
  };
  /* returns an error message, or '' when the settings can be saved */
  S.checkAuto = function (ticker, buy, sell, opts) {
    if (!opts || !opts.auto) return '';
    if (!S.autoSubscribed()) return 'Subscribe to the Auto Buy/Sell tool first';
    if (!(buy > 0) && !(sell > 0)) return 'Set a buy or sell price for ' + ticker + ' so Auto Buy/Sell knows when to trade';
    if (buy > 0 && sell > 0 && sell <= buy) return 'The sell price must be above the buy price for ' + ticker;
    return '';
  };
  /* write the settings onto the alert (call after buy/sell are set on it) */
  S.applyAuto = function (al, opts) {
    if (!al || !opts) return al;
    var buy = Number(al.buy) || 0, sell = Number(al.sell) || 0;
    var amount = opts.amount > 0 ? opts.amount : 0;
    var repeat = !!opts.repeat;
    var holding = Number(al.autoUnits) > 0 && al.autoState !== 'buy' && al.autoState !== 'done';
    var wasAuto = !!al.auto;
    var fingerprint = [buy, sell, amount, repeat ? 1 : 0].join('|');
    var configChanged = al.autoConfig !== fingerprint;
    al.auto = !!opts.auto;
    al.autoAmount = amount;
    al.autoRepeat = repeat;
    al.autoConfig = fingerprint;
    /* only a real change to the trigger restarts the trade cycle; saving the
       same alert again keeps the server-side buy/sell state intact */
    if (!wasAuto || configChanged) al.autoArmedAt = Date.now();
    al.autoError = '';
    if (!al.auto) al.autoState = holding ? al.autoState : '';
    else if (holding) al.autoState = sell > 0 ? 'sell' : 'held';
    else { al.autoState = buy > 0 ? 'buy' : 'sell'; al.autoUnits = 0; }
    /* selecting the tool on an alert means the user wants it trading */
    var acc = acct();
    if (al.auto && acc) acc.autoBuySellOn = true;
    return al;
  };
  S.autoToggle = function () {
    var a = acct(); if (!a) return false;
    a.autoBuySellOn = a.autoBuySellOn === false;
    save(); notify(); repaint();
    return a.autoBuySellOn;
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
