/* =========================================================================
   WhaleChat Trade Chart — professional TradingView-style chart engine
   -------------------------------------------------------------------------
   ONE renderer for all four investment surfaces:
     · Stock trading account     (#/invest)
     · Bot trading account       (#/invest/bots)
     · WC-Investing account      (#/invest/shares)
     · B2B-Investing account     (#/investment/b2b)

   Behaviour (as specified):
     · price moving UP   -> the drawn line/segment is GREEN
     · price moving DOWN -> the drawn line/segment is RED
     · open trade in profit -> P&L green, in loss -> P&L red

   Two entry points:
     WC_TRADE_CHART.svg(values, opts)   -> direction-coloured SVG string
                                           (for cards / inline sparklines)
     WC_TRADE_CHART.mount(host, opts)   -> full interactive chart
                                           returns { setData, update, setLines,
                                                     setBaseline, setSymbol,
                                                     setMode, destroy, el }

   No dependencies, no CDN, no build-time library. Pure SVG + DOM.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;

  var TC = (window.WC_TRADE_CHART = window.WC_TRADE_CHART || {});
  if (TC.__v >= 1) return;
  TC.__v = 1;
  TC.version = '1.0.0';

  /* ------------------------------------------------------------------ theme */
  var UP = '#22c55e';
  var DOWN = '#ef4444';
  var UP_A = 'rgba(34,197,94,';
  var DOWN_A = 'rgba(239,68,68,';
  var GRID = 'rgba(255,255,255,.055)';
  var AXIS = 'rgba(255,255,255,.10)';
  var TEXT = '#e9f4f9';
  var MUTED = '#8ba4b6';
  var ENTRY = '#60a5fa';

  var TFS = ['1D', '1W', '1M', '1Y', 'ALL'];
  var TF_FRAC = { '1D': 0.12, '1W': 0.3, '1M': 0.5, '1Y': 0.8, 'ALL': 1 };
  var TF_SECONDS = { '1D': 864e2, '1W': 6048e2, '1M': 2592e3, '1Y': 31536e3, 'ALL': 63072e3 };

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : NaN; };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var usd = function (v, d) {
    var n = Number(v) || 0;
    var dg = d == null ? (Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 2 : 4) : d;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg });
  };
  var signed = function (v, d) { return (v < 0 ? '−' : '+') + usd(Math.abs(v), d); };

  function hhmm(sec) {
    var d = new Date(sec * 1000);
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function dayLabel(sec, tf) {
    var d = new Date(sec * 1000);
    if (tf === '1D') return hhmm(sec);
    if (tf === '1Y' || tf === 'ALL') {
      return d.toLocaleDateString('en-US', { month: 'short' }) + ' ' + String(d.getFullYear()).slice(2);
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fullLabel(sec, tf) {
    var d = new Date(sec * 1000);
    if (tf === '1D') return hhmm(sec) + ':' + (d.getSeconds() < 10 ? '0' : '') + d.getSeconds();
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /* ------------------------------------------------------------- data utils */
  /* Accepts [{time,value}], [{t,p}], [{time,close}], [[sec,price]], [price]  */
  function normalise(input) {
    if (!Array.isArray(input)) return [];
    var out = [];
    for (var i = 0; i < input.length; i++) {
      var row = input[i];
      var t = NaN, v = NaN;
      if (typeof row === 'number') { v = row; }
      else if (Array.isArray(row)) { t = num(row[0]); v = num(row[1]); }
      else if (row && typeof row === 'object') {
        v = num(row.value != null ? row.value : (row.c != null ? row.c : (row.close != null ? row.close : row.price)));
        t = num(row.time != null ? row.time : (row.t != null ? row.t : row.timestamp));
      }
      if (!isFinite(v)) continue;
      if (!isFinite(t)) t = out.length ? out[out.length - 1].time + 60 : Math.floor(Date.now() / 1000) - 60 * 60;
      if (t > 1e11) t = Math.floor(t / 1000);
      out.push({ time: t, value: v });
    }
    out.sort(function (a, b) { return a.time - b.time; });
    /* drop duplicate timestamps, keep the last value for a second */
    var dedup = [];
    for (var j = 0; j < out.length; j++) {
      if (dedup.length && dedup[dedup.length - 1].time === out[j].time) dedup[dedup.length - 1] = out[j];
      else dedup.push(out[j]);
    }
    return dedup;
  }

  /* keep the visual point count sane: <= n points, always keeping the last */
  function downsample(points, n) {
    if (points.length <= n) return points;
    var step = points.length / n;
    var out = [];
    for (var i = 0; i < n; i++) out.push(points[Math.min(points.length - 1, Math.floor(i * step))]);
    out[out.length - 1] = points[points.length - 1];
    return out;
  }

  function visible(points, tf) {
    if (!points.length) return [];
    var frac = TF_FRAC[tf] == null ? 1 : TF_FRAC[tf];
    var take = Math.max(2, Math.round(points.length * frac));
    return points.slice(-take);
  }

  /* line data -> OHLC buckets, so Candles mode works on a close-only feed */
  function toCandles(points, target) {
    if (!points.length) return [];
    var k = Math.max(1, Math.ceil(points.length / (target || 46)));
    var out = [];
    for (var i = 0; i < points.length; i += k) {
      var slice = points.slice(i, i + k);
      if (!slice.length) continue;
      var o = slice[0].value, c = slice[slice.length - 1].value;
      var hi = o, lo = o;
      for (var j = 0; j < slice.length; j++) {
        if (slice[j].value > hi) hi = slice[j].value;
        if (slice[j].value < lo) lo = slice[j].value;
      }
      out.push({ time: slice[slice.length - 1].time, o: o, h: hi, l: lo, c: c });
    }
    return out;
  }

  /* --------------------------------------------------- direction-colour legs */
  function legsOf(pts) {
    var legs = [];
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      legs.push({
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        up: b.p >= a.p
      });
    }
    return legs;
  }

  /* --------------------------------------------------- static SVG sparkline */
  /* Direction-coloured, gradient-filled. Used by WC-Investing, bots and B2B
     cards where the app already renders an inline chart string.            */
  TC.svg = function (values, opts) {
    opts = opts || {};
    /* 3.66.1: every compact chart (WC investing plans, ROI progress, portfolio
       strips, B2B cards) renders through the shared chart kit so the whole app
       uses the reference design: green above the baseline, red below, soft
       gradient fill, dashed reference line. */
    try {
      if (window.WCChartKit && WCChartKit.svg) {
        return WCChartKit.svg(values, {
          width: opts.width || 320,
          height: opts.height || 88,
          weight: opts.weight || 1.9,
          fill: opts.fill,
          baseline: opts.baseline
        }).replace('class="wtc-spark wck-spark"', 'class="wtc-spark wck-spark wci-chart"');
      }
    } catch (e) {}
    var W = opts.width || 320;
    var H = opts.height || 88;
    var pad = opts.pad == null ? 2 : opts.pad;
    var pts = normalise(Array.isArray(values) ? values : []);
    if (pts.length < 2) {
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="wtc-spark" preserveAspectRatio="none" ' +
        'aria-label="no chart data"><line x1="0" y1="' + (H / 2) + '" x2="' + W + '" y2="' + (H / 2) +
        '" stroke="' + GRID + '" stroke-dasharray="3 4"/></svg>';
    }
    pts = downsample(pts, 160);
    var vals = pts.map(function (p) { return p.value; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || Math.abs(max) * 0.02 || 1;
    var sx = function (i) { return pad + (i / (pts.length - 1)) * (W - pad * 2); };
    var sy = function (v) { return H - pad - ((v - min) / span) * (H - pad * 2); };
    var xy = pts.map(function (p, i) { return { x: sx(i), y: sy(p.value), p: p.value }; });
    var uid = 'wtc' + Math.random().toString(36).slice(2, 8);
    var rising = pts[pts.length - 1].value >= pts[0].value;
    var accent = rising ? UP : DOWN;

    var line = 'M ' + xy.map(function (p) { return p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' L ');
    var area = line + ' L ' + (W - pad) + ' ' + H + ' L ' + pad + ' ' + H + ' Z';

    var segs = legsOf(xy).map(function (l) {
      return '<path d="M ' + l.x1.toFixed(1) + ' ' + l.y1.toFixed(1) + ' L ' + l.x2.toFixed(1) + ' ' + l.y2.toFixed(1) +
        '" stroke="' + (l.up ? UP : DOWN) + '" stroke-width="' + (opts.weight || 1.8) + '" fill="none" stroke-linecap="round"/>';
    }).join('');

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="wtc-spark" preserveAspectRatio="none" ' +
      'role="img" aria-label="price chart, ' + (rising ? 'rising' : 'falling') + '">' +
      '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + accent + '" stop-opacity="' + (opts.fill == null ? 0.3 : opts.fill) + '"/>' +
        '<stop offset="70%" stop-color="' + accent + '" stop-opacity="0.06"/>' +
        '<stop offset="100%" stop-color="' + accent + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      (opts.fill === 0 ? '' : '<path d="' + area + '" fill="url(#' + uid + ')" stroke="none"/>') +
      segs +
    '</svg>';
  };

  /* ------------------------------------------------------ interactive chart */
  var CSS_ID = 'wtc-chart-css';
  function injectCSS() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = [
      '.wtc{position:relative;border-radius:14px;background:transparent;',
      'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:' + TEXT + ';',
      'user-select:none;-webkit-user-select:none}',
      '.wtc-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:2px 2px 8px}',
      '.wtc-sym{font-size:12.5px;font-weight:700;letter-spacing:.2px;color:' + TEXT + '}',
      '.wtc-price{font-size:21px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.wtc-chg{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums}',
      '.wtc-chg.up{color:' + UP + '}.wtc-chg.down{color:' + DOWN + '}',
      '.wtc-hov{font-size:11px;color:' + MUTED + ';font-variant-numeric:tabular-nums}',
      '.wtc-ctl{display:flex;gap:5px;flex-wrap:wrap;padding:0 0 6px}',
      '.wtc-tab{border:0;cursor:pointer;border-radius:999px;padding:4px 11px;font-size:11px;font-weight:700;',
      'font-family:inherit;background:transparent;color:' + MUTED + ';transition:background .15s,color .15s}',
      '.wtc-tab:hover{color:' + TEXT + ';background:rgba(255,255,255,.05)}',
      '.wtc-tab.on{color:' + UP + ';background:' + UP_A + '.16)}',
      '.wtc-tab.mode.on{color:' + TEXT + ';background:rgba(255,255,255,.10)}',
      '.wtc-stage{position:relative;width:100%}',
      '.wtc-svg{display:block;width:100%;overflow:visible;touch-action:pan-y}',
      '.wtc-tip{position:absolute;pointer-events:none;display:none;z-index:4;background:rgba(6,18,28,.97);',
      'border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:6px 9px;font-size:10.5px;line-height:1.5;',
      'box-shadow:0 10px 26px rgba(0,0,0,.5);min-width:104px}',
      '.wtc-tip b{font-size:12px;font-variant-numeric:tabular-nums}',
      '.wtc-tip .t{color:' + MUTED + '}',
      '.wtc-pnl{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding:7px 10px;',
      'border-radius:11px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);font-size:11.5px}',
      '.wtc-side{font-size:9.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;padding:2px 7px;border-radius:999px}',
      '.wtc-side.long{color:' + UP + ';background:' + UP_A + '.14)}',
      '.wtc-side.short{color:' + DOWN + ';background:' + DOWN_A + '.14)}',
      '.wtc-pnl .v{font-weight:800;font-variant-numeric:tabular-nums;margin-left:auto}',
      '.wtc-pnl .v.up{color:' + UP + '}.wtc-pnl .v.down{color:' + DOWN + '}',
      '.wtc-pnl .d{color:' + MUTED + ';font-variant-numeric:tabular-nums}',
      '@media(max-width:520px){.wtc-price{font-size:18px}.wtc-hov{display:none}}'
    ].join('');
    document.head.appendChild(st);
  }

  function Chart(host, opts) {
    if (!(this instanceof Chart)) return new Chart(host, opts);
    injectCSS();
    this.host = host;
    this.opts = opts = opts || {};
    this.up = opts.up || UP;
    this.down = opts.down || DOWN;
    this.currency = opts.currency || '$';
    this.height = opts.height || opts.h || 260;
    this.tf = opts.tf || '1D';
    this.mode = opts.mode || 'line';
    this.symbol = opts.symbol || opts.ticker || '';
    this.points = normalise(opts.points || opts.data || []);
    this.lines = opts.lines || [];
    this.positions = opts.positions || [];
    this.baseline = Number(opts.baseline) > 0 ? Number(opts.baseline) : 0;
    this.side = opts.side === 'short' ? 'short' : 'long';
    this.tabs = opts.tabs !== false;
    this.hover = null;
    this._raf = 0;
    this.build();
    this.bind();
    this.render();
    if (this.points.length < 2 && opts.fallback) {
      this.points = normalise(opts.fallback);
      this.render();
    }
  }

  Chart.prototype.build = function () {
    var self = this;
    var h = this.host;
    h.classList.add('wtc-host');
    h.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'wtc';
    this.el = wrap;

    var head = document.createElement('div');
    head.className = 'wtc-head';
    head.innerHTML = '<span class="wtc-sym"></span><span class="wtc-price"></span>' +
      '<span class="wtc-chg"></span><span class="wtc-hov"></span>';
    wrap.appendChild(head);

    if (this.tabs || this.opts.controls) {
      var ctl = document.createElement('div');
      ctl.className = 'wtc-ctl';
      TFS.forEach(function (t) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'wtc-tab' + (t === self.tf ? ' on' : '');
        b.setAttribute('data-tf', t);
        b.textContent = t;
        ctl.appendChild(b);
      });
      var lm = document.createElement('button');
      lm.type = 'button';
      lm.className = 'wtc-tab mode' + (self.mode === 'line' ? ' on' : '');
      lm.setAttribute('data-mode', 'line');
      lm.textContent = 'Line';
      ctl.appendChild(lm);
      var cm = document.createElement('button');
      cm.type = 'button';
      cm.className = 'wtc-tab mode' + (self.mode === 'candles' ? ' on' : '');
      cm.setAttribute('data-mode', 'candles');
      cm.textContent = 'Candles';
      ctl.appendChild(cm);
      wrap.appendChild(ctl);
    }

    var stage = document.createElement('div');
    stage.className = 'wtc-stage';
    stage.innerHTML = '<svg class="wtc-svg" xmlns="http://www.w3.org/2000/svg"></svg><div class="wtc-tip"></div>';
    wrap.appendChild(stage);

    var pnl = document.createElement('div');
    pnl.className = 'wtc-pnl';
    pnl.style.display = 'none';
    wrap.appendChild(pnl);

    h.appendChild(wrap);

    this.elHead = head;
    this.elSym = head.querySelector('.wtc-sym');
    this.elPrice = head.querySelector('.wtc-price');
    this.elChg = head.querySelector('.wtc-chg');
    this.elHov = head.querySelector('.wtc-hov');
    this.stage = stage;
    this.svg = stage.querySelector('.wtc-svg');
    this.tip = stage.querySelector('.wtc-tip');
    this.elPnl = pnl;
  };

  Chart.prototype.bind = function () {
    var self = this;
    this.el.addEventListener('click', function (e) {
      var b = e.target.closest('.wtc-tab');
      if (!b) return;
      if (b.getAttribute('data-tf')) {
        self.tf = b.getAttribute('data-tf');
        self.el.querySelectorAll('[data-tf]').forEach(function (x) { x.classList.toggle('on', x === b); });
      } else if (b.getAttribute('data-mode')) {
        self.mode = b.getAttribute('data-mode');
        self.el.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.toggle('on', x === b); });
      }
      self.hover = null;
      self.render();
    });

    var move = function (e) {
      var r = self.svg.getBoundingClientRect();
      if (!r.width) return;
      var mx = e.touches ? e.touches[0].clientX - r.left : e.clientX - r.left;
      mx = clamp(mx, 0, self._chartW || r.width);
      var n = self._n || 0;
      if (n < 2) return;
      self.hover = clamp(Math.round((mx / (self._chartW || r.width)) * (n - 1)), 0, n - 1);
      self.paintHover();
    };
    this.svg.addEventListener('mousemove', move);
    this.svg.addEventListener('touchstart', function (e) { move(e); }, { passive: true });
    this.svg.addEventListener('touchmove', function (e) { move(e); }, { passive: true });
    this.svg.addEventListener('mouseleave', function () { self.hover = null; self.paintHover(); });
    this.svg.addEventListener('touchend', function () { self.hover = null; self.paintHover(); });

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(function () { self.schedule(); });
      this.ro.observe(this.stage);
    } else {
      this._onResize = function () { self.render(); };
      window.addEventListener('resize', this._onResize);
    }
  };

  Chart.prototype.schedule = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self.render(); });
  };

  Chart.prototype.setData = function (points) { this.points = normalise(points); this.render(); return this; };
  Chart.prototype.setSymbol = function (s) { this.symbol = s || ''; this.render(); return this; };
  Chart.prototype.setMode = function (m) { this.mode = m === 'candles' ? 'candles' : 'line'; this.render(); return this; };
  Chart.prototype.setLines = function (lines) { this.lines = lines || []; this.render(); return this; };
  Chart.prototype.setPositions = function (p) { this.positions = p || []; this.render(); return this; };
  Chart.prototype.setBaseline = function (b, side) {
    this.baseline = Number(b) > 0 ? Number(b) : 0;
    if (side) this.side = side === 'short' ? 'short' : 'long';
    this.render();
    return this;
  };

  /* live tick: same second -> replace, newer -> append, older -> ignore */
  Chart.prototype.update = function (point) {
    if (!point) return this;
    var t = num(point.time != null ? point.time : point.t);
    var v = num(point.value != null ? point.value : (point.price != null ? point.price : point.c));
    if (!isFinite(v)) return this;
    if (t > 1e11) t = Math.floor(t / 1000);
    if (!isFinite(t)) t = Math.floor(Date.now() / 1000);
    var pts = this.points;
    if (!pts.length) { this.points = [{ time: t, value: v }]; this.render(); return this; }
    var last = pts[pts.length - 1];
    if (t >= last.time) {
      if (t === last.time) pts[pts.length - 1] = { time: t, value: v };
      else pts.push({ time: t, value: v });
      if (pts.length > 4000) pts.splice(0, pts.length - 4000);
      this.schedule();
    }
    return this;
  };

  Chart.prototype.destroy = function () {
    try { if (this.ro) this.ro.disconnect(); } catch (e) {}
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.host) { this.host.classList.remove('wtc-host'); this.host.innerHTML = ''; }
    this.points = [];
  };

  /* ------------------------------------------------------------- the render */
  Chart.prototype.render = function () {
    var self = this;
    var cur = visible(this.points, this.tf);
    if (!cur.length) {
      this.svg.innerHTML = '<text x="50%" y="50%" fill="' + MUTED + '" font-size="12" text-anchor="middle">' +
        'No price data for this period</text>';
      this.elPrice.textContent = ''; this.elChg.textContent = ''; this.elPnl.style.display = 'none';
      return;
    }

    var W = Math.max(240, this.stage.clientWidth || this.host.clientWidth || 320);
    var H = this.height;
    var axisW = 68;
    var padT = 12, padB = 22;
    var chartW = Math.max(60, W - axisW);
    var chartH = Math.max(60, H - padT - padB);
    this._chartW = chartW;

    var last = cur[cur.length - 1];
    var firstVal = cur[0].value;
    var pct = firstVal ? ((last.value - firstVal) / firstVal) * 100 : 0;
    var rising = pct >= 0;
    var accent = rising ? this.up : this.down;

    /* ---- scales ---- */
    var lo = Infinity, hi = -Infinity, i, v;
    if (this.mode === 'candles') {
      var cand = toCandles(cur, 48);
      for (i = 0; i < cand.length; i++) { if (cand[i].l < lo) lo = cand[i].l; if (cand[i].h > hi) hi = cand[i].h; }
    } else {
      for (i = 0; i < cur.length; i++) { v = cur[i].value; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (this.baseline > 0) { if (this.baseline < lo) lo = this.baseline; if (this.baseline > hi) hi = this.baseline; }
    for (i = 0; i < this.lines.length; i++) {
      var lp = Number(this.lines[i].price);
      if (lp > 0) { if (lp < lo) lo = lp; if (lp > hi) hi = lp; }
    }
    var pad = (hi - lo) * 0.14 || Math.abs(hi || 1) * 0.02 || 1;
    lo -= pad; hi += pad;
    var span = hi - lo || 1;

    var y = function (p) { return padT + (1 - (p - lo) / span) * chartH; };
    var nVis = this.mode === 'candles' ? 0 : cur.length;
    var xAt = function (idx, total) { return total <= 1 ? chartW / 2 : (idx / (total - 1)) * chartW; };

    /* ---- header ---- */
    this.elSym.textContent = this.symbol || '';
    this.elSym.style.display = this.symbol ? '' : 'none';
    this.elPrice.textContent = usd(last.value, last.value >= 1 ? 2 : 4);
    this.elChg.textContent = (rising ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(2) + '%';
    this.elChg.className = 'wtc-chg ' + (rising ? 'up' : 'down');

    var s = '';
    var uid = 'wtc' + Math.random().toString(36).slice(2, 8);

    s += '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + accent + '" stop-opacity=".30"/>' +
      '<stop offset="62%" stop-color="' + accent + '" stop-opacity=".07"/>' +
      '<stop offset="100%" stop-color="' + accent + '" stop-opacity="0"/>' +
      '</linearGradient>' +
      '<filter id="' + uid + 'g" x="-30%" y="-30%" width="160%" height="160%">' +
      '<feGaussianBlur stdDeviation="3"/></filter>' +
      '<clipPath id="' + uid + 'c"><rect x="0" y="' + padT + '" width="' + chartW + '" height="' + (chartH + 1) + '"/></clipPath>' +
      '</defs>';

    /* ---- horizontal grid + right price axis ---- */
    var ticks = 5;
    for (i = 0; i < ticks; i++) {
      var pv = lo + (span * i) / (ticks - 1);
      var yy = y(pv);
      s += '<line x1="0" x2="' + chartW + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) +
        '" stroke="' + GRID + '" stroke-width="1" stroke-dasharray="2 5"/>';
      s += '<text x="' + (chartW + 8) + '" y="' + (yy + 3.5).toFixed(1) + '" fill="' + MUTED +
        '" font-size="10" font-variant-numeric="tabular-nums">' +
        usd(pv, Math.abs(pv) >= 1 ? 2 : 4) + '</text>';
    }
    s += '<line x1="' + chartW + '" x2="' + chartW + '" y1="' + padT + '" y2="' + (padT + chartH) +
      '" stroke="' + AXIS + '" stroke-width="1"/>';

    /* ---- time axis ---- */
    var tCount = clamp(Math.floor(chartW / 120), 2, 5);
    for (i = 0; i < tCount; i++) {
      var idx = Math.round(((nVis || 1) - 1) * i / (tCount - 1));
      var tt = cur[Math.min(cur.length - 1, Math.round((cur.length - 1) * i / (tCount - 1)))];
      s += '<text x="' + clamp(idx ? xAt(idx, nVis) : 12, 16, chartW - 16).toFixed(1) + '" y="' + (H - 6) +
        '" fill="' + MUTED + '" font-size="10" text-anchor="middle">' + esc(dayLabel(tt.time, this.tf)) + '</text>';
    }

    s += '<g clip-path="url(#' + uid + 'c)">';

    if (this.mode === 'candles') {
      var candles = toCandles(cur, 48);
      var cw = Math.max(1.5, Math.min(12, (chartW / Math.max(1, candles.length)) * 0.62));
      for (i = 0; i < candles.length; i++) {
        var c = candles[i];
        var cx = xAt(i, candles.length);
        var cu = c.c >= c.o;
        var col = cu ? this.up : this.down;
        var yo = y(c.o), yc = y(c.c);
        var top = Math.min(yo, yc), bh = Math.max(1.2, Math.abs(yc - yo));
        s += '<line x1="' + cx.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y1="' + y(c.h).toFixed(1) +
          '" y2="' + y(c.l).toFixed(1) + '" stroke="' + col + '" stroke-width="' + Math.max(1, cw * 0.18).toFixed(1) + '" opacity=".9"/>';
        s += '<rect x="' + (cx - cw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + cw.toFixed(1) +
          '" height="' + bh.toFixed(1) + '" rx="1" fill="' + col + '"/>';
      }
      this._pts = candles.map(function (cc, ix) { return { x: xAt(ix, candles.length), y: y(cc.c), p: cc.c, t: cc.time }; });
    } else {
      var pts = cur.map(function (p, ix) { return { x: xAt(ix, cur.length), y: y(p.value), p: p.value, t: p.time }; });
      this._pts = pts;
      var line = 'M ' + pts.map(function (p) { return p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' L ');
      var area = line + ' L ' + chartW.toFixed(1) + ' ' + (padT + chartH) + ' L 0 ' + (padT + chartH) + ' Z';
      s += '<path d="' + area + '" fill="url(#' + uid + ')" stroke="none"/>';

      var legs = legsOf(pts);
      /* glow */
      s += '<g filter="url(#' + uid + 'g)" opacity=".45">';
      for (i = 0; i < legs.length; i++) {
        var L = legs[i];
        s += '<path d="M ' + L.x1.toFixed(1) + ' ' + L.y1.toFixed(1) + ' L ' + L.x2.toFixed(1) + ' ' + L.y2.toFixed(1) +
          '" stroke="' + (L.up ? this.up : this.down) + '" stroke-width="3" fill="none"/>';
      }
      s += '</g>';
      /* the line: green while rising, red while falling */
      for (i = 0; i < legs.length; i++) {
        var g = legs[i];
        s += '<path d="M ' + g.x1.toFixed(1) + ' ' + g.y1.toFixed(1) + ' L ' + g.x2.toFixed(1) + ' ' + g.y2.toFixed(1) +
          '" stroke="' + (g.up ? this.up : this.down) + '" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
      }
    }

    s += '</g>';

    /* ---- entry / TP / SL reference lines ---- */
    for (i = 0; i < this.lines.length; i++) {
      var ln = this.lines[i];
      var pr = Number(ln.price);
      if (!(pr > 0) || pr < lo || pr > hi) continue;
      var ly = y(pr);
      var lc = ln.color || ENTRY;
      s += '<line x1="0" x2="' + chartW + '" y1="' + ly.toFixed(1) + '" y2="' + ly.toFixed(1) +
        '" stroke="' + lc + '" stroke-width="1" stroke-dasharray="' + (ln.dash || '4 4') + '" opacity=".85"/>';
      if (ln.title) {
        s += '<text x="4" y="' + (ly - 4).toFixed(1) + '" fill="' + lc + '" font-size="9.5" font-weight="700">' +
          esc(ln.title) + '</text>';
      }
    }

    /* ---- live price badge + marker ---- */
    var lastY = y(last.value);
    var lastX = this.mode === 'candles' ? chartW : chartW;
    s += '<line x1="0" x2="' + chartW + '" y1="' + lastY.toFixed(1) + '" y2="' + lastY.toFixed(1) +
      '" stroke="' + accent + '" stroke-width="1" stroke-dasharray="3 4" opacity=".7"/>';
    s += '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="7" fill="' + accent + '" opacity=".2"/>';
    s += '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="3.8" fill="' + accent + '"/>';
    s += '<rect x="' + (chartW + 3) + '" y="' + (lastY - 9) + '" width="' + (axisW - 6) + '" height="18" rx="4" fill="' + accent + '"/>';
    s += '<text x="' + (chartW + 6) + '" y="' + (lastY + 3.6) + '" fill="#04140d" font-size="10" font-weight="800" ' +
      'font-variant-numeric="tabular-nums">' + usd(last.value, last.value >= 1 ? 2 : 4) + '</text>';

    this._n = this._pts ? this._pts.length : 0;
    this._axisW = axisW; this._padT = padT; this._chartH = chartH; this._H = H;

    this.svg.setAttribute('viewBox', '0 0 ' + (chartW + axisW) + ' ' + H);
    this.svg.setAttribute('height', String(H));
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.innerHTML = s;

    this.paintHover();
    this.paintPnL(last.value);
  };

  Chart.prototype.paintHover = function () {
    if (!this._pts || this.hover == null || !this._pts[this.hover]) {
      this.tip.style.display = 'none';
      this.elHov.textContent = '';
      var stale = this.svg.querySelector('.wtc-cross');
      if (stale) stale.remove();
      return;
    }
    var p = this._pts[this.hover];
    var first = this._pts[0] ? this._pts[0].p : p.p;
    var dp = first ? ((p.p - first) / first) * 100 : 0;
    var cross = '<g class="wtc-cross" pointer-events="none">' +
      '<line x1="' + p.x + '" x2="' + p.x + '" y1="' + this._padT + '" y2="' + (this._padT + this._chartH) +
      '" stroke="rgba(233,244,249,.28)" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<line x1="0" x2="' + this._chartW + '" y1="' + p.y + '" y2="' + p.y +
      '" stroke="rgba(233,244,249,.28)" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<circle cx="' + p.x + '" cy="' + p.y + '" r="3.4" fill="' + TEXT + '"/></g>';
    var old = this.svg.querySelector('.wtc-cross');
    if (old) old.remove();
    this.svg.insertAdjacentHTML('beforeend', cross);

    this.tip.style.display = 'block';
    this.tip.style.left = clamp(p.x + 12, 4, Math.max(4, this._chartW - 120)) + 'px';
    this.tip.style.top = clamp(p.y - 46, 4, this._H - 52) + 'px';
    this.tip.innerHTML = '<div class="t">' + esc(fullLabel(p.t, this.tf)) + '</div>' +
      '<b>' + usd(p.p, p.p >= 1 ? 2 : 4) + '</b>' +
      '<div style="color:' + (dp >= 0 ? this.up : this.down) + ';font-weight:700">' +
      (dp >= 0 ? '+' : '−') + Math.abs(dp).toFixed(2) + '%</div>';
    this.elHov.textContent = dayLabel(p.t, this.tf) + ' · ' + usd(p.p, p.p >= 1 ? 2 : 4);
  };

  Chart.prototype.paintPnL = function (mark) {
    var pos = this.positions && this.positions.length ? this.positions[0] : null;
    if (!pos) {
      /* derive from the baseline (entry) when no explicit position is given */
      if (!this.baseline) { this.elPnl.style.display = 'none'; return; }
      pos = { side: this.side, entry: this.baseline, qty: 1 };
    }
    var dir = pos.side === 'short' ? -1 : 1;
    var qty = Number(pos.qty || pos.quantity || 1) || 1;
    var pnl = (mark - pos.entry) * qty * dir;
    var pct = pos.entry ? ((mark - pos.entry) / pos.entry) * 100 * dir : 0;
    var win = pnl >= 0;

    this.elPnl.style.display = 'flex';
    this.elPnl.innerHTML =
      '<span class="wtc-side ' + (dir > 0 ? 'long' : 'short') + '">' + (dir > 0 ? 'Long' : 'Short') + '</span>' +
      '<span class="d">Entry ' + usd(pos.entry) + ' · Mark ' + usd(mark) + '</span>' +
      '<span class="v ' + (win ? 'up' : 'down') + '">' + (win ? '▲ ' : '▼ ') + signed(pnl) +
      ' (' + (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(2) + '%)</span>';
  };

  TC.Chart = Chart;

  /* ------------------------------------------------------------------------
     3.66.1 — the shared chart kit is the renderer for every live chart.
     It gives the stock trade chart AND the portfolio chart the reference
     design (header price + WC, 1D/1W/1M/1Y/ALL, Line/Candles, split green/red
     series, WC price axis, pinned last price) while keeping the entry/TP/SL
     price lines and the position P&L the trading screens rely on.
     ---------------------------------------------------------------------- */
  function kitRange(tf) {
    var t = String(tf || '1D').toLowerCase();
    if (t === '1w' || t === '7d') return '1W';
    if (t === '1m' || t === '30d') return '1M';
    if (t === '1y' || t === '365d') return '1Y';
    if (t === 'all' || t === 'max') return 'ALL';
    return '1D';
  }
  function mountKit(host, opts) {
    var K = window.WCChartKit;
    if (!K || !K.mount) return null;
    opts = opts || {};
    var pts = Array.isArray(opts.points) ? opts.points : [];
    var pos = (opts.positions && opts.positions[0]) || null;
    var kernel = K.mount(host, {
      data: pts,
      price: pts.length ? (pts[pts.length - 1].value != null ? pts[pts.length - 1].value : pts[pts.length - 1].p) : 0,
      symbol: opts.symbol || '',
      baseline: opts.baseline != null ? opts.baseline : undefined,
      lines: opts.lines || [],
      position: pos ? { units: Number(pos.qty || pos.quantity || 1) || 1, cost: (Number(pos.entry) || 0) * (Number(pos.qty || pos.quantity || 1) || 1) } : null,
      height: opts.height || 300,
      range: kitRange(opts.tf),
      mode: opts.mode === 'candles' ? 'candles' : 'line',
      decimals: 2
    });
    if (!kernel) return null;
    var adapter = {
      __wcKit: true,
      host: host,
      get points() { return kernel.points ? kernel.points() : pts.length; },
      update: function (p) { try { kernel.update(p); } catch (e) {} },
      setData: function (d) {
        try {
          kernel.setData(d || []);
          if (!d || !d.length) return;
          var lv = d[d.length - 1].value != null ? d[d.length - 1].value : d[d.length - 1].p;
          kernel.setPrice(lv);
        } catch (e) {}
      },
      setLines: function (l) { try { kernel.setLines(l || []); } catch (e) {} },
      setPositions: function (l) { try { kernel.setPositions(l || []); } catch (e) {} },
      setBaseline: function (v) { try { kernel.setBaseline(v); } catch (e) {} },
      setSymbol: function (s) { try { kernel.setSymbol(s); } catch (e) {} },
      setMode: function (m) { try { kernel.setMode(m === 'candles' ? 'candles' : 'line'); } catch (e) {} },
      render: function () {},
      schedule: function () {},
      resize: function () {},
      destroy: function () { try { kernel.destroy(); } catch (e) {} }
    };
    return adapter;
  }

  TC.mount = function (host, opts) {
    if (!host) return null;
    try {
      var kit = mountKit(host, opts);
      if (kit) return kit;
    } catch (e) {}
    try { return new Chart(host, opts); } catch (e) {
      try {
        host.innerHTML = '<div style="padding:18px;color:' + MUTED + ';font-size:12px">Chart unavailable</div>';
      } catch (err) {}
      return null;
    }
  };

  /* --------------------------------------------------- auto-upgrade helpers */
  /* Any element tagged data-wtc-chart gets a chart from window.WC_CHART_DATA  */
  TC.upgrade = function (root) {
    var scope = root || document;
    scope.querySelectorAll('[data-wtc-chart]').forEach(function (host) {
      if (host.__wtc || host.getBoundingClientRect().width === 0) return;
      var key = host.getAttribute('data-wtc-chart');
      var src = (window.WC_CHART_DATA && window.WC_CHART_DATA[key]) || [];
      var inst = TC.mount(host, {
        symbol: host.getAttribute('data-wtc-symbol') || key,
        points: src,
        height: Number(host.getAttribute('data-wtc-height')) || 260
      });
      if (inst) host.__wtc = inst;
    });
  };

  if (document.readyState !== 'loading') setTimeout(function () { TC.upgrade(); }, 400);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(function () { TC.upgrade(); }, 400); });
})();
