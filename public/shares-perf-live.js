/* =========================================================================
   WhaleChat live performance chart  (wc-perf-live)

   The plan / portfolio performance card used a CDN chart library. When that
   CDN is blocked (or the chart is mounted before the library resolves) the
   card rendered as an empty black box with "—" values — exactly what users
   saw on the WhaleChat shares screen.

   This module replaces WC_PRO_CHART.mountEquity with a self-contained SVG
   chart: no network dependency, redraws every second, and always shows the
   live value, ROI, earnings, invested and target lines.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcPerfLive) return;
  window.__wcPerfLive = true;

  var PC = (window.WC_PRO_CHART = window.WC_PRO_CHART || {});
  var instances = (PC.equities = PC.equities || []);

  var css = document.createElement('style');
  css.id = 'wc-perf-live-style';
  css.textContent = [
    '.wcpl{background:#07090e;border:1px solid rgba(0,245,212,.14);border-radius:16px;padding:12px 12px 8px;position:relative;overflow:hidden}',
    '.wcpl-hud{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:2px 2px 10px}',
    '.wcpl-hud>div{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:7px 9px;min-width:0}',
    '.wcpl-hud span{display:block;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:#7d879b}',
    '.wcpl-hud b{display:block;font-size:14px;color:#e9f4f9;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wcpl-hud b.up{color:#2ee6a8}.wcpl-hud b.down{color:#ff5d7a}',
    '.wcpl-stage{position:relative;height:220px}',
    '.wcpl svg{width:100%;height:100%;display:block;overflow:visible}',
    '.wcpl .wcpl-live{position:absolute;top:2px;right:4px;font-size:9.5px;font-weight:700;letter-spacing:.1em;color:#00f5d4;background:rgba(0,245,212,.1);border:1px solid rgba(0,245,212,.3);border-radius:99px;padding:2px 8px}',
    '.wcpl-tip{position:absolute;pointer-events:none;transform:translate(-50%,-115%);background:rgba(5,12,18,.94);border:1px solid rgba(0,245,212,.35);border-radius:8px;padding:4px 8px;font-size:11px;color:#e9f4f9;white-space:nowrap;opacity:0;transition:opacity .12s}',
    '.wcpl-foot{display:flex;justify-content:space-between;font-size:9.5px;color:#6f7a8d;padding:6px 3px 0}',
    '.wcpl-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:9.5px;color:#8b93a7;padding-top:4px}',
    '.wcpl-legend i{display:inline-block;width:14px;height:2px;margin-right:5px;vertical-align:middle;border-radius:2px}'
  ].join('\n');
  if (!document.getElementById('wc-perf-live-style')) document.head.appendChild(css);

  function fmtWC(v) {
    var n = Number(v) || 0;
    return (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2)) + ' WC';
  }
  function fmtPct(v) { var n = Number(v) || 0; return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%'; }
  function clock(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return ''; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function Inst(host, opts) {
    this.host = host;
    this.opts = opts || {};
    this.key = this.opts.key || 'default';
    this.points = (this.opts.points || []).slice();
    this.liveTail = [];
    this.lastAt = 0;
    this.destroyed = false;
    this._build();
    this._start();
  }

  Inst.prototype._build = function () {
    this.host.innerHTML =
      '<div class="wcpl">' +
        '<div class="wcpl-hud">' +
          '<div><span>Chart value</span><b data-wcpl="value">—</b></div>' +
          '<div><span>ROI</span><b data-wcpl="roi">—</b></div>' +
          '<div><span>Earnings</span><b data-wcpl="earn">—</b></div>' +
          '<div><span>Matures</span><b data-wcpl="matures">—</b></div>' +
        '</div>' +
        '<div class="wcpl-stage">' +
          '<span class="wcpl-live">● LIVE</span>' +
          '<svg viewBox="0 0 640 220" preserveAspectRatio="none" role="img" aria-label="Live plan performance"></svg>' +
          '<div class="wcpl-tip"></div>' +
        '</div>' +
        '<div class="wcpl-foot"><span data-wcpl="from">—</span><span data-wcpl="to">—</span></div>' +
        '<div class="wcpl-legend">' +
          '<span><i style="background:#3AA0FF"></i>Invested principal</span>' +
          '<span><i style="background:#00F5D4"></i>Target at maturity</span>' +
          '<span><i style="background:#2ee6c9"></i>Live value</span>' +
        '</div>' +
      '</div>';
    this.el = {
      value: this.host.querySelector('[data-wcpl="value"]'),
      roi: this.host.querySelector('[data-wcpl="roi"]'),
      earn: this.host.querySelector('[data-wcpl="earn"]'),
      matures: this.host.querySelector('[data-wcpl="matures"]'),
      from: this.host.querySelector('[data-wcpl="from"]'),
      to: this.host.querySelector('[data-wcpl="to"]'),
      svg: this.host.querySelector('svg'),
      tip: this.host.querySelector('.wcpl-tip')
    };
    var self = this;
    this.el.svg.addEventListener('mousemove', function (ev) {
      var rect = self.el.svg.getBoundingClientRect();
      if (!rect.width || !self.pts || self.pts.length < 2) return;
      var x = (ev.clientX - rect.left) / rect.width;
      var i = Math.max(0, Math.min(self.pts.length - 1, Math.round(x * (self.pts.length - 1))));
      var p = self.pts[i];
      var tx = (i / (self.pts.length - 1)) * 600 + 20;
      self.el.tip.style.left = (tx / 640 * 100) + '%';
      self.el.tip.style.top = '55%';
      self.el.tip.textContent = clock(p.t) + ' · ' + fmtWC(p.v);
      self.el.tip.style.opacity = '1';
    });
    this.el.svg.addEventListener('mouseleave', function () { self.el.tip.style.opacity = '0'; });
  };

  Inst.prototype.setData = function (points, opts) {
    if (opts) {
      this.opts = Object.assign({}, this.opts, opts);
      this.key = this.opts.key || this.key;
    }
    this.points = (points || []).slice();
    this.liveTail = [];
    this._draw();
  };

  Inst.prototype._series = function () {
    var now = Date.now();
    var live = this.opts.getLive ? this.opts.getLive() : null;
    var out = this.points.filter(function (p) { return p && Number.isFinite(Number(p.v)); }).slice(-260);
    if (live && Number(live.value) >= 0 && out.length) {
      var last = out[out.length - 1];
      if (now <= Number(last.t)) last.v = Number(live.value);
      else out.push({ t: now, v: Number(live.value) });
    }
    if (!out.length && live && Number(live.value) >= 0) out.push({ t: now, v: Number(live.value) });
    this.pts = out;
    return out;
  };

  Inst.prototype._draw = function () {
    if (this.destroyed || !document.body.contains(this.host)) return;
    var pts = this._series();
    var svg = this.el.svg;
    if (!pts.length) {
      svg.innerHTML = '<text x="320" y="110" text-anchor="middle" fill="#6f7a8d" font-size="13">Waiting for the first live data point…</text>';
      return;
    }

    var W = 640, H = 220, padL = 22, padR = 58, padT = 18, padB = 20;
    var vals = pts.map(function (p) { return Number(p.v); });
    var lines = (this.opts.lines || []).map(function (l) { return Number(l.price); }).filter(function (v) { return v > 0; });
    var min = Math.min.apply(null, vals.concat(lines.length ? lines : vals));
    var max = Math.max.apply(null, vals.concat(lines.length ? lines : vals));
    if (max - min < 0.0001) { max += 1; min -= 1; }
    var pad = (max - min) * 0.14; max += pad; min -= pad;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var x = function (i) { return padL + (i / Math.max(1, pts.length - 1)) * innerW; };
    var y = function (v) { return padT + innerH - ((v - min) / (max - min)) * innerH; };
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join(' ');
    var area = line + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (padT + innerH) + ' L' + padL + ' ' + (padT + innerH) + ' Z';
    var gid = 'wcplg' + Math.random().toString(36).slice(2, 7);
    var lastV = pts[pts.length - 1].v;
    var firstV = pts[0].v;
    var up = lastV >= firstV;
    var color = up ? '#2ee6c9' : '#ff5d7a';

    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (innerH / 4) * g;
      var gv = max - ((max - min) / 4) * g;
      grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '" stroke="rgba(255,255,255,.05)"/>';
      grid += '<text x="' + (W - padR + 5) + '" y="' + (gy + 3).toFixed(1) + '" fill="#6f7a8d" font-size="9">' + fmtWC(gv).replace(' WC', '') + '</text>';
    }

    var priceLines = '';
    (this.opts.lines || []).forEach(function (l) {
      var pv = Number(l.price);
      if (!(pv > 0)) return;
      var ly = y(pv);
      priceLines += '<line x1="' + padL + '" y1="' + ly.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + ly.toFixed(1) + '" stroke="' + (l.color || '#8B93A7') + '" stroke-width="1" stroke-dasharray="' + (l.style === 1 ? '2 3' : '6 4') + '"/>';
      if (l.title) priceLines += '<text x="' + (padL + 3) + '" y="' + (ly - 3).toFixed(1) + '" fill="' + (l.color || '#8B93A7') + '" font-size="9">' + esc(l.title) + '</text>';
    });

    var lastDot = '<circle cx="' + x(pts.length - 1).toFixed(1) + '" cy="' + y(lastV).toFixed(1) + '" r="3.4" fill="' + color + '"><animate attributeName="r" values="3.4;5;3.4" dur="1.6s" repeatCount="indefinite"/></circle>';

    svg.innerHTML =
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + color + '" stop-opacity=".34"/>' +
        '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      grid + priceLines +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      lastDot;

    if (this.el.from) this.el.from.textContent = clock(pts[0].t);
    if (this.el.to) this.el.to.textContent = clock(pts[pts.length - 1].t);

    var live = this.opts.getLive ? (this.opts.getLive() || {}) : {};
    if (this.el.value) this.el.value.textContent = fmtWC(live.value != null ? live.value : lastV);
    if (this.el.roi) { this.el.roi.textContent = fmtPct(live.roiPct); this.el.roi.className = Number(live.roiPct) >= 0 ? 'up' : 'down'; }
    if (this.el.earn) { this.el.earn.textContent = (Number(live.earnCoins) >= 0 ? '+' : '−') + fmtWC(Math.abs(Number(live.earnCoins) || 0)); this.el.earn.className = Number(live.earnCoins) >= 0 ? 'up' : 'down'; }
    if (this.el.matures) this.el.matures.textContent = live.matures || (this.opts.hud && this.opts.hud.matures) || '—';
    /* Use the shared wave chart so WC-Investing plan + ROI progress matches
       every other trading chart (green rise, red fall). */
    try {
      var stage = this.host.querySelector('.wcpl-stage');
      if (stage && window.WC_LIVE_CHART) {
        stage.innerHTML = '<span class="wcpl-live">● LIVE</span>' +
          WC_LIVE_CHART.svg(pts, { height: 220, unit: 'wc', wcRate: 0.5, lines: this.opts.lines || [] });
        this.el.svg = stage.querySelector('svg');
      }
    } catch (e) {}
  };

  Inst.prototype._start = function () {
    var self = this;
    this.timer = setInterval(function () {
      if (self.destroyed) return;
      if (!document.body.contains(self.host)) { self.destroy(); return; }
      self._draw();
    }, 1000);
  };

  Inst.prototype.destroy = function () {
    this.destroyed = true;
    clearInterval(this.timer);
    var i = instances.indexOf(this);
    if (i >= 0) instances.splice(i, 1);
    try { this.host.innerHTML = ''; } catch (e) {}
  };

  PC.mountEquity = function (host, opts) {
    if (!host) return null;
    var key = (opts && opts.key) || 'default';
    var existing = instances.find(function (e) { return e.host === host; });
    if (existing) {
      existing.setData((opts && opts.points) || [], Object.assign({}, opts, { key: key }));
      return existing;
    }
    instances.slice().forEach(function (e) { if (!document.body.contains(e.host)) e.destroy(); });
    var inst = new Inst(host, opts || {});
    instances.push(inst);
    return inst;
  };

  /* keep the card alive through re-renders */
  window.addEventListener('hashchange', function () {
    setTimeout(function () {
      instances.slice().forEach(function (e) { if (!document.body.contains(e.host)) e.destroy(); });
    }, 80);
  });
})();
