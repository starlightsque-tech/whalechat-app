/* =========================================================================
   WhaleChat · ConnectionManager (wc-connection)
   -------------------------------------------------------------------------
   ONE singleton for the whole app lifetime. It never shows a connect screen,
   never asks for a URL and never tears the session down on logout, refresh,
   background or network change.

     · 30s heartbeat to the sync function keeps the session warm
     · offline → state flips to Offline in memory only (cached UI keeps working)
     · back online → silently resumes the same market feed, no re-subscribe popup
     · exposes WC_CONN.status() for the tiny dot / health panel
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_CONNECTION) return;

  var CFG = window.WC_BUILD_CONFIG || {};
  var API = String(CFG.syncServer || '').replace(/\/+$/, '');
  var state = {
    online: navigator.onLine !== false,
    reachable: true,
    lastPing: 0,
    lastOk: 0,
    latency: 0,
    failures: 0,
    startedAt: Date.now()
  };
  var timer = null;
  var retry = null;
  var busy = false;

  function label() {
    var el = document.querySelector('[data-wc-conn-label]');
    if (el) el.textContent = state.online && state.reachable ? 'Connected' : 'Offline · cached';
    var badge = document.getElementById('wcConnBadge');
    if (badge) {
      var ok = state.online && state.reachable;
      badge.style.color = ok ? 'var(--success)' : 'var(--muted)';
      badge.style.borderColor = ok ? 'rgba(34,197,94,.35)' : 'rgba(148,163,184,.35)';
      var dot = badge.querySelector('.dot');
      if (dot) dot.style.background = ok ? 'var(--success)' : 'var(--muted)';
    }
    try { document.documentElement.setAttribute('data-wc-online', state.online && state.reachable ? '1' : '0'); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('wc:connection', { detail: status() })); } catch (e) {}
  }

  function status() {
    return {
      online: state.online, reachable: state.reachable,
      lastPing: state.lastPing, lastOk: state.lastOk,
      latency: state.latency, failures: state.failures,
      uptime: Date.now() - state.startedAt
    };
  }

  function scheduleRetry(ms) {
    if (retry) return;
    retry = setTimeout(function () { retry = null; ping(true); }, ms || 5000);
  }

  async function ping(force) {
    if (busy) return status();
    if (!state.online && !force) { scheduleRetry(8000); return status(); }
    busy = true;
    var started = Date.now();
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 9000);
    try {
      var r = await fetch(API + '/api/health?t=' + started, { signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/json' } });
      var d = await r.json().catch(function () { return null; });
      state.lastPing = started;
      if (r.ok && d && d.app === 'whalechat') {
        var wasOffline = !state.reachable;
        state.reachable = true;
        state.lastOk = Date.now();
        state.latency = Date.now() - started;
        state.failures = 0;
        label();
        if (wasOffline) {
          /* same session, same sockets — just resume the feed silently */
          try { if (window.WCMarketFeed && WCMarketFeed.reconnectSilent) WCMarketFeed.reconnectSilent(); } catch (e) {}
        }
      } else {
        state.reachable = false; state.failures++; label(); scheduleRetry();
      }
    } catch (e) {
      state.lastPing = started;
      state.reachable = false;
      state.failures++;
      label();
      scheduleRetry(Math.min(30000, 5000 * Math.max(1, state.failures)));
    } finally {
      clearTimeout(to);
      busy = false;
    }
    return status();
  }

  function start() {
    if (timer) return;
    label();
    setTimeout(function () { ping(false); }, 1200);
    timer = setInterval(function () { ping(false); }, 30000);
  }

  window.addEventListener('online', function () {
    state.online = true;
    label();
    ping(true);
    try { if (window.WCMarketFeed && WCMarketFeed.reconnectSilent) WCMarketFeed.reconnectSilent(); } catch (e) {}
  });
  window.addEventListener('offline', function () {
    state.online = false;
    label();
    /* do NOT close sockets or clear the session: cached UI keeps working */
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - state.lastPing > 25000) ping(false);
  });

  var api = {
    status: status,
    ping: ping,
    reconnect: function () { return ping(true); },
    start: start,
    /* one manager per app lifetime */
    singleton: true
  };
  window.WC_CONNECTION = api;
  /* connections-admin.js owns the WC_CONN namespace — extend, never replace */
  try { window.WC_CONN = Object.assign(window.WC_CONN || {}, api); } catch (e) { window.WC_CONN = api; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  start();
})();
