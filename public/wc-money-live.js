/* =========================================================================
   WhaleChat · live account balances  (wc-money-live)  ·  3.79.0
   -------------------------------------------------------------------------
   The app no longer repaints pages in the background. Balances still need to
   arrive the moment an admin approves a deposit or another device transfers
   money. This module updates only the balance numbers in place — it never
   calls render(), never rebuilds the page and never moves the scroll.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcMoneyLive) return;
  window.__wcMoneyLive = true;

  var RATE = 0.5;
  var last = { dep: null, wc: null, usd: null };
  var announced = {};

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function meUser() { return safe(function () { var f = window.me; return typeof f === 'function' ? f() : null; }, null); }
  function money(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function wc(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  function balances(u) {
    var map = (u && u.depositBalances && typeof u.depositBalances === 'object' && !Array.isArray(u.depositBalances)) ? u.depositBalances : {};
    var rows = Object.keys(map).map(function (k) { return { coin: k, usd: Number(map[k]) || 0 }; })
      .filter(function (r) { return r.usd > 0.004; })
      .sort(function (a, b) { return b.usd - a.usd; });
    return {
      rows: rows,
      dep: rows.reduce(function (s, r) { return s + r.usd; }, 0),
      wc: Number(u && u.balance) || 0,
      usd: Number(u && u.walletUsd) || 0
    };
  }

  function setText(sel, html) {
    var el = document.querySelector(sel);
    if (!el || el.innerHTML === html) return false;
    el.innerHTML = html;
    return true;
  }

  function paint() {
    if (!/^#\/(account|wallet)(\/|$)/.test(String(location.hash || ''))) return;
    var u = meUser();
    if (!u) return;
    var b = balances(u);
    var changed = false;
    changed = setText('[data-acct="depTotal"]', money(b.dep)) || changed;
    changed = setText('[data-acct="wc"]', wc(b.wc) + ' <em>WC</em>') || changed;
    changed = setText('[data-acct="usd"]', money(b.usd)) || changed;

    /* the per-coin list inside the crypto card */
    var host = document.querySelector('.ac-coins');
    if (host) {
      var html = b.rows.length ? b.rows.map(function (r) {
        return '<div class="ac-coin"><span class="ac-coin-dot">' + esc(r.coin.slice(0, 1)) + '</span>' +
          '<b>' + money(r.usd) + ' of ' + esc(r.coin) + '</b>' +
          '<small>' + money(r.usd) + ' · ' + wc(r.usd / RATE) + ' WC</small></div>';
      }).join('') : '<div class="ac-empty">No crypto yet.<br><span>Your crypto deposits appear here, coin by coin, after approval.</span></div>';
      if (host.innerHTML !== html) { host.innerHTML = html; changed = true; }
    }

    /* a deposit approval is the one change worth announcing quietly */
    if (last.dep != null && b.dep > last.dep + 0.004) {
      var delta = b.dep - last.dep;
      var key = 'd' + Math.round(b.dep * 100);
      if (!announced[key]) {
        announced[key] = 1;
        safe(function () { if (typeof toast === 'function') toast(money(delta) + ' credited to your crypto balance', 'ok'); });
      }
    }
    last.dep = b.dep; last.wc = b.wc; last.usd = b.usd;
    void changed;
  }

  function tick() { safe(paint); }

  setInterval(tick, 2500);
  window.addEventListener('hashchange', function () { setTimeout(tick, 350); });
  window.addEventListener('wc:online-refresh', function () { setTimeout(tick, 400); });
  /* the lane dispatches this after a remote refresh / incoming message */
  window.addEventListener('wc-chat-incoming', function () { setTimeout(tick, 300); });
  setTimeout(tick, 1200);

  window.WCMoneyLive = { refresh: tick };
})();
