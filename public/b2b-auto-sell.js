/* =========================================================================
   WhaleChat B2B auto sell  (wc-b2b-auto-sell)

   Buy a stock manually, set ONLY a sell target, tick "Use Auto Buy/Sell".
   As soon as the live price reaches that target (or trades above it), the app
   sells the whole holding for the user: proceeds to the B2B profit balance and
   the principal back to B2B capital. Works for holdings bought by hand — the
   original server-side tool only sold units it had bought itself.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcB2bAutoSell) return;
  window.__wcB2bAutoSell = true;

  var busy = {};
  var log = [];

  function toast2(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }

  function enabled() {
    try {
      if (typeof WC_SUBS !== 'undefined' && WC_SUBS.autoOn) return !!WC_SUBS.autoOn();
      var a = me() && me().investAcct;
      return !!(a && a.tools && a.tools.autobuysell && a.tools.autobuysell.active !== false && a.autoBuySellOn !== false);
    } catch (e) { return false; }
  }

  function quote(t) {
    try { var q = INV.quote(t); return q && Number(q.price) > 0 ? q : null; } catch (e) { return null; }
  }

  /* Sell-only auto setups must NOT be marked `auto` for the backend: the
     server's Auto Buy/Sell fills at the alert price (not the live market price)
     and would sell a manual holding at the target itself. Mark them as a
     client-side manual-sell watch instead; this module executes at market. */
  try {
    if (typeof WC_SUBS !== 'undefined' && WC_SUBS.applyAuto && !WC_SUBS.applyAuto.__wcManualSell) {
      var origApply = WC_SUBS.applyAuto;
      var applyWrapped = function (al, opts) {
        var r = origApply.apply(this, arguments);
        try {
          if (r && opts && opts.auto && !(Number(r.buy) > 0) && Number(r.sell) > 0) {
            r.manualSellAuto = true;
            r.auto = false;
            r.autoState = 'manual-sell';
            r.autoError = '';
          } else if (r) { r.manualSellAuto = false; }
        } catch (e) {}
        return r;
      };
      applyWrapped.__wcManualSell = true;
      WC_SUBS.applyAuto = applyWrapped;
    }
  } catch (e) {}

  function isAutoSell(al) {
    if (!al) return false;
    return !!(al.manualSellAuto || (al.auto && !(Number(al.buy) > 0) && Number(al.sell) > 0));
  }

  function tick() {
    try {
      var u = (typeof me === 'function') ? me() : null;
      if (!u || !u.investAcct) return;
      if (!enabled()) return;
      var a = u.investAcct;
      var alerts = Array.isArray(a.b2bAlerts) ? a.b2bAlerts : [];
      var changed = false;
      alerts.forEach(function (al) {
        if (!isAutoSell(al)) return;
        /* migrate alerts saved before this version: stop the server from
           executing at the target price and take over on the client */
        if (al.auto && !(Number(al.buy) > 0)) { al.auto = false; al.manualSellAuto = true; changed = true; }
        var t = String(al.ticker || '').toUpperCase();
        var sell = Number(al.sell) || 0;
        if (!(sell > 0)) return;
        if (al.autoSellDoneAt && !al.autoRepeat) return;
        var h = a.b2b && a.b2b[t];
        if (!h || !(Number(h.units) > 0)) return;
        if (busy[t]) return;
        var q = quote(t);
        if (!q || q.price + 1e-9 < sell) return;       /* target or any price above it */
        busy[t] = true;
        var units = Number(h.units);
        try {
          if (typeof App !== 'undefined' && App.ihB2bSell) {
            App.ihB2bSell(null, { t: t, all: true });
          } else {
            busy[t] = false;
            return;
          }
          al.autoState = 'done';
          al.autoSellDoneAt = Date.now();
          al.autoSellPrice = q.price;
          al.autoSellUnits = units;
          al.autoSellTrigger = 'manual-holding';
          al.autoLog = (Array.isArray(al.autoLog) ? al.autoLog : []).slice(0, 19);
          al.autoLog.unshift({ at: Date.now(), side: 'sell', price: q.price, units: units, by: 'auto', note: 'Sell target reached' });
          changed = true;
          log.unshift({ t: t, price: q.price, units: units, at: Date.now() });
          log = log.slice(0, 20);
          try {
            if (typeof notify === 'function') {
              notify(u.id, 'Auto sell completed — ' + t,
                t + ' reached your sell target at ' + '$' + q.price.toFixed(2) + '. ' + units.toFixed(6) + ' units sold automatically. Proceeds are in your B2B profit balance.',
                '#/investment/b2b', 'trend');
            }
          } catch (e) {}
          toast2('Auto sold ' + t + ' at $' + q.price.toFixed(2) + ' — target hit', 'ok');
        } catch (e) {
          toast2('Auto sell failed for ' + t + ': ' + e.message, 'err');
        } finally {
          setTimeout(function () { busy[t] = false; }, 4000);
        }
      });
      if (changed) {
        try { if (typeof save === 'function') save(); } catch (e) {
          try { if (typeof persist === 'function') persist(true); } catch (e2) {}
        }
        try { if (typeof render === 'function') render(); } catch (e) {}
      }
    } catch (e) {}
  }

  setInterval(tick, 900);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(tick, 300); });

  /* status line for sell-only auto setups */
  try {
    if (typeof WC_SUBS !== 'undefined' && WC_SUBS.autoStatusText && !WC_SUBS.autoStatusText.__wcManualSell) {
      var orig = WC_SUBS.autoStatusText;
      var wrapped = function (al) {
        if (al && (al.manualSellAuto || al.auto) && Number(al.sell) > 0 && !(Number(al.autoUnits) > 0) && !(Number(al.buy) > 0)) {
          var h = me() && me().investAcct && me().investAcct.b2b && me().investAcct.b2b[String(al.ticker).toUpperCase()];
          var units = h ? Number(h.units) : 0;
          if (!(units > 0)) return '<b class="warn">Auto Buy/Sell armed</b> · buy ' + String(al.ticker).toUpperCase() + ' manually and it will sell automatically at $' + Number(al.sell).toFixed(2);
          if (al.autoSellDoneAt && !al.autoRepeat) return '<b class="up">Auto sold</b> at $' + Number(al.autoSellPrice || al.sell).toFixed(2) + ' · save the alert again for a new round';
          return '<b class="up">Auto Buy/Sell ON</b> · holding ' + units.toFixed(6) + ' units · will sell at $' + Number(al.sell).toFixed(2) + ' or above';
        }
        return orig.apply(this, arguments);
      };
      wrapped.__wcManualSell = true;
      WC_SUBS.autoStatusText = wrapped;
    }
  } catch (e) {}

  window.WC_B2B_AUTO_SELL = { run: tick, log: function () { return log.slice(); } };
})();
