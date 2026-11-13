/* =========================================================================
   WhaleChat live-only market (module wc-live-only)
   -------------------------------------------------------------------------
   Removes every virtual/simulated stock price from the browser app so the UI
   can only ever show numbers that came from Finnhub (directly through the
   backend quote bridge or the browser WebSocket).

   · the client-side random-walk price engine (`INV.tick`) is disabled — prices
     are only mutated by real quotes arriving from /api/market/quotes
   · catalogue prices seeded from the demo data are cleared until a real quote
     lands, so nothing is displayed before Finnhub answers
   · quotes without a real tick are marked `stale` and their UI values render
     as an em dash instead of an invented number
   · the "24/7 simulated market" notices are replaced with the live status
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_LIVE_ONLY) return;
  const L = window.WC_LIVE_ONLY = { enabled: true, startedAt: Date.now(), realTickers: new Set() };

  function db() { try { return (typeof DB !== 'undefined' && DB) ? DB : null; } catch (e) { return null; } }
  function meSafe() { try { return (typeof INV !== 'undefined' && INV.live) ? INV.live : {}; } catch (e) { return {}; } }

  /* ---------------------------------------------------------------- pricing */
  function isReal(q) {
    if (!q) return false;
    return q.feed === true || q.real === true || q.live === true || q.source === 'finnhub' || q.source === 'live';
  }

  function clearVirtualPrices() {
    const d = db();
    if (!d || !Array.isArray(d.stocks)) return;
    let cleared = 0;
    d.stocks.forEach((s) => {
      if (!s || !s.ticker) return;
      const q = INV.live && INV.live[s.ticker];
      if (!isReal(q)) {
        if (Number(s.price) > 0 || Number(s.prevClose) > 0) cleared++;
        s.price = 0;
        s.prevClose = 0;
        s.open = 0;
        s.dayHigh = 0;
        s.dayLow = 0;
      } else {
        L.realTickers.add(s.ticker);
      }
    });
    /* the quote cache is the display source — blank anything not backed by a tick */
    try {
      Object.keys(INV.live || {}).forEach((t) => {
        const q = INV.live[t];
        if (q && !isReal(q)) { q.price = 0; q.prevClose = 0; q.stale = true; }
      });
    } catch (e) {}
    if (cleared) {
      try { INV.live = INV.live || {}; } catch (e) {}
      try { if (typeof render === 'function' && !window.__wcNoRender) render(); } catch (e) {}
    }
  }

  /* The random-walk ticker is the main source of "virtual" movement. Keep the
     side effects that are not price related (alerts, limit orders, painting),
     drop the price mutation entirely. */
  function disableVirtualTicker() {
    if (!window.INV || typeof INV.tick !== 'function') return;
    if (INV.__liveOnly) return;
    INV.__liveOnly = true;
    INV.tick = function () {
      try { INV.checkAlerts(); } catch (e) {}
      try { INV.runLimitOrders(); } catch (e) {}
      try { INV.paint(); } catch (e) {}
    };
  }

  /* Guard the quote reader: never hand out a fabricated price. A ticker with no
     real tick returns a zeroed quote flagged `stale`, which the UI renders as —. */
  function guardQuote() {
    if (typeof INV === 'undefined' || INV.__quoteGuarded) return;
    const base = INV.quote;
    if (typeof base !== 'function') return;
    INV.__quoteGuarded = true;
    INV.quote = function (t) {
      const q = base.apply(INV, arguments);
      if (!q) return q;
      const real = isReal(q);
      q.stale = !real;
      if (!real) {
        q.price = 0; q.prevClose = 0; q.open = 0; q.dayHigh = 0; q.dayLow = 0;
        q.changePct = 0; q.changeUsd = 0; q.dir = 0;
      }
      if (real) L.realTickers.add(String(t).toUpperCase());
      return q;
    };
  }

  /* ---------------------------------------------------------------- notices */
  const LIVE_TEXT = 'Live market data via Finnhub';
  const WAIT_TEXT = 'Waiting for the first live Finnhub quote…';

  function paintNotices() {
    const feed = (window.WC_MARKET && WC_MARKET.feed) || null;
    const st = feed && feed.status;
    const quotes = (feed && feed.quotes) || {};
    const live = Object.keys(quotes).filter((k) => quotes[k] && (quotes[k].real || quotes[k].live) && Number(quotes[k].price) > 0).length;
    const text = live ? LIVE_TEXT : WAIT_TEXT;
    document.querySelectorAll('[data-market-notice]').forEach((n) => {
      if (n.textContent.trim() !== text) n.textContent = text;
      n.setAttribute('data-live-count', String(live));
    });
    const badge = document.getElementById('wc-live-badge');
    if (badge) {
      badge.textContent = live ? 'LIVE · ' + live + ' symbols' : 'NO LIVE DATA';
      badge.className = 'wc-live-badge' + (live ? ' on' : '');
    }
    if (st && st.notice && live === 0) {
      document.querySelectorAll('[data-market-notice]').forEach((n) => { n.textContent = st.notice; });
    }
  }

  function start() {
    clearVirtualPrices();
    disableVirtualTicker();
    guardQuote();
    paintNotices();
    setInterval(paintNotices, 4000);
    setInterval(clearVirtualPrices, 15000);
  }

  /* boot after the app + market bridge are ready */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 1500));
  else setTimeout(start, 1500);

  L.start = start;
  L.isReal = isReal;
  L.liveCount = function () {
    const feed = (window.WC_MARKET && WC_MARKET.feed) || {};
    const quotes = feed.quotes || {};
    return Object.keys(quotes).filter((k) => quotes[k] && (quotes[k].real || quotes[k].live) && Number(quotes[k].price) > 0).length;
  };
})();
