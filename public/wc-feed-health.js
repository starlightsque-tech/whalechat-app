/* =========================================================================
   WhaleChat · live connection health panel (wc-feed-health)
   -------------------------------------------------------------------------
   The account dashboard shows exactly what the market feed is doing:
     · Binance, Finnhub and Twelve Data connection state
     · the last tick each provider delivered
     · how many instruments are live right now vs listed
     · a one-tap reconnect that re-opens every socket and re-polls the proxy
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcFeedHealth) return;
  window.__wcFeedHealth = true;

  function styles() {
    if (document.getElementById('wc-feed-health-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-feed-health-css';
    st.textContent = [
      '.wc-fh-card{margin-top:14px;padding:16px 16px 14px;border-radius:20px;border:1px solid var(--border);',
      '  background:linear-gradient(135deg,rgba(46,230,201,.06),rgba(58,160,255,.04));position:relative;overflow:hidden}',
      '.wc-fh-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}',
      '.wc-fh-head h3{margin:0;font-size:15px;font-weight:800;letter-spacing:.01em}',
      '.wc-fh-head .tiny{color:var(--muted);font-weight:600}',
      '.wc-fh-badge{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:9.5px;font-weight:800;',
      '  letter-spacing:.08em;padding:4px 9px;border-radius:99px;border:1px solid rgba(46,230,201,.4);color:#2ee6c9;background:rgba(46,230,201,.1)}',
      '.wc-fh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:12px}',
      '.wc-fh-row{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}',
      '.wc-fh-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#7d8f9c;box-shadow:0 0 0 3px rgba(125,143,156,.14)}',
      '.wc-fh-dot.on{background:#2ee6c9;box-shadow:0 0 0 3px rgba(46,230,201,.18);animation:wcFhPulse 2s infinite}',
      '.wc-fh-dot.wait{background:#f5a623;box-shadow:0 0 0 3px rgba(245,166,35,.18);animation:wcFhPulse 1.2s infinite}',
      '.wc-fh-dot.off{background:#ff5f74;box-shadow:0 0 0 3px rgba(255,95,116,.16)}',
      '@keyframes wcFhPulse{0%,100%{opacity:.55}50%{opacity:1}}',
      '.wc-fh-row b{font-size:12px;font-weight:800;display:block;line-height:1.2}',
      '.wc-fh-row span{font-size:10.5px;color:var(--muted);font-weight:600;line-height:1.3}',
      '.wc-fh-stats{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:11px;border-top:1px dashed var(--border)}',
      '.wc-fh-stat b{font-size:18px;font-weight:800;font-variant-numeric:tabular-nums;display:block;line-height:1.1}',
      '.wc-fh-stat span{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}',
      '.wc-fh-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
      '@media(max-width:420px){.wc-fh-grid{grid-template-columns:1fr}.wc-fh-stat b{font-size:16px}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function ago(ms) {
    if (!ms) return 'no tick yet';
    var d = Math.max(0, Date.now() - Number(ms));
    if (d < 3000) return 'just now';
    if (d < 60000) return Math.floor(d / 1000) + 's ago';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    return Math.floor(d / 3600000) + 'h ago';
  }
  function dot(on, waiting) { return '<span class="wc-fh-dot ' + (on ? 'on' : waiting ? 'wait' : 'off') + '"></span>'; }

  function feed() { try { return window.WCMarketFeed || null; } catch (e) { return null; } }

  function html(st) {
    var online = navigator.onLine !== false;
    function row(name, key) {
      var last = st.last[key] || 0;
      var recent = last && (Date.now() - last < 180000);
      var on = key === 'binance' ? st.binance > 0 : (!!st[key] && recent);
      var configured = !st.configured || st.configured[key] !== false;
      if (!configured) {
        return '<div class="wc-fh-row">' + dot(false, false) +
          '<div style="min-width:0"><b>' + name + '</b><span>Standby · add a provider key</span></div></div>';
      }
      var waiting = !on && online;
      return '<div class="wc-fh-row">' + dot(on, waiting) +
        '<div style="min-width:0"><b>' + name + '</b><span>' + (on ? 'Live' : (online ? 'Idle' : 'Offline · device offline')) +
        ' · ' + ago(last) + '</span></div></div>';
    }
    return '<div class="card wc-fh-card" data-wc-feed-health="1">' +
      '<div class="wc-fh-head"><div><h3>Live market connection</h3>' +
      '<div class="tiny">24/7 feed health · prices keep updating with the app closed or the screen off.</div></div>' +
      '<span class="wc-fh-badge"><i style="width:6px;height:6px;border-radius:50%;background:#2ee6c9;display:inline-block"></i>24/7</span></div>' +
      '<div class="wc-fh-grid">' +
      row('Binance', 'binance') + row('Finnhub', 'finnhub') + row('Twelve Data', 'twelvedata') +
      '</div>' +
      '<div class="wc-fh-stats">' +
      '<div class="wc-fh-stat"><b>' + Number(st.liveInstruments || 0) + '</b><span>Live instruments</span></div>' +
      '<div class="wc-fh-stat"><b>' + Number(st.listed || 0) + '</b><span>Listed</span></div>' +
      '<div class="wc-fh-stat"><b>' + ago(st.lastTickAt) + '</b><span>Last tick</span></div>' +
      '<div class="wc-fh-stat"><b>' + (st.proxy ? 'Server' : (st.localKeys ? 'Device key' : 'Public')) + '</b><span>Stock source</span></div>' +
      '</div>' +
      '<div class="wc-fh-actions">' +
      '<button class="btn btn-sm btn-primary" data-wcfeed-health="reconnect">Reconnect feeds</button>' +
      '<a class="btn btn-sm btn-ghost" href="#/admin/stocks">Feed settings</a>' +
      '</div></div>';
  }

  function mount() {
    if (!/^#\/profile/.test(location.hash || '')) return;
    var grid = document.querySelector('.wallet-grid');
    if (!grid) return;
    var existing = document.querySelector('[data-wc-feed-health="1"]');
    var f = feed();
    var st = f && f.status ? f.status() : { last: {}, liveInstruments: 0, listed: 0 };
    if (existing) {
      existing.outerHTML = html(st);
      bind(document);
      return;
    }
    var wrap = document.createElement('div');
    wrap.innerHTML = html(st);
    var node = wrap.firstChild;
    grid.parentNode.insertBefore(node, grid.nextSibling);
    bind(node);
  }

  function bind(root) {
    var card = (root && root.querySelector) ? root.querySelector('[data-wc-feed-health="1"]') : null;
    if (!card) card = document.querySelector('[data-wc-feed-health="1"]');
    if (!card) return;
    card.querySelectorAll('[data-wcfeed-health="reconnect"]').forEach(function (b) {
      b.onclick = function () {
        var f = feed();
        if (f && f.reconnect) f.reconnect();
        else location.reload();
        setTimeout(mount, 400);
      };
    });
  }

  styles();
  setInterval(function () { try { mount(); } catch (e) {} }, 2500);
  document.addEventListener('DOMContentLoaded', mount);
})();
