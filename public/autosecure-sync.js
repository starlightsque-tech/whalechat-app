/* =========================================================================
   WhaleChat Auto Secure subscription sync  (wc-autosecure-sync)

   A subscription can be bought from the Tools page, the Trading Bots page or
   the stock page. This module keeps the shared account registry in step with
   the server bot engine, so "Subscribed" is shown on every page and the trade
   engine (LT.autoSecureOn) runs for the account on every device.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcAutoSecureSync) return;
  window.__wcAutoSecureSync = true;

  var busy = false;

  try {
    var st = document.createElement('style');
    st.id = 'wc-autosecure-sync-style';
    st.textContent = '.lt-mv-details{margin-top:8px;border:1px solid var(--border);border-radius:10px;padding:7px 9px;background:rgba(255,255,255,.02)}' +
      '.lt-mv-details summary{cursor:pointer;font-size:11.5px;color:var(--muted);list-style:none;display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
      '.lt-mv-details summary::-webkit-details-marker{display:none}' +
      '.lt-mv-details summary b{color:var(--text)}' +
      '.lt-mv-details[open] summary{margin-bottom:4px}';
    if (!document.getElementById('wc-autosecure-sync-style')) document.head.appendChild(st);
  } catch (e) {}

  function serverBase(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }

  function activePage() {
    try {
      var h = String(location.hash || '');
      return /#\/(invest|investment|orders|bots|tools|account|profile)/.test(h);
    } catch (e) { return false; }
  }

  function applyState(auto) {
    try {
      var u = (typeof me === 'function') ? me() : null;
      var S = window.WC_SUBS;
      if (!u || !S) return false;
      var rec = S.record('autosecure', u);
      var active = !!(auto && auto.active);
      var enabled = !!(auto && auto.enabled);
      var expiresAt = Number(auto && auto.expiresAt) || (Date.now() + 30 * 864e5);
      var price = Number(auto && auto.priceUsd) || (S.price ? S.price('autosecure') : 0);
      var changed = false;
      if (active) {
        if (!rec || !rec.active) {
          S.set('autosecure', {
            active: true, paused: !enabled, expiresAt: expiresAt,
            price: price, priceCoins: Number(auto.priceCoins) || 0,
            paidUsd: 0, source: 'bots', mirroredAt: Date.now()
          }, { silent: true });
          changed = true;
        } else if (rec.source === 'bots' && !!rec.paused === enabled) {
          /* keep the shared record's paused flag in step with the engine */
          rec.paused = !enabled;
          changed = true;
        }
      } else if (rec && rec.active && rec.source === 'bots') {
        rec.paused = true;
        changed = true;
      }
      if (changed) {
        try { if (typeof persist === 'function') persist(true); } catch (e) {}
        try { if (typeof sync === 'function') sync(); } catch (e) {}
      }
      return changed;
    } catch (e) { return false; }
  }

  async function refresh() {
    if (busy) return;
    var u = (typeof me === 'function') ? me() : null;
    if (!u) return;
    if (typeof Remote === 'undefined' || !Remote || !Remote.enabled) return;
    busy = true;
    try {
      var r = await Remote.fetchJSON('/api/bots/state?userId=' + encodeURIComponent(u.id), {}, 12000);
      var d = r && r.data;
      if (d && d.ok && d.autoSecure) {
        try { if (window.WC_BOTS) window.WC_BOTS.state = Object.assign({}, window.WC_BOTS.state || {}, d); } catch (e) {}
        var changed = applyState(d.autoSecure);
        if (changed && activePage()) { try { if (typeof render === 'function') render(); } catch (e) {} }
      }
    } catch (e) {}
    finally { busy = false; }
  }

  setInterval(refresh, 15000);
  window.addEventListener('hashchange', function () { setTimeout(refresh, 700); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(refresh, 500); });
  setTimeout(refresh, 1500);

  /* after subscribing anywhere, pull the mirrored state immediately */
  try {
    if (window.WC_SUBS && WC_SUBS.onChange) {
      WC_SUBS.onChange(function () { setTimeout(refresh, 400); });
    }
  } catch (e) {}

  /* Secured profits created by the server engine are claimed automatically
     while Auto Secure is on, so users see the cash in their Profit balance. */
  var claiming = {};
  async function claimOne(u, t, sp) {
    if (claiming[sp.id] && Date.now() - claiming[sp.id] < 8000) return;
    claiming[sp.id] = Date.now();
    try {
      if (typeof Remote === 'undefined' || !Remote.enabled) return;
      var r = await Remote.fetchJSON('/api/market/secure-profit/claim', {
        method: 'POST',
        body: JSON.stringify({ userId: u.id, tradeId: t.id, profitId: sp.id })
      }, 10000);
      if (r && r.res && r.res.ok && r.data && r.data.ok) {
        try { await Remote.refresh(true); } catch (e) {}
      } else {
        delete claiming[sp.id];   /* retry on the next tick */
      }
    } catch (e) { delete claiming[sp.id]; }
  }
  function autoClaim() {
    try {
      var u = (typeof me === 'function') ? me() : null;
      if (!u || typeof LT === 'undefined' || !LT.open || !LT.autoSecureOn || !LT.autoSecureOn(u.id)) return;
      LT.open(u.id).forEach(function (t) {
        (t.securedProfits || []).forEach(function (sp) {
          if (!sp || sp.claimed || !sp.id || sp.local || sp.autoClaimed) return;
          claimOne(u, t, sp);
        });
      });
    } catch (e) {}
  }
  setInterval(autoClaim, 5000);
  setTimeout(autoClaim, 2500);

  window.WC_AUTOSECURE_SYNC = { refresh: refresh, autoClaim: autoClaim };
})();
