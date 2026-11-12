/* =========================================================================
   WhaleChat multi-asset markets — US / Global / Forex / Crypto
   Catalogue metadata, category tabs and the Admin → Markets asset finder.
   Prices themselves come only from the backend Alpaca feed.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;

  const EXTRA_ASSETS = [];

  const CLASS_LABEL = { us: 'US', global: 'Global', forex: 'FX', crypto: 'Crypto' };

  function ensureAssets() {
    if (typeof DB === 'undefined' || !DB || !Array.isArray(DB.stocks)) return false;
    let changed = false;
    DB.stocks.forEach((s) => {
      if (!s || !s.ticker) return;
      if (!s.assetClass) { s.assetClass = 'us'; changed = true; }
      if (!s.alpacaSymbol) { s.alpacaSymbol = String(s.ticker).toUpperCase(); changed = true; }
      if (s.overridePct == null) { s.overridePct = 0; changed = true; }
      if (s.assetClass === 'forex' || s.assetClass === 'crypto' || s.assetClass === 'global') { s.assetClass = 'us'; changed = true; }
      if (!s.displayTicker) { s.displayTicker = String(s.ticker).toUpperCase(); changed = true; }
      if (!s.exchange) { s.exchange = 'US'; changed = true; }
      if (!s.currency) { s.currency = 'USD'; changed = true; }
    });
    EXTRA_ASSETS.forEach((a) => {
      if (DB.stocks.some((s) => String(s.ticker).toUpperCase() === a.ticker)) return;
      DB.stocks.push(Object.assign({ id: 'st_' + a.ticker.toLowerCase().replace(/[^a-z0-9]/g, ''), price: 0, prevClose: 0, div: 0, paused: false, custom: false, createdAt: Date.now() }, a));
      changed = true;
    });
    if (changed) {
      try { persist(); } catch (e) {}
      try { sync(); } catch (e) {}
    }
    return changed;
  }

  function assetMeta(value) {
    if (typeof INV === 'undefined') return null;
    if (value && typeof value === 'object') return value;
    try { return INV.stock(String(value || '').toUpperCase()); } catch (e) { return null; }
  }
  function assetTicker(value) {
    const s = assetMeta(value);
    return s ? (s.displayTicker || s.ticker) : String(value || '');
  }
  function priceText(value, price) {
    const s = assetMeta(value);
    const cls = s && s.assetClass;
    const n = Number(price) || 0;
    if (!(n > 0)) return '—';
    let dec = 2;
    if (cls === 'forex') dec = 4;
    else if (cls === 'crypto') dec = n >= 100 ? 2 : n >= 1 ? 2 : 4;
    return '$' + n.toFixed(dec);
  }
  function assetClass(value) {
    const s = assetMeta(value);
    return (s && s.assetClass) || 'us';
  }
  function classBadge(value) {
    const cls = assetClass(value);
    return `<span class="asset-class-badge ${cls}">${CLASS_LABEL[cls] || cls}</span>`;
  }

  function applyList() {
    if (typeof INV === 'undefined') return;
    INV.assetTicker = assetTicker;
    INV.assetClass = assetClass;
    INV.priceText = priceText;
    INV.assetClassBadge = classBadge;
    INV.CATS = ['All', 'US Stocks', 'Top Gainers', 'Top Losers', 'Most Traded', 'Trending', 'Dividend', 'New'];
    if (!INV.marketCat || !INV.CATS.includes(INV.marketCat)) INV.marketCat = 'All';
    if (typeof ADMIN_NAV !== 'undefined' && Array.isArray(ADMIN_NAV)) {
      const n = ADMIN_NAV.find((x) => x.href === '#/admin/stocks');
      if (n) n.label = 'Markets';
    }
  }

  function apiPath(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }
  async function apiJSON(pathname, opts, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 15000);
    try {
      const res = await fetch(apiPath(pathname), Object.assign({ signal: ctrl.signal, headers: { 'content-type': 'application/json' } }, opts || {}));
      const data = await res.json().catch(() => null);
      return { res, data };
    } finally { clearTimeout(timer); }
  }
  function toastMsg(msg, type) { if (typeof toast === 'function') toast(msg, type || 'ok'); }

  function searchCard() {
    return `<div class="card" id="assetFinderCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Search &amp; add stock from Alpaca</div>
          <div class="tiny muted" style="margin-top:3px">Tradable US equities are added to the live Alpaca feed.</div></div>
        <span class="badge badge-accent">Markets</span>
      </div>
      <div class="row" style="gap:7px;margin-top:11px;flex-wrap:wrap">
        <select class="input" id="assetClass" style="max-width:160px"><option value="us">US Stocks</option></select>
        <input class="input grow" id="assetQuery" placeholder="Search e.g. AAPL, MSFT, NVDA" style="min-width:170px"/>
        <button class="btn btn-primary" data-act="asset-search">Search</button>
      </div>
      <div id="assetResults" class="asset-results"><div class="tiny muted" style="margin-top:8px">Search Alpaca to add a new tradable stock.</div></div>
      <div class="tiny muted" style="margin-top:7px">Alpaca market data covers US equities. Unpriced assets stay visible but trading is blocked until a live quote arrives.</div>
    </div>`;
  }

  function refreshAdmin() {
    if (typeof INV === 'undefined') return;
    const base = INV.viewAdminStocks;
    if (!base || INV.__assetsAdminPatched) return;
    INV.viewAdminStocks = function () {
      const html = base.apply(this, arguments);
      if (/Admin access only/.test(html)) return html;
      return html + searchCard();
    };
    INV.__assetsAdminPatched = true;
  }

  if (typeof App !== 'undefined') {
    App.assetSearch = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return toastMsg('Connect the sync server first', 'err');
      const q = ((document.getElementById('assetQuery') || {}).value || '').trim();
      const cls = (document.getElementById('assetClass') || {}).value || 'us';
      if (!q) return toastMsg('Enter a symbol or company name', 'err');
      const box = document.getElementById('assetResults');
      if (box) box.innerHTML = '<div class="tiny muted" style="margin-top:8px">Searching Alpaca…</div>';
      try {
        const meId = (typeof me === 'function' && me()) ? me().id : '';
        const r = await apiJSON('/api/market/search?q=' + encodeURIComponent(q) + '&class=' + encodeURIComponent(cls) + '&adminId=' + encodeURIComponent(meId), {}, 20000);
        const list = (r.data && r.data.results) || [];
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return toastMsg((r.data && r.data.error) || 'Search failed', 'err');
        if (box) box.innerHTML = list.length ? list.map((x) => `<div class="asset-result">
          <div class="grow" style="min-width:0"><b>${escAsset(x.display || x.symbol)}</b>
            <div class="tiny muted ellipsis">${escAsset(x.description || '')} · ${escAsset(x.type || '')}</div>
            <div class="tiny muted">${escAsset(x.symbol)}</div></div>
          <button class="btn btn-sm btn-primary" data-act="asset-add" data-class="${escAsset(cls)}" data-symbol="${escAsset(x.symbol)}">Add</button>
        </div>`).join('') : '<div class="tiny muted" style="margin-top:8px">No matching US stocks.</div>';
      } catch (e) { if (box) box.innerHTML = '<div class="tiny down" style="margin-top:8px">' + escAsset(e.message) + '</div>'; }
    };

    App.assetAdd = async function (id, ds) {
      if (typeof Remote === 'undefined' || !Remote.enabled) return toastMsg('Connect the sync server first', 'err');
      const btn = document.querySelector('[data-act="asset-add"][data-symbol="' + ds.symbol + '"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
      try {
        const meId = (typeof me === 'function' && me()) ? me().id : '';
        const r = await apiJSON('/api/market/assets/add', { method: 'POST', body: JSON.stringify({ adminId: meId, class: ds.class, symbol: ds.symbol }) }, 40000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return toastMsg((r.data && r.data.error) || 'Could not add asset', 'err');
        toastMsg(r.data.existing ? 'Asset already listed' : 'Asset added to the live Alpaca feed', 'ok');
        try { await Remote.refresh(true); } catch (e) {}
        render();
      } catch (e) { toastMsg('Add failed: ' + e.message, 'err'); }
      finally { if (btn) { btn.disabled = false; btn.textContent = 'Add'; } }
    };
  }

  function escAsset(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  (function styles() {
    if (document.getElementById('assets-multi-style')) return;
    const st = document.createElement('style');
    st.id = 'assets-multi-style';
    st.textContent = `
    .asset-class-badge{display:inline-flex;align-items:center;font-size:8.5px;font-weight:800;letter-spacing:.05em;
      text-transform:uppercase;border-radius:5px;padding:1px 4px;border:1px solid var(--border);color:var(--muted)}
    .asset-class-badge.us{color:#3aa0ff;border-color:rgba(58,160,255,.3);background:rgba(58,160,255,.08)}
    .asset-class-badge.global{color:#8b7bff;border-color:rgba(139,123,255,.3);background:rgba(139,123,255,.08)}
    .asset-class-badge.forex{color:#2ee6c9;border-color:rgba(46,230,201,.3);background:rgba(46,230,201,.08)}
    .asset-class-badge.crypto{color:#ffc861;border-color:rgba(255,200,97,.3);background:rgba(255,200,97,.08)}
    .asset-results{margin-top:8px;max-height:320px;overflow:auto}
    .asset-result{display:flex;gap:9px;align-items:center;padding:8px 9px;border-top:1px solid var(--border)}
    .asset-result:first-child{border-top:none}
    `;
    document.head.appendChild(st);
  })();

  function boot() {
    if (typeof DB === 'undefined' || !DB) return setTimeout(boot, 500);
    const changed = ensureAssets();
    applyList();
    refreshAdmin();
    if (!window.__wcAssetsApplied) {
      window.__wcAssetsApplied = true;
      if (changed) { try { sync(); } catch (e) {} }
      try { render(); } catch (e) {}
    }
    setInterval(() => { try { applyList(); refreshAdmin(); } catch (e) {} }, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
