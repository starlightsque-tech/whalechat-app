/* =========================================================================
   WhaleChat · live position rails  (wc-live-portfolio)  ·  3.71.0
   -------------------------------------------------------------------------
   The chart answers "am I up or down?" — this module keeps that answer on
   screen everywhere else, live:

     · LEFT SIDEBAR · a compact "Live trades" card: every open position (a
       live trade or a stock holding), its ticker, a real-time sparkline, the
       live price and the running P/L in green (profit) or red (loss). The
       total P/L sits in the card header. Tapping a row opens that stock.

     · PORTFOLIO PERFORMANCE · the dashboard performance chart is ticked with
       the live portfolio value once a second, so the curve moves with the
       market instead of freezing at the last page paint.

   Everything is read-only: LT.positions() and INV.quote() are the app's own
   maths. No trade, balance or payout is ever written from here.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcLivePortfolio) return;
  window.__wcLivePortfolio = true;

  var TICK_MS = 900;
  var SPARK_KEEP = 48;
  var sparks = {};        /* ticker -> [prices] */
  var sparkAt = {};       /* ticker -> last seed ms */
  var lastSig = '';
  var nodes = {};

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }
  function meUser() {
    return safe(function () { var f = g('me'); return typeof f === 'function' ? f() : null; }, null);
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function usd(v) {
    var n = num(v);
    return '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(v) {
    var n = num(v);
    return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%';
  }
  function px(v) {
    var n = num(v);
    if (!(n > 0)) return '—';
    return '$' + (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(5));
  }

  function positions() {
    var u = meUser();
    var L = safe(function () { return g('LT'); }, null);
    if (!u || !L || typeof L.positions !== 'function') return [];
    return safe(function () { return (L.positions(u.id) || []).filter(Boolean); }, []) || [];
  }

  /* ------------------------------------------------------------- sparkline */
  function sparkData(t, price) {
    var arr = sparks[t];
    if (!arr || Date.now() - (sparkAt[t] || 0) > 45000) {
      var seed = [];
      var INV = safe(function () { return g('INV'); }, null);
      if (INV && typeof INV.series === 'function') {
        seed = safe(function () { return (INV.series(t, '1D') || []).map(num).filter(function (v) { return v > 0; }); }, []) || [];
      }
      if (seed.length > SPARK_KEEP) seed = seed.slice(-SPARK_KEEP);
      arr = seed;
      sparks[t] = arr;
      sparkAt[t] = Date.now();
    }
    if (price > 0 && (!arr.length || arr[arr.length - 1] !== price)) {
      arr.push(price);
      if (arr.length > SPARK_KEEP) arr.splice(0, arr.length - SPARK_KEEP);
    }
    return arr;
  }

  function drawSpark(canvas, arr, up) {
    if (!canvas || !arr || arr.length < 2) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = canvas.clientWidth || 62;
    var h = canvas.clientHeight || 22;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    var lo = Math.min.apply(null, arr), hi = Math.max.apply(null, arr);
    var span = (hi - lo) || 1;
    var x = function (i) { return (i / (arr.length - 1)) * (w - 2) + 1; };
    var y = function (v) { return h - 2 - ((v - lo) / span) * (h - 4); };
    c.beginPath();
    arr.forEach(function (v, i) { if (i === 0) c.moveTo(x(i), y(v)); else c.lineTo(x(i), y(v)); });
    c.strokeStyle = up ? '#31e0a0' : '#ff5d6c';
    c.lineWidth = 1.5;
    c.lineJoin = 'round';
    c.stroke();
    c.lineTo(x(arr.length - 1), h);
    c.lineTo(x(0), h);
    c.closePath();
    var grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? 'rgba(49,224,160,.28)' : 'rgba(255,93,108,.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = grad;
    c.fill();
  }

  /* ---------------------------------------------------------------- styles */
  function ensureCss() {
    if (document.getElementById('wcLivePortfolioCss')) return;
    var st = document.createElement('style');
    st.id = 'wcLivePortfolioCss';
    st.textContent = [
      '.wc-ls-card{margin:10px 8px 6px;padding:9px 10px;border-radius:12px;background:rgba(46,230,201,.055);border:1px solid rgba(46,230,201,.16)}',
      '.wc-ls-head{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#7d93a5);font-weight:700}',
      '.wc-ls-total{font-size:11.5px;font-weight:800;letter-spacing:0;text-transform:none}',
      '.wc-ls-row{display:flex;align-items:center;gap:6px;padding:6px 0;border-top:1px solid rgba(255,255,255,.06);text-decoration:none;color:inherit}',
      '.wc-ls-row:first-of-type{border-top:0}',
      '.wc-ls-tk{font-size:11px;font-weight:800;min-width:44px;max-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wc-ls-canvas{width:58px;height:22px;display:block;flex:none}',
      '.wc-ls-price{font-size:10.5px;color:var(--muted,#8ba4b6);font-variant-numeric:tabular-nums}',
      '.wc-ls-pl{margin-left:auto;text-align:right;font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.wc-ls-pl small{display:block;font-size:9.5px;font-weight:600;opacity:.8}',
      '.wc-ls-up{color:#31e0a0}.wc-ls-down{color:#ff5d6c}.wc-ls-flat{color:#8ba4b6}',
      '.wc-ls-live{display:inline-block;width:6px;height:6px;border-radius:50%;background:#31e0a0;margin-right:4px;box-shadow:0 0 0 0 rgba(49,224,160,.6);animation:wcPulse 1.8s infinite}',
      '@keyframes wcPulse{0%{box-shadow:0 0 0 0 rgba(49,224,160,.45)}70%{box-shadow:0 0 0 6px rgba(49,224,160,0)}100%{box-shadow:0 0 0 0 rgba(49,224,160,0)}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* -------------------------------------------------------- sidebar card */
  function ensureCard() {
    var side = document.querySelector('aside.sidebar');
    if (!side) return null;
    var card = document.getElementById('wcLiveSide');
    if (card && card.parentNode === side) return card;
    if (!card) {
      card = document.createElement('div');
      card.id = 'wcLiveSide';
      card.className = 'wc-ls-card';
    }
    var brand = side.querySelector('.side-brand');
    if (brand && brand.nextSibling) side.insertBefore(card, brand.nextSibling);
    else side.insertBefore(card, side.firstChild);
    return card;
  }

  function renderCard(card, pos, totalPnl) {
    if (!card) return;
    var sig = pos.map(function (p) { return p.ticker + ':' + p.kind + ':' + p.side; }).join('|');
    var head = '<div class="wc-ls-head"><span><i class="wc-ls-live"></i>Trades live</span>' +
      '<span class="wc-ls-total ' + (totalPnl > 0 ? 'wc-ls-up' : totalPnl < 0 ? 'wc-ls-down' : 'wc-ls-flat') + '">' +
      (totalPnl >= 0 ? '+' : '−') + usd(totalPnl) + '</span></div>';
    if (sig !== lastSig) {
      lastSig = sig;
      card.innerHTML = head + pos.map(function (p) {
        return '<a class="wc-ls-row" href="#/invest/stock/' + encodeURIComponent(p.ticker) + '" data-wc-ls-row="' + p.ticker + '">' +
          '<span class="wc-ls-tk">' + p.ticker + '</span>' +
          '<canvas class="wc-ls-canvas" data-wc-ls-spark="' + p.ticker + '"></canvas>' +
          '<span class="wc-ls-price" data-wc-ls-price="' + p.ticker + '">—</span>' +
          '<span class="wc-ls-pl" data-wc-ls-pl="' + p.ticker + '">—</span>' +
        '</a>';
      }).join('');
    } else {
      var tot = card.querySelector('.wc-ls-total');
      if (tot) {
        tot.className = 'wc-ls-total ' + (totalPnl > 0 ? 'wc-ls-up' : totalPnl < 0 ? 'wc-ls-down' : 'wc-ls-flat');
        tot.textContent = (totalPnl >= 0 ? '+' : '−') + usd(totalPnl);
      }
    }
    /* update every row in place — no rebuild, no flicker */
    pos.forEach(function (p) {
      var q = safe(function () { return (g('INV') && INV.quote) ? INV.quote(p.ticker) : null; }, null);
      var price = q && num(q.price) > 0 ? num(q.price) : num(p.price);
      var pnl = num(p.pnlCoins);
      var up = pnl > 0, down = pnl < 0;
      var css = up ? 'wc-ls-up' : down ? 'wc-ls-down' : 'wc-ls-flat';
      var priceEl = card.querySelector('[data-wc-ls-price="' + p.ticker + '"]');
      if (priceEl) priceEl.textContent = px(price);
      var plEl = card.querySelector('[data-wc-ls-pl="' + p.ticker + '"]');
      if (plEl) {
        plEl.className = 'wc-ls-pl ' + css;
        plEl.innerHTML = (pnl >= 0 ? '+' : '−') + usd(pnl) + '<small>' + pct(num(p.pnlPct)) + '</small>';
      }
      var cv = card.querySelector('[data-wc-ls-spark="' + p.ticker + '"]');
      drawSpark(cv, sparkData(p.ticker, price), p.side === 'short' ? !up : up);
    });
  }

  /* ------------------------------------------- portfolio performance live */
  var perfPrev = 0;
  function tickPortfolioChart() {
    var u = meUser();
    var L = safe(function () { return g('LT'); }, null);
    if (!u || !L || typeof L.summary !== 'function') return;
    if (!/^#\/invest(?!\/stock)/.test(location.hash || '')) return;
    var chart = document.querySelector('.inv-chart-kit');
    if (!chart || !chart.__wck) return;
    if (chart.closest('.hidden')) return;
    var s = safe(function () { return L.summary(u.id); }, null);
    if (!s || (!s.pos.length && !s.botActive)) return;
    var value = num(s.valueUsd);
    if (!(value > 0)) return;
    var prev = perfPrev || value;
    var chg = prev > 0 ? ((value - prev) / prev) * 100 : 0;
    perfPrev = value;
    safe(function () { chart.__wck.tick(value, chg); });
  }

  /* ------------------------------------------------------------------ loop */
  function tick() {
    if (document.hidden) return;
    var u = meUser();
    if (!u) return;
    var pos = positions();
    var card = ensureCard();
    if (card) {
      if (!pos.length) {
        if (card.style.display !== 'none') card.style.display = 'none';
      } else {
        if (card.style.display === 'none') card.style.display = '';
        var total = pos.reduce(function (sum, p) { return sum + num(p.pnlCoins); }, 0);
        renderCard(card, pos, total);
      }
    }
    tickPortfolioChart();
  }

  /* the sidebar is rebuilt by every app render: put the card back */
  function boot() {
    ensureCss();
    tick();
    var root = document.getElementById('app') || document.body;
    if (root && window.MutationObserver) {
      var mo = new MutationObserver(function () {
        /* the card was wiped: re-inject on the next frame */
        if (!document.getElementById('wcLiveSide')) lastSig = '';
      });
      mo.observe(root, { childList: true, subtree: false });
    }
    setInterval(tick, TICK_MS);
    window.addEventListener('hashchange', function () { lastSig = ''; setTimeout(tick, 60); });
    window.addEventListener('wc:trade-opened', function () { lastSig = ''; setTimeout(tick, 120); });
    window.addEventListener('online', tick);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.WCLivePortfolio = {
    tick: tick,
    positions: positions,
    spark: function (t) { return sparkData(String(t || '').toUpperCase(), 0); }
  };
})();
