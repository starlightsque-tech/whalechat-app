/* =========================================================================
   WhaleChat · chart kit (wc-chart-kit)  3.66.1
   -------------------------------------------------------------------------
   ONE chart design for the whole app, taken from the reference board:

     · dark navy panel, no chrome, 18px radius
     · header: big price, WC conversion under it, % change on the right
     · segmented range control  1D 1W 1M 1Y ALL
     · Line | Candles toggle
     · the series is GREEN above the reference price and RED below it,
       with a soft gradient fill and a faint dashed baseline
     · right-hand price axis showing "$359.00 (718 WC)"
     · last price pinned in a solid pill on the axis
     · hover: crosshair + "Position value / Unrealized P&L" tooltip

   Used by:
     stock trades chart · bot trades chart · B2B investing chart
     marketplace chart  · WC investing plan chart · portfolio & ROI charts

   Public API
     WCChartKit.panelHtml(opts)          → markup (header + controls + canvas)
     WCChartKit.mount(host, opts)        → controller (renders + binds)
     WCChartKit.svg(points, opts)        → compact static chart, same skin
     WCChartKit.css()                    → inject stylesheet once
     WCChartKit.upgrade(root)            → mount every [data-wcchart]

   Data honesty: nothing is invented. With fewer than two real points the
   panel shows a dashed baseline and "Waiting for live ticks".
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcChartKit) return;
  window.__wcChartKit = true;

  var K = {};
  var C = K.colors = {
    bg: '#0c1720',
    panel: '#0d1a24',
    grid: 'rgba(255,255,255,.055)',
    axis: '#7d93a5',
    text: '#e9f4f9',
    muted: '#7d93a5',
    up: '#31e0a0',
    down: '#ff5d6c',
    upFill: 'rgba(49,224,160,.20)',
    downFill: 'rgba(255,93,108,.22)',
    baseline: 'rgba(255,255,255,.16)',
    pill: '#22d99a',
    pillText: '#04231e',
    chip: 'rgba(255,255,255,.055)',
    chipActive: '#31485c'
  };
  var RANGES = ['1D', '1W', '1M', '1Y', 'ALL'];
  var RANGE_MS = { '1D': 864e5, '1W': 6048e5, '1M': 2592e6, '1Y': 31536e6, ALL: Infinity };

  /* ---------------------------------------------------------------- utils */
  function n(v) { return Number(v) || 0; }
  function money(v, dp) {
    var d = dp == null ? 2 : dp;
    return '$' + n(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function wcTxt(v) {
    return n(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' WC';
  }
  function pct(v) { var x = n(v); return (x >= 0 ? '+' : '') + x.toFixed(2) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function css() {
    if (document.getElementById('wck-css')) return;
    var st = document.createElement('style');
    st.id = 'wck-css';
    st.textContent = [
      '.wck{background:' + C.bg + ';border:1px solid rgba(255,255,255,.07);border-radius:18px;padding:14px 14px 8px;position:relative;overflow:hidden}',
      '.wck-top{display:flex;align-items:flex-start;gap:10px}',
      '.wck-price{font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1.1;color:' + C.text + ';font-variant-numeric:tabular-nums}',
      '.wck-sub{font-size:11.5px;font-weight:600;color:' + C.muted + ';margin-top:2px;font-variant-numeric:tabular-nums}',
      '.wck-chg{margin-left:auto;font-size:12.5px;font-weight:700;color:' + C.muted + ';font-variant-numeric:tabular-nums;padding-top:4px}',
      '.wck-chg.up{color:' + C.up + '}.wck-chg.down{color:' + C.down + '}',
      '.wck-ctrls{display:flex;align-items:center;gap:8px;margin:10px 0 6px;flex-wrap:wrap}',
      '.wck-seg{display:inline-flex;background:' + C.chip + ';border-radius:11px;padding:3px;gap:2px}',
      '.wck-seg button{appearance:none;border:0;background:transparent;color:' + C.muted + ';font:inherit;font-size:11px;font-weight:800;' +
        'letter-spacing:.02em;padding:5px 9px;border-radius:8px;cursor:pointer;line-height:1;transition:background .15s,color .15s}',
      '.wck-seg button[aria-pressed="true"]{background:' + C.chipActive + ';color:#fff}',
      '.wck-seg.right{margin-left:auto}',
      '.wck-wrap{position:relative;width:100%}',
      '.wck-canvas{display:block;width:100%;touch-action:pan-y}',
      '.wck-tip{position:absolute;pointer-events:none;background:rgba(10,20,28,.96);border:1px solid rgba(255,255,255,.13);' +
        'border-radius:12px;padding:9px 11px;font-size:11px;line-height:1.45;box-shadow:0 18px 40px -20px rgba(0,0,0,.9);' +
        'opacity:0;transform:translateY(4px);transition:opacity .12s,transform .12s;z-index:5;min-width:150px}',
      '.wck-tip.on{opacity:1;transform:none}',
      '.wck-tip .r{display:flex;justify-content:space-between;gap:14px;white-space:nowrap}',
      '.wck-tip .r b{font-weight:800;color:#fff;font-variant-numeric:tabular-nums}',
      '.wck-tip .k{color:' + C.muted + ';font-weight:600}',
      '.wck-tip .r.up b{color:' + C.up + '}.wck-tip .r.down b{color:' + C.down + '}',
      '.wck-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;' +
        'color:' + C.muted + ';font-size:12px;font-weight:600;pointer-events:none}',
      '.wck-empty b{font-size:12.5px;color:#9fb3c2}',
      '@media(max-width:420px){.wck-price{font-size:22px}.wck-seg button{padding:5px 7px;font-size:10.5px}}',
      '.wck.inline{padding:0;background:transparent;border:0;border-radius:0}',
      '.wck-price.up{color:' + C.up + '}.wck-price.down{color:' + C.down + '}',
      '.wck-price{transition:color .25s ease}',
      '.wck-price.flash{animation:wckFlash .6s ease-out}',
      '@keyframes wckFlash{0%{text-shadow:0 0 16px currentColor;transform:scale(1.015)}100%{text-shadow:none;transform:none}}',
      /* legacy chart hosts adopt the same panel so nothing on the app still
         renders a white TradingView box next to a reference chart */
      '.wc-tv-host,#sharesPerfChart,.shares-chart{background:transparent;border-radius:16px;overflow:hidden}',
      '.wc-tv-host{min-height:200px}',
      '.wtc-spark,.wci-chart,.b2bm-spark,.bot-perf-svg{display:block;width:100%}',
      '.wck-spark{width:100%;height:100%}'
    ].join('\n');
    document.head.appendChild(st);
  }
  K.css = css;

  /* ------------------------------------------------------------ panel html */
  function panelHtml(opts) {
    opts = opts || {};
    var range = opts.range || '1D';
    var mode = opts.mode || 'line';
    var seg = RANGES.map(function (r) {
      return '<button type="button" data-wck-range="' + r + '" aria-pressed="' + (r === range ? 'true' : 'false') + '">' + r + '</button>';
    }).join('');
    return '' +
      '<div class="wck-top">' +
        '<div><div class="wck-price" data-wck-price>' + esc(opts.priceLabel || money(opts.price)) + '</div>' +
        '<div class="wck-sub" data-wck-sub>' + esc(opts.subLabel || wcTxt(n(opts.price) * n(opts.wcRate || 2))) + '</div></div>' +
        '<div class="wck-chg" data-wck-chg>' + esc(opts.changeLabel || pct(opts.changePct)) + '</div>' +
      '</div>' +
      '<div class="wck-ctrls">' +
        '<div class="wck-seg" data-wck-ranges>' + seg + '</div>' +
        '<div class="wck-seg right" data-wck-modes>' +
          '<button type="button" data-wck-mode="line" aria-pressed="' + (mode === 'line' ? 'true' : 'false') + '">Line</button>' +
          '<button type="button" data-wck-mode="candles" aria-pressed="' + (mode === 'candles' ? 'true' : 'false') + '">Candles</button>' +
        '</div>' +
      '</div>' +
      '<div class="wck-wrap"><canvas class="wck-canvas" data-wck-canvas></canvas>' +
      '<div class="wck-tip" data-wck-tip></div><div class="wck-empty" data-wck-empty hidden></div></div>';
  }
  K.panelHtml = panelHtml;

  /* ----------------------------------------------------------- data prep */
  function normData(data) {
    var out = [];
    (Array.isArray(data) ? data : []).forEach(function (d, i) {
      if (d == null) return;
      if (typeof d === 'number') { if (isFinite(d)) out.push({ t: i, p: d }); return; }
      var p = d.p != null ? d.p : (d.price != null ? d.price : d.value != null ? d.value : d.close);
      var t = d.t != null ? d.t : (d.time != null ? d.time : i);
      if (t instanceof Date) t = t.getTime();
      if (typeof t === 'number' && t < 1e11 && t > 1e8) t = t * 1000; /* seconds → ms */
      if (isFinite(Number(p))) out.push({ t: Number(t) || i, p: Number(p), o: d.o, h: d.h, l: d.l, c: d.c });
    });
    return out;
  }
  function windowed(pts, range) {
    if (!pts.length) return pts;
    var cut = RANGE_MS[range] || Infinity;
    if (!isFinite(cut)) return pts;
    var last = pts[pts.length - 1].t;
    var from = last - cut;
    var vis = pts.filter(function (p) { return p.t >= from; });
    return vis.length >= 2 ? vis : pts.slice(-Math.max(2, Math.min(pts.length, 24)));
  }
  /* bucket real closes into candles — aggregation of real ticks, never invented */
  function toCandles(pts, buckets) {
    if (pts.length < 2) return [];
    var want = Math.min(buckets || 42, pts.length);
    var size = Math.ceil(pts.length / want);
    var out = [];
    for (var i = 0; i < pts.length; i += size) {
      var sl = pts.slice(i, i + size);
      var vals = sl.map(function (x) { return x.p; });
      out.push({
        t: sl[0].t,
        o: sl[0].o != null ? sl[0].o : vals[0],
        c: sl[sl.length - 1].c != null ? sl[sl.length - 1].c : vals[vals.length - 1],
        h: Math.max.apply(null, vals),
        l: Math.min.apply(null, vals)
      });
    }
    return out;
  }

  function fmtTime(t, range) {
    try {
      var d = new Date(t);
      if (range === '1D') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      if (range === '1W') return d.toLocaleDateString([], { weekday: 'short' });
      if (range === '1M') return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
      return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
    } catch (e) { return ''; }
  }

  /* --------------------------------------------------------------- mount */
  function mount(host, opts) {
    if (!host) return null;
    opts = opts || {};
    css();
    var state = {
      range: opts.range || '1D',
      mode: opts.mode || 'line',
      data: normData(opts.data),
      price: n(opts.price) || (normData(opts.data).slice(-1)[0] || {}).p || 0,
      wcRate: n(opts.wcRate) || 2,
      changePct: opts.changePct,
      decimals: opts.decimals,
      lines: Array.isArray(opts.lines) ? opts.lines.slice() : [],
      lastDir: 0,
      symbol: opts.symbol || '',
      baselineOverride: opts.baseline != null ? n(opts.baseline) : null
    };
    var dp = state.decimals == null ? 2 : state.decimals;
    var hover = null;
    var raf = 0;

    host.classList.add('wck');
    if (opts.inline) host.classList.add('inline');
    host.innerHTML = panelHtml({
      range: state.range, mode: state.mode,
      price: state.price, wcRate: state.wcRate,
      changePct: state.changePct,
      priceLabel: opts.priceLabel, subLabel: opts.subLabel, changeLabel: opts.changeLabel
    });

    var canvas = host.querySelector('[data-wck-canvas]');
    var tip = host.querySelector('[data-wck-tip]');
    var empty = host.querySelector('[data-wck-empty]');
    var priceEl = host.querySelector('[data-wck-price]');
    var subEl = host.querySelector('[data-wck-sub]');
    var chgEl = host.querySelector('[data-wck-chg]');
    var H = opts.height || 230;

    function visible() { return windowed(state.data, state.range); }

    var shown = 0, tween = 0;
    function paintHeader() {
      var last = state.data.length ? state.data[state.data.length - 1].p : state.price;
      var first = (visible()[0] || {}).p;
      var ch = state.changePct;
      if (ch == null && first > 0 && last > 0) ch = ((last - first) / first) * 100;
      var target = last || state.price;
      animatePrice(target);
      subEl.textContent = wcTxt(target * state.wcRate);
      chgEl.textContent = pct(ch || 0);
      chgEl.className = 'wck-chg ' + ((ch || 0) >= 0 ? 'up' : 'down');
    }
    /* the price counts to its new value and flashes green/red with the tick */
    function animatePrice(target) {
      var from = shown || target;
      var up = target > from;
      var flat = Math.abs(target - from) < 1e-9;
      shown = target;
      try {
        priceEl.classList.remove('up', 'down', 'flash');
        if (!flat) {
          priceEl.classList.add(up ? 'up' : 'down');
          void priceEl.offsetWidth;
          priceEl.classList.add('flash');
          setTimeout(function () { try { priceEl.classList.remove('flash'); } catch (e) {} }, 620);
        }
      } catch (e) {}
      if (tween) cancelAnimationFrame(tween);
      if (flat) { priceEl.textContent = money(target, dp); return; }
      var t0 = performance.now(), dur = 320;
      function step(now) {
        var k = Math.min(1, (now - t0) / dur);
        var ease = 1 - Math.pow(1 - k, 3);
        priceEl.textContent = money(from + (target - from) * ease, dp);
        if (k < 1) tween = requestAnimationFrame(step);
        else { priceEl.textContent = money(target, dp); tween = 0; }
      }
      tween = requestAnimationFrame(step);
    }

    function draw() {
      raf = 0;
      var dpr = window.devicePixelRatio || 1;
      var W = Math.max(220, canvas.clientWidth || host.clientWidth || 320);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.height = H + 'px';
      var g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);

      var axisW = 86;
      var plotW = W - axisW;
      var top = 15, bottom = 27;
      var plotH = H - top - bottom;

      var vis = visible();
      empty.hidden = vis.length >= 2;
      if (vis.length < 2) {
        empty.innerHTML = '<b>Waiting for live ticks</b><span>' + esc(opts.emptyHint || 'The feed reconnects automatically') + '</span>';
      }

      var candles = state.mode === 'candles' ? toCandles(vis, 42) : [];
      var vals = vis.map(function (p) { return p.p; });
      var lo, hi;
      if (state.mode === 'candles' && candles.length) {
        lo = Math.min.apply(null, candles.map(function (c) { return c.l; }));
        hi = Math.max.apply(null, candles.map(function (c) { return c.h; }));
      } else {
        lo = Math.min.apply(null, vals);
        hi = Math.max.apply(null, vals);
      }
      /* the trade rails must always be on screen: a user watching their entry
         and live price cannot have either pushed out of the visible band */
      if (Array.isArray(state.lines)) {
        state.lines.forEach(function (ln) {
          var pv = n(ln && ln.price);
          if (pv > 0) { if (pv < lo) lo = pv; if (pv > hi) hi = pv; }
        });
      }
      if (n(state.price) > 0) { if (state.price < lo) lo = n(state.price); if (state.price > hi) hi = n(state.price); }
      var ref = state.baselineOverride != null ? state.baselineOverride
        : (vis.length ? vis[0].p : state.price);
      if (!isFinite(lo) || !isFinite(hi)) { lo = state.price || 0; hi = (state.price || 1) + 1; }
      var padY = (hi - lo) * 0.18 || Math.abs(hi || 1) * 0.01 || 1;
      lo -= padY; hi += padY;
      if (ref < lo) lo = ref - padY * 0.2;
      if (ref > hi) hi = ref + padY * 0.2;
      var span = (hi - lo) || 1;
      var sx = function (i, len) { return (len <= 1 ? 0 : (i / (len - 1)) * plotW); };
      var sy = function (v) { return top + (1 - ((v - lo) / span)) * plotH; };

      /* vertical grid + time labels */
      var ticks = 3;
      g.font = '10px system-ui,-apple-system,sans-serif';
      g.textBaseline = 'top';
      for (var i = 0; i <= ticks; i++) {
        var x = (plotW / ticks) * i;
        g.strokeStyle = C.grid; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + plotH); g.stroke();
        if (vis.length) {
          var idx = Math.min(vis.length - 1, Math.round((i / ticks) * (vis.length - 1)));
          g.fillStyle = C.axis;
          var lbl = fmtTime(vis[idx].t, state.range);
          var tw = g.measureText(lbl).width;
          var tx = Math.min(Math.max(2, x - tw / 2), plotW - tw);
          g.fillText(lbl, tx, top + plotH + 5);
        }
      }

      /* dashed baseline */
      if (ref > lo && ref < hi) {
        g.save(); g.setLineDash([4, 5]);
        g.strokeStyle = C.baseline; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, sy(ref)); g.lineTo(plotW, sy(ref)); g.stroke();
        g.restore();
      }

      if (vis.length >= 2 && state.mode !== 'candles') {
        /* split the line at the reference: green above, red below */
        var pts = vis.map(function (p, i) { return { x: sx(i, vis.length), y: sy(p.p), v: p.p }; });
        /* fills */
        drawSplitFill(g, pts, ref, sy, plotW, top + plotH);
        drawSplitLine(g, pts, ref, 1.7);
        /* last point marker */
        var lastP = pts[pts.length - 1];
        g.fillStyle = lastP.v >= ref ? C.up : C.down;
        g.beginPath(); g.arc(lastP.x, lastP.y, 2.6, 0, Math.PI * 2); g.fill();
      } else if (candles.length) {
        var cw = Math.max(2, (plotW / candles.length) * 0.62);
        candles.forEach(function (c, i) {
          var x = sx(i, candles.length) + (plotW / candles.length) / 2;
          var up = c.c >= c.o;
          g.strokeStyle = up ? C.up : C.down;
          g.fillStyle = up ? C.up : C.down;
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(x, sy(c.h)); g.lineTo(x, sy(c.l)); g.stroke();
          var y1 = sy(Math.max(c.o, c.c)), y2 = sy(Math.min(c.o, c.c));
          g.fillRect(x - cw / 2, y1, cw, Math.max(1, y2 - y1));
        });
      }

      /* right axis labels — "$359.00 (718 WC)" */
      var rows = 4;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      for (var r = 0; r <= rows; r++) {
        var v = hi - (span / rows) * r;
        var y = top + (plotH / rows) * r;
        g.fillStyle = C.axis;
        g.font = '10px system-ui,-apple-system,sans-serif';
        g.fillText(money(v, dp), plotW + 9, y - 5);
        g.fillStyle = 'rgba(125,147,165,.62)';
        g.font = '9px system-ui,-apple-system,sans-serif';
        g.fillText('(' + Math.round(v * state.wcRate) + ' WC)', plotW + 9, y + 6);
      }

      /* entry / take-profit / stop-loss price lines */
      if (state.lines && state.lines.length) {
        state.lines.forEach(function (ln) {
          var pv = n(ln.price);
          if (!(pv > 0) || pv < lo || pv > hi) return;
          var y = sy(pv);
          g.save();
          if (ln.solid) g.setLineDash([]); else g.setLineDash([5, 4]);
          g.strokeStyle = ln.color || 'rgba(96,165,250,.85)';
          g.lineWidth = ln.solid ? (ln.live ? 1.7 : 1.4) : 1.2;
          g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke();
          /* a live price rail also gets a small marker at the right edge */
          if (ln.live) {
            g.fillStyle = ln.color;
            g.beginPath(); g.arc(plotW, y, 3, 0, Math.PI * 2); g.fill();
          }
          g.restore();
          if (ln.title) {
            g.font = '700 9.5px system-ui,-apple-system,sans-serif';
            g.textBaseline = 'middle';
            var tw2 = g.measureText(ln.title).width + 12;
            g.fillStyle = 'rgba(8,18,26,.88)';
            roundRect(g, 4, y - 8, Math.min(tw2, plotW - 8), 16, 4);
            g.fill();
            g.fillStyle = ln.color || '#60a5fa';
            g.fillText(ln.title, 9, y);
          }
        });
      }

      /* last-price pill on the axis */
      var lp = vis.length ? vis[vis.length - 1].p : state.price;
      if (lp > 0) {
        var py = Math.min(top + plotH - 9, Math.max(top + 9, sy(lp)));
        var label = money(lp, dp);
        g.font = '700 10.5px system-ui,-apple-system,sans-serif';
        var lw = g.measureText(label).width + 14;
        var up = lp >= ref;
        g.fillStyle = up ? C.pill : '#ff6b78';
        roundRect(g, plotW + 4, py - 9, Math.min(lw, axisW - 6), 18, 5);
        g.fill();
        g.fillStyle = '#04231e';
        g.textBaseline = 'middle';
        g.fillText(label, plotW + 11, py);
      }

      /* crosshair */
      if (hover && vis.length >= 2) {
        var hx = sx(hover.i, vis.length);
        g.save(); g.setLineDash([3, 3]);
        g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(hx, top); g.lineTo(hx, top + plotH); g.stroke();
        g.restore();
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(hx, sy(vis[hover.i].p), 3, 0, Math.PI * 2); g.fill();
      }
    }

    function roundRect(g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }

    /* area fill split at the reference price */
    function drawSplitFill(g, pts, ref, sy, plotW, baseY) {
      var uid = 'wckg' + Math.random().toString(36).slice(2, 7);
      /* clip above the baseline → green */
      g.save();
      g.beginPath();
      g.rect(0, 0, plotW, sy(ref));
      g.clip();
      var gr = g.createLinearGradient(0, 0, 0, sy(ref));
      gr.addColorStop(0, C.upFill);
      gr.addColorStop(1, 'rgba(49,224,160,0.02)');
      areaPath(g, pts, plotW, baseY);
      g.fillStyle = gr; g.fill();
      g.restore();

      /* clip below → red */
      g.save();
      g.beginPath();
      g.rect(0, sy(ref), plotW, baseY - sy(ref));
      g.clip();
      var gr2 = g.createLinearGradient(0, sy(ref), 0, baseY);
      gr2.addColorStop(0, 'rgba(255,93,108,0.02)');
      gr2.addColorStop(1, C.downFill);
      areaPath(g, pts, plotW, baseY);
      g.fillStyle = gr2; g.fill();
      g.restore();
    }
    function areaPath(g, pts, plotW, baseY) {
      g.beginPath();
      g.moveTo(pts[0].x, baseY);
      pts.forEach(function (p) { g.lineTo(p.x, p.y); });
      g.lineTo(pts[pts.length - 1].x, baseY);
      g.closePath();
    }
    /* line stroked in green above ref / red below, split at crossings */
    function drawSplitLine(g, pts, ref, w) {
      g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round';
      var segs = [];
      for (var i = 1; i < pts.length; i++) {
        var a = pts[i - 1], b = pts[i];
        var aUp = a.v >= ref, bUp = b.v >= ref;
        if (aUp === bUp) { segs.push({ a: a, b: b, up: aUp }); continue; }
        /* crossing: interpolate the exact crossing point */
        var t = (ref - a.v) / ((b.v - a.v) || 1);
        var cx = a.x + (b.x - a.x) * t, cy = a.y + (b.y - a.y) * t;
        segs.push({ a: a, b: { x: cx, y: cy, v: ref }, up: aUp });
        segs.push({ a: { x: cx, y: cy, v: ref }, b: b, up: bUp });
      }
      g.save();
      g.shadowColor = 'rgba(49,224,160,.38)';
      g.shadowBlur = 7;
      segs.forEach(function (s) {
        var rising = (s.b.v >= s.a.v);
        g.shadowColor = rising ? 'rgba(49,224,160,.45)' : 'rgba(255,93,108,.4)';
        g.strokeStyle = rising ? C.up : C.down;
        g.beginPath(); g.moveTo(s.a.x, s.a.y); g.lineTo(s.b.x, s.b.y); g.stroke();
      });
      g.restore();
    }

    function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

    /* ------------------------------------------------------------ events */
    function onRange(r) {
      state.range = r;
      host.querySelectorAll('[data-wck-range]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-wck-range') === r ? 'true' : 'false');
      });
      hover = null; tip.classList.remove('on');
      paintHeader(); draw();
      if (typeof opts.onRange === 'function') opts.onRange(r);
    }
    function onMode(m) {
      state.mode = m;
      host.querySelectorAll('[data-wck-mode]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-wck-mode') === m ? 'true' : 'false');
      });
      draw();
      if (typeof opts.onMode === 'function') opts.onMode(m);
    }
    host.querySelectorAll('[data-wck-range]').forEach(function (b) {
      b.addEventListener('click', function () { onRange(b.getAttribute('data-wck-range')); });
    });
    host.querySelectorAll('[data-wck-mode]').forEach(function (b) {
      b.addEventListener('click', function () { onMode(b.getAttribute('data-wck-mode')); });
    });

    function onMove(ev) {
      var vis = visible();
      if (vis.length < 2) return;
      var rect = canvas.getBoundingClientRect();
      var x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      var plotW = Math.max(120, rect.width - 86);
      var idx = Math.max(0, Math.min(vis.length - 1, Math.round((x / plotW) * (vis.length - 1))));
      hover = { i: idx };
      var p = vis[idx];
      var units = n(opts.position && opts.position.units);
      var cost = n(opts.position && opts.position.cost);
      var rows = [];
      if (units > 0) {
        var val = units * p.p;
        var pnl = val - cost;
        rows.push('<div class="r"><span class="k">Position value</span><b>' + money(val) + ' (' + wcTxt(val * state.wcRate) + ')</b></div>');
        rows.push('<div class="r ' + (pnl >= 0 ? 'up' : 'down') + '"><span class="k">Unrealized P&amp;L</span><b>' +
          (pnl >= 0 ? '+' : '-') + money(Math.abs(pnl)) + ' (' + (pnl >= 0 ? '+' : '-') + wcTxt(Math.abs(pnl) * state.wcRate) + ')</b></div>');
      } else {
        var base = vis[0].p || p.p;
        var ch = ((p.p - base) / (base || 1)) * 100;
        rows.push('<div class="r"><span class="k">Price</span><b>' + money(p.p, dp) + ' (' + wcTxt(p.p * state.wcRate) + ')</b></div>');
        rows.push('<div class="r ' + (ch >= 0 ? 'up' : 'down') + '"><span class="k">Change</span><b>' + pct(ch) + '</b></div>');
      }
      tip.innerHTML = rows.join('');
      tip.classList.add('on');
      var tw = tip.offsetWidth || 160;
      var axisGap = 92;
      var roomRight = (rect.width || 300) - axisGap;
      /* keep the tooltip off the price axis: flip it left of the crosshair */
      var left = (x + 14 + tw > roomRight) ? (x - tw - 14) : (x + 14);
      tip.style.left = Math.max(4, Math.min(left, roomRight - tw - 4)) + 'px';
      tip.style.top = '10px';
      schedule();
    }
    function onLeave() { hover = null; tip.classList.remove('on'); schedule(); }

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('touchmove', onMove, { passive: true });
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('touchend', onLeave);

    var ro = null;
    try {
      if (window.ResizeObserver) { ro = new ResizeObserver(schedule); ro.observe(host); }
    } catch (e) {}

    paintHeader(); schedule();

    var api = {
      setData: function (data, price) {
        state.data = normData(data);
        if (price != null) state.price = n(price);
        paintHeader(); schedule();
        return api;
      },
      push: function (point) { return api.update(point); },
      update: function (point) {
        var d = normData([point])[0];
        if (!d) return api;
        state.data.push(d);
        if (state.data.length > 4000) state.data = state.data.slice(-3000);
        paintHeader(); schedule();
        return api;
      },
      setPrice: function (p, changePct) {
        state.price = n(p);
        if (changePct != null) state.changePct = changePct;
        paintHeader(); schedule();
        return api;
      },
      setRange: onRange,
      setMode: onMode,
      setLines: function (lines) { state.lines = Array.isArray(lines) ? lines.slice() : []; schedule(); return api; },
      setBaseline: function (v) { state.baselineOverride = (v != null && n(v) > 0) ? n(v) : null; paintHeader(); schedule(); return api; },
      setSymbol: function (sym) { state.symbol = String(sym || ''); return api; },
      setPositions: function (list) {
        var p0 = (list && list[0]) || null;
        opts.position = p0 ? { units: n(p0.qty || p0.quantity || 1), cost: n(p0.entry) * n(p0.qty || p0.quantity || 1) } : null;
        return api;
      },
      points: function () { return state.data.length; },
      /* one paint per tick: append the point, move the price, keep the colour */
      tick: function (px, changePct) {
        var v = Number(px);
        if (!(v > 0)) return api;
        state.data.push({ t: Date.now(), p: v });
        if (state.data.length > 4000) state.data = state.data.slice(-3000);
        state.price = v;
        if (changePct != null) state.changePct = Number(changePct);
        paintHeader(); schedule();
        return api;
      },
      destroy: function () {
        try { if (ro) ro.disconnect(); } catch (e) {}
        canvas.removeEventListener('mousemove', onMove);
        canvas.removeEventListener('touchmove', onMove);
        canvas.removeEventListener('mouseleave', onLeave);
        canvas.removeEventListener('touchend', onLeave);
        host.innerHTML = '';
        unregister(api);
        try { delete host.__wck; } catch (e) { host.__wck = null; }
      },
      root: host,
      __kitoken: 'k' + Math.random().toString(36).slice(2, 8),
      __symbol: String(opts.symbol || '').toUpperCase()
    };
    register(api, opts);
    return api;
  }
  /* ---- live registry: real-time ticks colour every mounted chart --------- */
  var REG = window.__wcKitRegistry || (window.__wcKitRegistry = {});
  function register(api, opts) {
    var sym = String((opts && opts.symbol) || '').toUpperCase();
    if (!sym) return;
    REG[sym] = REG[sym] || [];
    REG[sym].push(api);
    if (REG[sym].length > 8) REG[sym].shift();
  }
  function unregister(api) {
    Object.keys(REG).forEach(function (k) {
      REG[k] = (REG[k] || []).filter(function (a) { return a !== api; });
    });
  }
  /* K.tick(symbol, price, changePct) — called from the market feed on every
     real quote so charts move and recolour in real time, not on a repaint. */
  K.tick = function (symbol, price, changePct) {
    var sym = String(symbol || '').toUpperCase();
    var px = Number(price);
    if (!(px > 0)) return 0;
    var list = REG[sym];
    if (!list || !list.length) return 0;
    var n = 0;
    list.forEach(function (api) {
      try {
        var host = api.root;
        if (!host || !document.body.contains(host)) return;
        if (api.tick) api.tick(px, changePct);
        else { api.push({ t: Date.now(), p: px }); api.setPrice(px, changePct); }
        n++;
      } catch (e) {}
    });
    return n;
  };
  /* also listen for the app-wide tick event so no extra wiring is needed */
  try {
    document.addEventListener('wc:tick', function (ev) {
      var d = (ev && ev.detail) || {};
      K.tick(d.symbol, d.price, d.changePct);
    });
  } catch (e) {}

  K.mount = mount;

  /* -------------------------------------------------- compact static chart */
  /* Same skin, no controls — for list rows, cards and the portfolio strip. */
  K.svg = function (points, opts) {
    opts = opts || {};
    var W = opts.width || 320, H = opts.height || 88, pad = 2;
    var pts = normData(points);
    if (pts.length < 2) {
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="wtc-spark wck-spark" preserveAspectRatio="none" aria-label="no chart data">' +
        '<line x1="0" y1="' + (H / 2) + '" x2="' + W + '" y2="' + (H / 2) + '" stroke="' + C.grid + '" stroke-dasharray="3 4"/></svg>';
    }
    var vals = pts.map(function (p) { return p.p; });
    var ref = opts.baseline != null ? n(opts.baseline) : vals[0];
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var padY = (hi - lo) * 0.15 || Math.abs(hi || 1) * 0.01 || 1;
    lo -= padY; hi += padY;
    if (ref < lo) lo = ref - padY * 0.3;
    if (ref > hi) hi = ref + padY * 0.3;
    var span = (hi - lo) || 1;
    var sx = function (i) { return pad + (i / (pts.length - 1)) * (W - pad * 2); };
    var sy = function (v) { return H - pad - ((v - lo) / span) * (H - pad * 2); };
    var xy = pts.map(function (p, i) { return { x: sx(i), y: sy(p.p), v: p.p }; });
    var uid = 'wcks' + Math.random().toString(36).slice(2, 8);
    var line = 'M ' + xy.map(function (p) { return p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' L ');
    var area = line + ' L ' + xy[xy.length - 1].x.toFixed(1) + ' ' + H + ' L ' + xy[0].x.toFixed(1) + ' ' + H + ' Z';
    var segs = '';
    for (var i = 1; i < xy.length; i++) {
      var a = xy[i - 1], b = xy[i];
      var up = b.v >= ref;
      segs += '<path d="M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) + ' L ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1) +
        '" stroke="' + (up ? C.up : C.down) + '" stroke-width="' + (opts.weight || 1.9) + '" fill="none" stroke-linecap="round"/>';
    }
    var refY = sy(ref);
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="wtc-spark wck-spark" preserveAspectRatio="none" role="img" aria-label="price chart">' +
      '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + C.up + '" stop-opacity="' + (opts.fill == null ? 0.26 : opts.fill) + '"/>' +
      '<stop offset="100%" stop-color="' + C.up + '" stop-opacity="0"/></linearGradient></defs>' +
      (opts.fill === 0 ? '' : '<path d="' + area + '" fill="url(#' + uid + ')" stroke="none"/>') +
      (opts.baseline === 0 ? '' : '<line x1="0" y1="' + refY.toFixed(1) + '" x2="' + W + '" y2="' + refY.toFixed(1) +
        '" stroke="' + C.baseline + '" stroke-width="1" stroke-dasharray="3 4"/>') +
      segs + '</svg>';
  };

  /* ---------------------------------------------------------- auto panel */
  /* Any module can emit a panel without holding a controller: give it
     data-wck-auto='<json opts>' and the kit mounts (and re-mounts after any
     re-render that wipes the canvas). This is what keeps the reference
     chart on screens whose surrounding card repaints every couple of
     seconds. */
  K.autoHtml = function (opts, extraClass) {
    var json = JSON.stringify(opts || {})
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    return '<div class="wck ' + (extraClass || '') + '" data-wck-auto="' + json + '"></div>';
  };

  function autoUpgrade() {
    try {
      document.querySelectorAll('[data-wck-auto]').forEach(function (el) {
        if (el.querySelector('.wck-canvas')) return;
        var raw = el.getAttribute('data-wck-auto') || '{}';
        var opts;
        try { opts = JSON.parse(raw); } catch (e) { return; }
        try { mount(el, opts); } catch (e) {}
      });
    } catch (e) {}
  }
  K.autoUpgrade = autoUpgrade;

  /* ------------------------------------------------------------- upgrade */
  K.upgrade = function (root) {
    (root || document).querySelectorAll('[data-wcchart]').forEach(function (el) {
      if (el.__wck && el.querySelector('.wck-canvas')) return;
      var data = [];
      try { data = JSON.parse(el.getAttribute('data-wcchart') || '[]'); } catch (e) {}
      el.__wck = mount(el, {
        data: data,
        price: n(el.getAttribute('data-wck-price')) || undefined,
        wcRate: n(el.getAttribute('data-wck-wcrate')) || 2,
        height: n(el.getAttribute('data-wck-height')) || 230,
        range: el.getAttribute('data-wck-range') || '1D'
      });
    });
  };

  if (document.readyState !== 'loading') setTimeout(autoUpgrade, 300);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(autoUpgrade, 300); });
  setInterval(autoUpgrade, 900);

  window.WCChartKit = K;
})();
