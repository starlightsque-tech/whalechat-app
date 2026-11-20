/* =========================================================================
   WhaleChat · live trade progress  (wc-live-moves)  ·  3.70.0
   -------------------------------------------------------------------------
   WHAT THE USER SEES, WHILE THEY SEE IT

   · On the order card: the move counter, the price, the % move and the running
     P/L are refreshed in place once a second, in the same DOM nodes the card
     already has (data-lt-moves / data-lt-price / data-lt-move / data-lt-pnl /
     data-lt-pct / data-lt-tp-amt / the progress bar). Nothing is rebuilt, so
     the card counts up live instead of waiting for the next repaint.

   · On the stock chart: the entry price rail, take-profit and stop-loss rails,
     and a solid LIVE price rail that travels with every tick, plus a small
     readout above the chart:
         Rise · Entry $302.10 · Now $304.55 ▲ +0.81% · Moves 7 · P/L +12.40 USD

   NOTHING ABOUT THE MONEY IS RECOMPUTED HERE. Every number comes from the
   trade's own existing maths:
     LT.calc(t)        → price, move %, pnlCoins, pnlPct, payout   (read only)
     LT.totalMovesOf(t)→ the move count the payout is multiplied by
   This module only draws and formats them; it never writes to a trade, and it
   never changes the payout calculation.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcLiveMoves) return;
  window.__wcLiveMoves = true;

  var TICK_MS = 900;
  var lastPrice = {};
  var painted = {};

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }
  function LT() { return safe(function () { return g('LT') || null; }, null); }
  function INV() { return safe(function () { return g('INV') || null; }, null); }
  function meUser() { return safe(function () { var f = g('me'); return typeof f === 'function' ? f() : null; }, null); }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(v) {
    var n = num(v);
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function signed(v, dp) {
    var n = num(v);
    var s = Math.abs(n).toFixed(dp == null ? 2 : dp);
    return (n < 0 ? '−' : '+') + s;
  }
  function px(v) {
    var n = num(v);
    return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(5);
  }

  /* the open trades of the signed-in user, straight from the app's own store */
  function openTrades() {
    var u = meUser(), L = LT();
    if (!u || !L || typeof L.open !== 'function') return [];
    return safe(function () { return (L.open(u.id) || []).filter(Boolean); }, []) || [];
  }

  function quoteOf(ticker) {
    var inv = INV();
    if (!inv || typeof inv.quote !== 'function') return null;
    return safe(function () { return inv.quote(ticker); }, null);
  }

  /* ------------------------------------------------------- order cards ---- */
  function refreshCards() {
    var L = LT();
    if (!L || typeof L.calc !== 'function') return;
    openTrades().forEach(function (t) {
      var q = quoteOf(t.ticker);
      var price = q ? num(q.price) : 0;
      if (!(price > 0)) return;
      /* one refresh per distinct price: the move count can never be inflated */
      if (lastPrice[t.id] === price) return;
      lastPrice[t.id] = price;
      var p = safe(function () { return L.calc(t); }, null);
      if (!p) return;
      var up = num(p.pnlCoins) >= 0;
      set('[data-lt-moves="' + t.id + '"]', String(safe(function () { return L.totalMovesOf(t); }, 0)));
      set('[data-lt-price="' + t.id + '"]', px(p.price));
      set('[data-lt-pnl="' + t.id + '"]', (up ? '+' : '−') + money(Math.abs(p.pnlCoins)) + ' USD', up ? 'up' : 'down');
      set('[data-lt-pct="' + t.id + '"]', (num(p.pnlPct) >= 0 ? '+' : '−') + Math.abs(num(p.pnlPct)).toFixed(2) + '%', num(p.pnlPct) >= 0 ? 'up' : 'down');
      set('[data-lt-move="' + t.id + '"]', (num(p.movePct) >= 0 ? '▲ ' : '▼ ') + Math.abs(num(p.movePct)).toFixed(2) + '%', num(p.movePct) >= 0 ? 'up' : 'down');
      set('[data-lt-tp-amt="' + t.id + '"]', num(p.pnlCoins) > 0 ? '(+' + money(p.pnlCoins) + ')' : '');
      /* the bar the card already draws */
      var bar = document.querySelector('[data-lt-pnl="' + t.id + '"]');
      var card = bar ? bar.closest('.lt-card, .card, .inv-row') : null;
      if (card) {
        var fill = card.querySelector('.lt-bar > i');
        if (fill) {
          fill.style.width = Math.min(100, Math.max(0, 50 + num(p.pnlPct))) + '%';
          fill.className = num(p.pnlPct) >= 0 ? 'up' : 'down';
        }
      }
    });
  }

  function set(sel, text, cls) {
    var el = document.querySelector(sel);
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    if (cls) {
      if (cls === 'up') { el.classList.add('up'); el.classList.remove('down'); }
      else { el.classList.add('down'); el.classList.remove('up'); }
    }
  }

  /* ------------------------------------------------------------- chart ---- */
  function railsFor(t, price) {
    var L = LT();
    var out = [];
    if (!t || !L) return out;
    var entry = num(t.entryPrice);
    if (entry > 0) out.push({ price: entry, color: '#60a5fa', title: 'Entry ' + px(entry), solid: true });
    if (num(t.takeProfitPrice) > 0) out.push({ price: num(t.takeProfitPrice), color: '#31e0a0', title: 'TP ' + px(t.takeProfitPrice) });
    if (num(t.stopLossPrice) > 0) out.push({ price: num(t.stopLossPrice), color: '#ff5d6c', title: 'SL ' + px(t.stopLossPrice) });
    if (price > 0) {
      var rising = entry > 0 ? price >= entry : true;
      out.push({ price: price, color: rising ? '#31e0a0' : '#ff5d6c', title: 'Live ' + px(price), solid: true, live: true });
    }
    return out;
  }

  function hudFor(t) {
    var L = LT();
    if (!t || !L || typeof L.calc !== 'function') return '';
    var p = safe(function () { return L.calc(t); }, null);
    if (!p) return '';
    var entry = num(t.entryPrice), price = num(p.price);
    var rising = price >= entry;
    var dir = String(t.side || '').toLowerCase() === 'short' ? 'Fall' : 'Rise';
    var pnl = num(p.pnlCoins);
    var moves = safe(function () { return L.totalMovesOf(t); }, 0);
    return '<div class="wc-lm-hud">' +
      '<span class="wc-lm-dir ' + (dir === 'Fall' ? 'fall' : 'rise') + '">' + dir + '</span>' +
      '<span class="wc-lm-k">Entry</span><b>$' + px(entry) + '</b>' +
      '<span class="wc-lm-k">Now</span><b class="' + (rising ? 'up' : 'down') + '">$' + px(price) +
        ' ' + (rising ? '▲' : '▼') + '</b>' +
      '<span class="wc-lm-k">Moves</span><b class="wc-lm-moves">' + moves + '</b>' +
      '<span class="wc-lm-k">P/L</span><b class="' + (pnl >= 0 ? 'up' : 'down') + '">' +
        (pnl >= 0 ? '+' : '−') + money(Math.abs(pnl)) + ' USD</b>' +
      '<span class="wc-lm-k">(' + signed(p.pnlPct) + '%)</span>' +
      '</div>';
  }

  function refreshCharts() {
    var trades = openTrades();
    var byTicker = {};
    trades.forEach(function (t) { if (t && t.ticker) byTicker[String(t.ticker).toUpperCase()] = t; });
    document.querySelectorAll('[data-wc-live-chart]').forEach(function (el) {
      var ticker = String(el.getAttribute('data-wc-live-chart') || '').toUpperCase();
      var host = el.querySelector('[data-wc-live-host]');
      var t = byTicker[ticker];
      var q = quoteOf(ticker);
      var price = q ? num(q.price) : 0;

      if (t && host && host.__api) {
        try { host.__api.setLines(railsFor(t, price)); } catch (e) {}
      }

      /* the readout */
      var hud = el.querySelector('.wc-lm-hud');
      if (t) {
        var html = hudFor(t);
        if (html) {
          if (!hud) {
            hud = document.createElement('div');
            hud.className = 'wc-lm-wrap';
            el.insertBefore(hud, el.firstChild);
          }
          if (hud.__last !== html) { hud.innerHTML = html; hud.__last = html; }
          hud.style.display = '';
        } else if (hud) { hud.style.display = 'none'; }
      } else if (hud) {
        hud.remove();
      }
    });
  }

  function style() {
    if (document.getElementById('wcLiveMovesCss')) return;
    var st = document.createElement('style');
    st.id = 'wcLiveMovesCss';
    st.textContent =
      '.wc-live-chart{position:relative}' +
      '.wc-lm-wrap{padding:0 2px 4px}' +
      '.wc-lm-hud{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;line-height:1.5;' +
      '  padding:7px 9px;border-radius:10px;background:rgba(255,255,255,.035);' +
      '  border:1px solid var(--border,rgba(255,255,255,.09));color:var(--muted,#8ba4b6)}' +
      'html[data-theme="light"] .wc-lm-hud{background:rgba(9,40,56,.045)}' +
      '.wc-lm-hud b{font-weight:800;color:var(--text,#e9f4f9);font-variant-numeric:tabular-nums}' +
      '.wc-lm-hud b.up{color:#22c58b}html[data-theme="light"] .wc-lm-hud b.up{color:#0a9c78}' +
      '.wc-lm-hud b.down{color:#ff5d6c}html[data-theme="light"] .wc-lm-hud b.down{color:#d93b52}' +
      '.wc-lm-k{text-transform:uppercase;letter-spacing:.06em;font-size:9px;font-weight:800;opacity:.75}' +
      '.wc-lm-dir{font-weight:800;font-size:9px;letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border-radius:999px}' +
      '.wc-lm-dir.rise{color:#22c58b;background:rgba(34,197,139,.14)}' +
      '.wc-lm-dir.fall{color:#ff5d6c;background:rgba(255,93,108,.14)}' +
      '.wc-lm-moves{color:var(--accent,#2ee6c9)!important}';
    document.head.appendChild(st);
  }

  function tick() {
    safe(refreshCards);
    safe(refreshCharts);
  }

  function boot() {
    style();
    tick();
    setInterval(tick, TICK_MS);
    /* a new trade, a closed trade or a repaint changes the DOM: paint again */
    window.addEventListener('hashchange', function () { setTimeout(tick, 120); });
    window.addEventListener('wc:trade-opened', function () { setTimeout(tick, 60); });
    window.addEventListener('wc:trade-closed', function () { setTimeout(tick, 60); });
    if (typeof MutationObserver === 'function') {
      var pending = false;
      var mo = new MutationObserver(function () {
        if (pending) return;
        pending = true;
        setTimeout(function () { pending = false; safe(refreshCharts); }, 150);
      });
      var root = document.getElementById('app') || document.body;
      if (root) mo.observe(root, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.WCLiveMoves = {
    refresh: tick,
    rails: railsFor,
    hud: hudFor,
    open: openTrades
  };
})();
