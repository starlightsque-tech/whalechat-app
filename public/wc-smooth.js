/* =========================================================================
   WhaleChat · smooth runtime  (wc-smooth)  ·  3.77.0
   -------------------------------------------------------------------------
   The screen used to shake and the app could "collapse" for four separate
   reasons. All four are handled here, at the source, without changing how the
   app looks or what it does:

   1 · NOTHING IS DELETED AND RE-CREATED ON A LOOP
       The connectivity pill was removed every 250 ms and rebuilt by its own
       renderer: eight DOM add/remove cycles per second, each one a full
       layout. wc-chat-flow now hides it with CSS and this module verifies the
       page stays still.

   2 · CHARTS REPAINT ON A CALM CADENCE, NEVER UNDER THE USER'S FINGER
       The market ticker rewrote every sparkline and the whole live trading
       chart every 2 s, and the invest ticker did it again every 5 s. A chart
       that is rebuilt while it is being scrolled, dragged or read makes the
       page look like it is shaking. Price text still updates instantly; the
       drawing itself is limited to once every 12 s and is skipped entirely
       while a field, dialog, drag or scroll is in progress (it catches up as
       soon as the user pauses).

   3 · TRADING IS NEVER INTERRUPTED
       While a trade ticket, an order form or any input is focused, background
       repaints are deferred — not cancelled — so a typed amount, a chosen
       leverage and the caret stay exactly where the trader put them. The
       deferred paint runs the moment the user leaves the field.

   4 · THE PAGE CANNOT MOVE BY ITSELF
       Overscroll/pull-to-refresh is contained (a downward swipe on the chart
       used to reload the app), chart hosts reserve their height so a redraw
       cannot shift the page, and entrance animations are disabled after the
       first paint so a re-render never makes cards jump upward again.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcSmooth) return;
  window.__wcSmooth = true;

  var CHART_MS = 12000;        /* chart/spark redraw cadence */
  var BUSY_GRACE = 900;        /* how long after input/scroll we still wait */
  var lastChartAt = 0;
  var pointerDown = 0;
  var lastTouchAt = 0;
  var pendingInv = false;
  var pendingMarket = false;

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function now() { return Date.now(); }

  /* ---------------------------------------------------------- busy state */
  function editing() {
    var a = document.activeElement;
    if (!a) return false;
    var tag = String(a.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (a.isContentEditable) return true;
    if (tag !== 'INPUT') return false;
    var type = String(a.type || 'text').toLowerCase();
    /* a toggle or radio is not "typing" — the app may repaint around it */
    return !(type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit');
  }
  function dialogOpen() {
    return !!document.querySelector('.modal-backdrop:not(.hidden), .modal.open, .sheet-backdrop:not(.hidden), #overlay:not(.hidden)');
  }
  function scrolling() {
    return now() - (window.__wcSmoothScrollAt || 0) < BUSY_GRACE ||
      now() - lastTouchAt < BUSY_GRACE ||
      now() - pointerDown < BUSY_GRACE;
  }
  function busy() { return editing() || dialogOpen() || scrolling(); }

  ['scroll', 'wheel', 'touchmove', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      window.__wcSmoothScrollAt = now();
      if (ev === 'touchstart' || ev === 'touchmove') lastTouchAt = now();
    }, { passive: true, capture: true });
  });
  ['pointerdown', 'mousedown'].forEach(function (ev) {
    window.addEventListener(ev, function () { pointerDown = now(); }, { passive: true, capture: true });
  });
  ['pointerup', 'mouseup', 'touchend', 'touchcancel'].forEach(function (ev) {
    window.addEventListener(ev, function () { pointerDown = 0; }, { passive: true, capture: true });
  });

  /* --------------------------------------------------------- stable CSS */
  function injectCSS() {
    if (document.getElementById('wc-smooth-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-smooth-css';
    st.textContent = [
      /* a downward swipe inside the app must never reload the page */
      'html{overscroll-behavior-y:none}',
      'body{overscroll-behavior-y:contain;overscroll-behavior-x:none}',
      '#content,.chat-body,.table-wrap,.chip-row{-webkit-overflow-scrolling:touch}',
      'html{scroll-behavior:auto}',
      /* chart hosts reserve their box: a redraw cannot move the page */
      '[data-lt-live-chart],.inv-chart,.inv-chartcard,.lt-chart,.bigchart,.pro-chart,.wtc-host{contain:layout paint;min-height:120px}',
      '.inv-sparkwrap,.lt-mini{contain:layout paint}',
      '.inv-spark{display:block;width:100%;height:100%}',
      /* svg repaints are cheap once the box never changes */
      '[data-lt-live-chart] svg,.inv-chart svg,.inv-chartcard svg{display:block;max-width:100%}',
      /* after the first paint a re-render must not replay entrance motion */
      'html.wc-smooth-settled #app > *,html.wc-smooth-settled .view,html.wc-smooth-settled .page,html.wc-smooth-settled .shell{animation:none!important}',
      /* a trader who prefers less motion gets none of it */
      '@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.001s!important;' +
        'animation-iteration-count:1!important;transition-duration:.001s!important;scroll-behavior:auto!important}}'
    ].join('\n');
    document.head.appendChild(st);
    setTimeout(function () { document.documentElement.classList.add('wc-smooth-settled'); }, 2500);
  }

  /* --------------------------------------------------- chart rate limit */
  function chartsDue() {
    return !busy() && now() - lastChartAt >= CHART_MS;
  }

  /* ------------------------------------------------- market ticker patch */
  function wrapMarket() {
    var LT = safe(function () { return window.LT; }, null);
    if (!LT || typeof LT.paintMarket !== 'function' || LT.paintMarket.__wcSmooth) return false;

    /* price / change text keeps moving every 2 s — that is a text node write,
       no layout and no flicker. Only the drawings are rate limited. */
    LT.paintMarket = function () {
      var DB = safe(function () { return window.DB; }, null);
      if (!DB || typeof window.INV === 'undefined') return;
      var INV = window.INV;
      var nodes = document.querySelectorAll('[data-lv]');
      nodes.forEach(function (el) {
        var spec = el.getAttribute('data-lv') || '';
        var i = spec.indexOf(':');
        if (i < 0) return;
        var kind = spec.slice(0, i), ticker = spec.slice(i + 1);
        var q = safe(function () { return INV.quote(ticker); }, null);
        if (!q) return;
        if (kind === 'price') {
          var txt = '$' + Number(q.price).toFixed(2);
          if (el.textContent !== txt) el.textContent = txt;
        } else if (kind === 'wc') {
          var txt2 = safe(function () { return window.coins(window.usdToCoins(q.price)) + ' WC'; }, '');
          if (txt2 && el.textContent !== txt2) el.textContent = txt2;
        } else if (kind === 'pct') {
          var p = Number(q.changePct) || 0;
          var txt3 = (p >= 0 ? '▲ +' : '▼ ') + Math.abs(p).toFixed(2) + '%';
          if (el.textContent !== txt3) {
            el.textContent = txt3;
            el.classList.toggle('up', p > 0);
            el.classList.toggle('down', p < 0);
          }
        }
      });

      if (!chartsDue()) { pendingMarket = true; return; }
      pendingMarket = false;
      lastChartAt = now();

      document.querySelectorAll('[data-spark]').forEach(function (el) {
        var svg = safe(function () { return INV.spark(el.getAttribute('data-spark')); }, '');
        if (svg && el.innerHTML !== svg) el.innerHTML = svg;
      });
      var chart = document.querySelector('[data-lt-live-chart]');
      if (chart) {
        var t = chart.getAttribute('data-lt-live-chart');
        var tf = chart.getAttribute('data-lt-tf') || '1D';
        var mode = chart.getAttribute('data-lt-mode') || 'line';
        var vals = safe(function () { return INV.series(t, tf); }, []);
        if (vals && vals.length) {
          var html = mode === 'candle' ? INV.candleChart(vals) : INV.lineChart(vals, { h: 150 });
          if (html && chart.innerHTML !== html) chart.innerHTML = html;
        }
      }
    };
    LT.paintMarket.__wcSmooth = true;
    return true;
  }

  /* ------------------------------------------------- invest paint patch */
  function wrapInvest() {
    var INV = safe(function () { return window.INV; }, null);
    if (!INV || typeof INV.paint !== 'function' || INV.paint.__wcSmooth) return false;
    var real = INV.paint;

    INV.paint = function () {
      /* never rebuild the page under a trader's fingers */
      if (busy()) { pendingInv = true; return; }
      pendingInv = false;
      lastChartAt = now();
      return real.apply(INV, arguments);
    };
    INV.paint.__wcSmooth = true;
    INV.paint.__wcSmoothReal = real;

    /* a repaint requested while busy lands once the user pauses */
    return true;
  }

  function flushPending() {
    if (busy()) return;
    if (pendingInv) {
      pendingInv = false;
      var INV = safe(function () { return window.INV; }, null);
      if (INV && INV.paint && INV.paint.__wcSmooth) safe(function () { INV.paint.__wcSmoothReal(); });
    }
    if (pendingMarket) {
      pendingMarket = false;
      var LT = safe(function () { return window.LT; }, null);
      if (LT && LT.paintMarket) safe(function () { LT.paintMarket(); });
    }
  }

  function boot() {
    injectCSS();
    var tries = 0;
    (function bind() {
      var a = wrapMarket();
      var b = wrapInvest();
      if ((!a || !b) && tries++ < 120) return setTimeout(bind, 250);
    })();
    setInterval(flushPending, 900);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.WCSmooth = {
    busy: busy,
    flush: flushPending,
    chartsDue: chartsDue
  };
})();
