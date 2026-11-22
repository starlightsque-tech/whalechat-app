/* =========================================================================
   WhaleChat live chart  (wc-live-chart)

   One chart design for the whole app: a live line whose segments are green
   while price is rising and red while it is falling, a soft gradient under the
   line, right-hand price labels in USD with the WC equivalent, a pulsing live
   dot and a hover read-out. No external library — it renders SVG, so it works
   on every device and never waits for a CDN.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_LIVE_CHART) return;

  var C = { up: '#2ee6a8', down: '#ff5d7a' };
  var style = document.createElement('style');
  style.id = 'wc-live-chart-style';
  style.textContent = [
    '.wclc{position:relative;width:100%;background:#070d14;border:1px solid rgba(46,230,201,.12);border-radius:14px;overflow:hidden}',
    '.wclc svg{display:block;width:100%;height:100%}',
    '.wclc-tip{position:absolute;pointer-events:none;transform:translate(-50%,-120%);background:rgba(4,12,18,.95);border:1px solid rgba(46,230,201,.35);border-radius:8px;padding:5px 8px;font-size:11px;color:#e9f4f9;white-space:nowrap;opacity:0;transition:opacity .12s;z-index:3}',
    '.wclc-tag{position:absolute;top:7px;left:9px;font-size:9px;font-weight:800;letter-spacing:.12em;color:#00f5d4;background:rgba(0,245,212,.1);border:1px solid rgba(0,245,212,.28);border-radius:99px;padding:2px 7px}',
    '.wclc-hint{position:absolute;left:0;right:0;bottom:2px;text-align:center;font-size:9px;color:#5f7b8a}'
  ].join('\n');
  if (!document.getElementById('wc-live-chart-style')) document.head.appendChild(style);

  function money(v, unit, wcRate) {
    var n = Number(v) || 0;
    if (unit === 'wc') {
      var usd = n * (wcRate || 0.5);
      return '$' + usd.toFixed(2) + ' (' + n.toFixed(2) + ' WC)';
    }
    return '$' + n.toFixed(2);
  }
  function short(v, unit, wcRate) {
    var n = Number(v) || 0;
    if (unit === 'wc') return n.toFixed(1);
    return Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
  }
  function clock(ms) {
    try {
      var d = new Date(ms);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }

  function clean(points) {
    var out = [];
    (points || []).forEach(function (p) {
      if (!p) return;
      var t = Number(p.t || p.time), v = Number(p.v != null ? p.v : p.value);
      if (!(t > 0) || !isFinite(v)) return;
      if (out.length && t <= out[out.length - 1].t) out[out.length - 1].v = v;
      else out.push({ t: t, v: v });
    });
    return out;
  }

  function svg(points, opts) {
    var o = opts || {};
    var W = 360, H = o.height || 200;
    var padL = 8, padR = o.unit === 'wc' ? 64 : 66, padT = 14, padB = 18;
    var pts = clean(points);
    if (pts.length < 2) {
      return '<div style="height:' + H + 'px;display:flex;align-items:center;justify-content:center;color:#6f7a8d;font-size:12px">Waiting for live prices…</div>';
    }
    var vals = pts.map(function (p) { return p.v; });
    var lines = (o.lines || []).map(function (l) { return Number(l.price); }).filter(function (v) { return v > 0; });
    var min = Math.min.apply(null, vals.concat(lines.length ? lines : vals));
    var max = Math.max.apply(null, vals.concat(lines.length ? lines : vals));
    if (max - min < 1e-9) { max += Math.max(0.01, Math.abs(max) * 0.001); min -= Math.max(0.01, Math.abs(min) * 0.001); }
    var pad = (max - min) * 0.12; max += pad; min -= pad;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var x = function (i) { return padL + (i / (pts.length - 1)) * innerW; };
    var y = function (v) { return padT + innerH - ((v - min) / (max - min)) * innerH; };

    /* Smooth "wave" style: every segment is a cubic curve, coloured green when
       the price is rising and red when it is falling (one continuous wave). */
    var segs = '';
    var line = 'M' + x(0).toFixed(1) + ' ' + y(pts[0].v).toFixed(1);
    for (var i = 1; i < pts.length; i++) {
      var upSeg = pts[i].v >= pts[i - 1].v;
      var xa = x(i - 1), ya = y(pts[i - 1].v), xb = x(i), yb = y(pts[i].v);
      var mx = (xa + xb) / 2;
      var d = 'M' + xa.toFixed(1) + ' ' + ya.toFixed(1) + ' C' + mx.toFixed(1) + ' ' + ya.toFixed(1) + ', ' + mx.toFixed(1) + ' ' + yb.toFixed(1) + ', ' + xb.toFixed(1) + ' ' + yb.toFixed(1);
      segs += '<path d="' + d + '" fill="none" stroke="' + (upSeg ? C.up : C.down) + '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';
      line += ' C' + mx.toFixed(1) + ' ' + ya.toFixed(1) + ', ' + mx.toFixed(1) + ' ' + yb.toFixed(1) + ', ' + xb.toFixed(1) + ' ' + yb.toFixed(1);
    }
    var area = line + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (padT + innerH) + ' L' + padL + ' ' + (padT + innerH) + ' Z';
    var first = pts[0].v, last = pts[pts.length - 1].v;
    var trendUp = last >= first;
    var gid = 'wclcg' + Math.random().toString(36).slice(2, 8);
    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (innerH / 4) * g;
      var gv = max - ((max - min) / 4) * g;
      grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '" stroke="rgba(255,255,255,.045)"/>';
      grid += '<text x="' + (W - padR + 4) + '" y="' + (gy + 3).toFixed(1) + '" fill="#6f7a8d" font-size="9">' +
        (o.unit === 'wc' ? (Math.abs(gv) >= 1000 ? (gv / 1000).toFixed(1) + 'k' : Math.round(gv)) + ' WC' : '$' + short(gv, o.unit)) + '</text>';
    }
    var lvls = '';
    (o.lines || []).forEach(function (l) {
      var pv = Number(l.price);
      if (!(pv > 0)) return;
      var ly = y(pv);
      lvls += '<line x1="' + padL + '" y1="' + ly.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + ly.toFixed(1) + '" stroke="' + (l.color || '#8B93A7') + '" stroke-dasharray="' + (l.style === 1 ? '2 3' : '6 4') + '" stroke-width="1"/>';
      if (l.title) lvls += '<text x="' + (padL + 2) + '" y="' + (ly - 3).toFixed(1) + '" fill="' + (l.color || '#8B93A7') + '" font-size="8">' + esc(l.title) + '</text>';
    });
    var lastY = y(last);
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Live price chart">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + (trendUp ? C.up : C.down) + '" stop-opacity=".30"/>' +
        '<stop offset="100%" stop-color="' + (trendUp ? C.up : C.down) + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' + grid + lvls +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + (trendUp ? C.up : C.down) + '" stroke-width="9" stroke-opacity=".10" stroke-linecap="round"/>' +
      segs +
      '<circle cx="' + x(pts.length - 1).toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="3.4" fill="' + (trendUp ? C.up : C.down) + '"><animate attributeName="r" values="3.4;5.4;3.4" dur="1.6s" repeatCount="indefinite"/></circle>' +
      (function () {
        var chg = first ? ((last / first - 1) * 100) : 0;
        var label = (chg >= 0 ? '↑ +' : '↓ ') + Math.abs(chg).toFixed(2) + '%';
        var col = chg >= 0 ? C.up : C.down;
        return '<g><rect x="' + (W / 2 - 30) + '" y="' + (H - 20) + '" width="60" height="15" rx="7.5" fill="rgba(0,0,0,.28)" stroke="' + col + '" stroke-opacity=".35"/>' +
          '<text x="' + (W / 2) + '" y="' + (H - 9) + '" text-anchor="middle" fill="' + col + '" font-size="9" font-weight="700">' + label + '</text></g>';
      })() +
      '<text x="' + padL + '" y="' + (H - 4) + '" fill="#5f7b8a" font-size="9">' + clock(pts[0].t) + '</text>' +
      '<text x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end" fill="#5f7b8a" font-size="9">' + clock(pts[pts.length - 1].t) + '</text>' +
      '</svg>';
  }

  function mount(host, opts) {
    if (!host) return null;
    var o = opts || {};
    var inst = { host: host, opts: o, points: clean(o.points), timer: null };
    host.classList.add('wclc');
    host.style.height = (o.height || 200) + 'px';
    host.innerHTML = '<span class="wclc-tag">● LIVE</span><div class="wclc-body" style="height:100%"></div><div class="wclc-tip"></div>';
    var body = host.querySelector('.wclc-body');
    var tip = host.querySelector('.wclc-tip');
    function paint() {
      if (!document.body.contains(host)) { inst.destroy(); return; }
      var pts = inst.points.slice();
      if (o.getLive) {
        var live = o.getLive();
        var v = live != null ? Number(live.v != null ? live.v : live) : NaN;
        if (isFinite(v)) {
          var now = Date.now();
          if (pts.length && now - pts[pts.length - 1].t < 1000) pts[pts.length - 1].v = v;
          else pts.push({ t: now, v: v });
        }
      }
      body.innerHTML = svg(pts, o);
      if (pts.length > 1) {
        var first = pts[0].v, last = pts[pts.length - 1].v;
        host.style.borderColor = last >= first ? 'rgba(46,230,168,.28)' : 'rgba(255,93,122,.28)';
      }
      body.onmousemove = function (ev) {
        var r = body.getBoundingClientRect();
        if (!r.width) return;
        var frac = (ev.clientX - r.left) / r.width;
        var i = Math.max(0, Math.min(pts.length - 1, Math.round(frac * (pts.length - 1))));
        tip.style.left = (frac * 100) + '%';
        tip.style.top = '58%';
        tip.textContent = clock(pts[i].t) + ' · ' + money(pts[i].v, o.unit, o.wcRate);
        tip.style.opacity = '1';
      };
      body.onmouseleave = function () { tip.style.opacity = '0'; };
    }
    inst.setPoints = function (pts) { inst.points = clean(pts); paint(); };
    inst.setLiveValue = function (v) { inst.live = v; };
    inst.destroy = function () { clearInterval(inst.timer); if (host) host.innerHTML = ''; };
    paint();
    inst.timer = setInterval(paint, o.everyMs || 1000);
    return inst;
  }

  window.WC_LIVE_CHART = { svg: svg, mount: mount, money: money };
})();
