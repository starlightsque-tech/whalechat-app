/* =========================================================================
   WhaleChat admin · Market data hub: Binance + Alpaca key panels
   Rendered under the Finnhub card in Admin > Markets. Keys are saved through
   /api/connections (server side, durable across releases) and never shown again.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcMarketKeys) return;
  window.__wcMarketKeys = true;

  function url(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.url) return Remote.url(p); } catch (e) {}
    return p;
  }
  function adminId() { try { var u = me(); return u && u.id; } catch (e) { return ''; } }
  function toastMsg(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }
  function val(id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function readStatus() {
    try {
      var r = await fetch(url('/api/connections?adminId=' + encodeURIComponent(adminId())), { headers: { accept: 'application/json' } });
      var d = await r.json();
      return d && d.ok ? d : null;
    } catch (e) { return null; }
  }
  async function post(path, body) {
    body.adminId = adminId();
    var r = await fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }

  function html() {
    return '<div class="card" id="mktBinanceCard" style="margin-top:12px">' +
      '<div class="between" style="align-items:flex-start;gap:10px"><div><div class="card-title" style="margin:0">Market data · Binance</div>' +
      '<div class="tiny muted" style="margin-top:3px">Live crypto prices. Saved on the server and re-applied on every restart and release.</div></div>' +
      '<span class="badge badge-warn" id="mktBinBadge">Loading…</span></div>' +
      '<div class="field" style="margin-top:12px"><label class="label">Binance API Key</label>' +
      '<input class="input" id="mktBinKey" type="password" autocomplete="new-password" placeholder="Paste your Binance API key"/>' +
      '<div class="tiny muted mt6" id="mktBinHint">Public prices work without a key. A saved key stays on the server.</div></div>' +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" data-act="mkt-save-binance">Connect Binance</button>' +
      '<button class="btn btn-ghost" data-act="mkt-test-binance">Test Binance</button></div></div>' +

      '<div class="card" id="mktAlpacaCard" style="margin-top:12px">' +
      '<div class="between" style="align-items:flex-start;gap:10px"><div><div class="card-title" style="margin:0">Market data · Alpaca</div>' +
      '<div class="tiny muted" style="margin-top:3px">Live US stock prices. Saved on the server and re-applied on every restart and release.</div></div>' +
      '<span class="badge badge-warn" id="mktAlpBadge">Loading…</span></div>' +
      '<div class="field" style="margin-top:12px"><label class="label">Alpaca API Key ID</label>' +
      '<input class="input" id="mktAlpKey" type="password" autocomplete="new-password" placeholder="Paste your Alpaca key ID"/></div>' +
      '<div class="field"><label class="label">Alpaca Secret Key</label>' +
      '<input class="input" id="mktAlpSecret" type="password" autocomplete="new-password" placeholder="Paste your Alpaca secret key"/>' +
      '<div class="tiny muted mt6" id="mktAlpHint">Alpaca needs both the key ID and the secret.</div></div>' +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" data-act="mkt-save-alpaca">Connect Alpaca</button>' +
      '<button class="btn btn-ghost" data-act="mkt-test-alpaca">Test Alpaca</button></div></div>';
  }

  async function paint() {
    if (!document.getElementById('mktBinanceCard')) return;
    var d = await readStatus();
    if (!d) return;
    var b = d.binance || {}, a = d.alpaca || {};
    var bb = document.getElementById('mktBinBadge');
    if (bb) {
      var bl = /^binance/.test(b.source || '');
      bb.className = 'badge ' + (bl ? 'badge-success' : 'badge-warn');
      bb.textContent = bl ? 'Live · Binance' : (b.configured ? 'Key saved · connecting' : 'No Binance key');
    }
    var ab = document.getElementById('mktAlpBadge');
    if (ab) {
      var al = a.live && a.live.source === 'alpaca';
      ab.className = 'badge ' + (al ? 'badge-success' : 'badge-warn');
      ab.textContent = al ? 'Live · Alpaca' : (a.configured ? 'Key saved · connecting' : 'No Alpaca key');
    }
    var bh = document.getElementById('mktBinHint');
    if (bh && b.configured) bh.textContent = 'A key is saved on the server. Paste a new one to replace it.';
    var ah = document.getElementById('mktAlpHint');
    if (ah) ah.textContent = a.configured ? 'Keys are saved on the server. Paste new ones to replace them.' : 'Alpaca needs both the key ID and the secret.';
    if (a.live && a.live.lastError) { if (ah) ah.textContent += ' Last error: ' + a.live.lastError; }
  }

  function inject() {
    var card = document.getElementById('mktFeedCard');
    if (!card || document.getElementById('mktBinanceCard')) return;
    card.insertAdjacentHTML('afterend', html());
    paint();
  }

  if (typeof App !== 'undefined') {
    App.mktSaveBinance = async function () {
      try {
        var d = await post('/api/connections', { binance: { enabled: true, apiKey: val('mktBinKey') } });
        if (!d.ok) return toastMsg(d.error || 'Could not save', 'err');
        toastMsg('Binance connected · saved on the server', 'ok');
        paint();
      } catch (e) { toastMsg('Save failed: ' + e.message, 'err'); }
    };
    App.mktSaveAlpaca = async function () {
      var keyId = val('mktAlpKey'), secret = val('mktAlpSecret');
      if (!keyId || !secret) return toastMsg('Alpaca needs both the key ID and the secret', 'err');
      try {
        var d = await post('/api/connections', { alpaca: { enabled: true, keyId: keyId, secret: secret }, alpacaPoll: true });
        if (!d.ok) return toastMsg(d.error || 'Could not save', 'err');
        toastMsg('Alpaca keys saved · connecting…', 'ok');
        await sleep(3500);
        paint();
      } catch (e) { toastMsg('Save failed: ' + e.message, 'err'); }
    };
    App.mktTestBinance = async function () {
      try {
        var d = await post('/api/connections/test', { which: 'binance' });
        var res = (d && d.results && d.results.binance) || {};
        var ok = /^binance/.test(res.source || '');
        toastMsg(ok ? 'Binance is live' : 'Binance not reachable' + (res.lastError ? ' · ' + res.lastError : ''), ok ? 'ok' : 'err');
        paint();
      } catch (e) { toastMsg('Test failed: ' + e.message, 'err'); }
    };
    App.mktTestAlpaca = async function () {
      try {
        await post('/api/connections', { alpacaPoll: true });
        await sleep(3500);
        var d = await readStatus();
        var live = d && d.alpaca && d.alpaca.live;
        var ok = live && live.source === 'alpaca';
        toastMsg(ok ? 'Alpaca is live' : (d && d.alpaca && d.alpaca.configured ? 'Alpaca not reachable' + (live && live.lastError ? ' · ' + live.lastError : '') : 'Save the Alpaca keys first'), ok ? 'ok' : 'err');
        paint();
      } catch (e) { toastMsg('Test failed: ' + e.message, 'err'); }
    };
  }

  var timer = null;
  new MutationObserver(function () {
    if (timer) return;
    timer = setTimeout(function () { timer = null; try { inject(); } catch (e) {} }, 200);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(paint, 10000);
})();
