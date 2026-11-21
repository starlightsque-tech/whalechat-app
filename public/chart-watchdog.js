/* =========================================================================
   WhaleChat chart watchdog  (wc-chart-watchdog)

   Some networks block the chart CDN. When the library never arrives the
   chart hosts stay blank, which is exactly the empty box users reported on
   the stock and portfolio screens. This watchdog checks each live chart host
   and, if no chart has drawn after a few seconds, renders a lightweight SVG
   that follows the same live quotes — so price and movement are always
   visible and always moving.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcChartWatchdog) return;
  window.__wcChartWatchdog = true;

  var seen = new WeakMap();

  function money(v) { return '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function hostTicker(host) {
    var t = host.getAttribute('data-lt-live-chart') || (host.getAttribute('data-chart') || '').split('|')[0];
    if (!t) { try { t = (typeof currentTicker === 'function') ? currentTicker() : ''; } catch (e) { t = ''; } }
    return String(t || '').toUpperCase();
  }

  function priceOf(ticker) {
    try {
      var q = INV.quote(ticker);
      if (q && Number(q.price) > 0) return Number(q.price);
    } catch (e) {}
    try { var s = INV.stock(ticker); if (s && Number(s.price) > 0) return Number(s.price); } catch (e) {}
    return 0;
  }

  function draw(host, st) {
    var W = 320, H = 132, padL = 6, padR = 54, padT = 10, padB = 16;
    var vals = st.values;
    if (vals.length < 2) {
      var p = priceOf(st.ticker);
      vals = [p, p];
      st.values = vals;
    }
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max - min < 0.0001) { max += Math.max(0.01, max * 0.001); min -= Math.max(0.01, max * 0.001); }
    var pad = (max - min) * 0.12; max += pad; min -= pad;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var x = function (i) { return padL + (i / (vals.length - 1)) * innerW; };
    var y = function (v) { return padT + innerH - ((v - min) / (max - min)) * innerH; };
    var line = vals.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
    var area = line + ' L' + x(vals.length - 1).toFixed(1) + ' ' + (padT + innerH) + ' L' + padL + ' ' + (padT + innerH) + ' Z';
    var up = vals[vals.length - 1] >= vals[0];
    var color = up ? '#2ee6c9' : '#ff5d7a';
    var gid = 'wcwg' + Math.random().toString(36).slice(2, 7);
    var last = vals[vals.length - 1];
    var first = vals[0];
    var chg = first ? ((last / first - 1) * 100) : 0;
    host.innerHTML =
      '<div style="position:relative;background:#07090e;border:1px solid rgba(46,230,201,.16);border-radius:14px;padding:8px 8px 4px">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:0 4px 4px">' +
          '<b style="font-size:15px;color:#e9f4f9">' + esc(st.ticker === '__PORTFOLIO__' ? 'Portfolio value' : st.ticker) + '</b>' +
          '<span style="font-size:13px;font-weight:700;color:' + color + '">' + money(last) + ' <small>' + (chg >= 0 ? '+' : '−') + Math.abs(chg).toFixed(2) + '%</small></span>' +
        '</div>' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:130px;display:block">' +
          '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity=".32"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
          '<line x1="' + padL + '" y1="' + (padT + innerH / 2) + '" x2="' + (W - padR) + '" y2="' + (padT + innerH / 2) + '" stroke="rgba(255,255,255,.06)"/>' +
          '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
          '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<circle cx="' + x(vals.length - 1).toFixed(1) + '" cy="' + y(last).toFixed(1) + '" r="3" fill="' + color + '"><animate attributeName="r" values="3;4.6;3" dur="1.5s" repeatCount="indefinite"/></circle>' +
          '<text x="' + (W - padR + 4) + '" y="' + (padT + 8) + '" fill="#6f7a8d" font-size="9">' + money(max) + '</text>' +
          '<text x="' + (W - padR + 4) + '" y="' + (padT + innerH) + '" fill="#6f7a8d" font-size="9">' + money(min) + '</text>' +
        '</svg>' +
        '<div style="display:flex;justify-content:space-between;font-size:9px;color:#6f7a8d;padding:2px 4px 0"><span>LIVE FEED</span><span>' + vals.length + ' ticks</span></div>' +
      '</div>';
  }

  function needsFallback(host) {
    if (!host) return false;
    if (host.querySelector('canvas')) return false;       /* real chart is drawing */
    if (host.querySelector('.wcpl')) return false;         /* perf chart module owns it */
    if (host.querySelector('svg polyline, svg path')) return false;
    var txt = (host.textContent || '').trim();
    if (/could not load|failed|chart could not/i.test(txt)) return true;
    if (!txt) return true;
    if (/loading live chart/i.test(txt)) return true;
    return false;
  }

  function tick() {
    try {
      if (typeof INV === 'undefined' || typeof DB === 'undefined' || !DB) return;
      var hosts = Array.prototype.slice.call(document.querySelectorAll('.inv-chart[data-lt-live-chart], .inv-chart[data-chart], #ltDashChart'));
      hosts.forEach(function (host) {
        if (!document.body.contains(host)) return;
        var isPf = host.id === 'ltDashChart' || /__portfolio__/i.test(host.getAttribute('data-chart') || '');
        var ticker = isPf ? '__PORTFOLIO__' : hostTicker(host);
        if (!ticker) return;
        var st = seen.get(host);
        if (!st || st.ticker !== ticker) {
          st = { ticker: ticker, values: [], drew: false, checks: 0 };
          seen.set(host, st);
        }
        if (!needsFallback(host)) { st.drew = true; st.values = []; return; }
        st.checks++;
        if (st.checks < 2) return;                          /* give the CDN a moment */
        var price = 0;
        if (isPf) {
          try { price = Number(LT.summary(me().id).valueUsd) || 0; } catch (e) { price = 0; }
        } else {
          price = priceOf(ticker);
        }
        if (!(price > 0)) return;
        st.values.push(price);
        if (st.values.length > 90) st.values = st.values.slice(-90);
        draw(host, st);
      });
    } catch (e) {}
  }

  setInterval(tick, 2000);
  window.addEventListener('hashchange', function () { setTimeout(tick, 900); });
})();
