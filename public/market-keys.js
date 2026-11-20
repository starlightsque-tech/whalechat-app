/* =========================================================================
   WhaleChat admin · Market data hub: Binance + Twelve Data key panels
   Rendered under the Finnhub card in Admin > Markets. Keys are saved through
   /api/connections (server side, durable across releases) and never shown again.

   Twelve Data replaces the old Alpaca panel: it runs alongside Finnhub and
   Binance, so stocks keep updating from whichever provider answers first.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcMarketKeys) return;
  window.__wcMarketKeys = true;

  function url(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.url) return Remote.url(p); } catch (e) {}
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
      '<div class="tiny muted" style="margin-top:3px">Live crypto and meme prices. Saved on the server and re-applied on every restart and release.</div></div>' +
      '<span class="badge badge-warn" id="mktBinBadge">Loading…</span></div>' +
      '<div class="field" style="margin-top:12px"><label class="label">Binance API Key</label>' +
      '<input class="input" id="mktBinKey" type="password" autocomplete="new-password" placeholder="Paste your Binance API key"/>' +
      '<div class="tiny muted mt6" id="mktBinHint">Public prices work without a key. A saved key stays on the server.</div></div>' +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" data-act="mkt-save-binance">Connect Binance</button>' +
      '<button class="btn btn-ghost" data-act="mkt-test-binance">Test Binance</button></div></div>' +

      '<div class="card" id="mktTwelveCard" style="margin-top:12px">' +
      '<div class="between" style="align-items:flex-start;gap:10px"><div><div class="card-title" style="margin:0">Market data · Twelve Data</div>' +
      '<div class="tiny muted" style="margin-top:3px">Live US stock and forex prices, running at the same time as Finnhub. Saved on the server and re-applied on every restart and release.</div></div>' +
      '<span class="badge badge-warn" id="mktTwdBadge">Loading…</span></div>' +
      '<div class="field" style="margin-top:12px"><label class="label">Twelve Data API Key</label>' +
      '<input class="input" id="mktTwdKey" type="password" autocomplete="new-password" placeholder="Paste your Twelve Data API key"/>' +
      '<div class="tiny muted mt6" id="mktTwdHint">One key is enough. Twelve Data covers stocks and forex; Binance covers crypto; Finnhub keeps running next to both.</div></div>' +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" data-act="mkt-save-twelve">Connect Twelve Data</button>' +
      '<button class="btn btn-ghost" data-act="mkt-test-twelve">Test Twelve Data</button></div></div>';
  }

  async function paint() {
    if (!document.getElementById('mktBinanceCard')) return;
    var d = await readStatus();
    if (!d) return;
    var b = d.binance || {}, w = d.twelvedata || {};
    var bb = document.getElementById('mktBinBadge');
    if (bb) {
      var bl = /^binance/.test(b.source || '');
      bb.className = 'badge ' + (bl ? 'badge-success' : 'badge-warn');
      bb.textContent = bl ? 'Live · Binance' : (b.configured ? 'Key saved · connecting' : 'No Binance key');
    }
    var wb = document.getElementById('mktTwdBadge');
    if (wb) {
      var live = (w.live && w.live.source === 'twelvedata') || w.configured;
      wb.className = 'badge ' + (live ? 'badge-success' : 'badge-warn');
      wb.textContent = w.configured ? ('Live · Twelve Data' + (w.live && w.live.ticks ? ' · ' + w.live.ticks + ' ticks' : '')) : 'No Twelve Data key';
    }
    var bh = document.getElementById('mktBinHint');
    if (bh && b.configured) bh.textContent = 'A key is saved on the server. Paste a new one to replace it.';
    var wh = document.getElementById('mktTwdHint');
    if (wh && w.configured) wh.textContent = 'A Twelve Data key is saved on the server. Paste a new one to replace it.';
    if (w.live && w.live.lastError && wh) wh.textContent += ' Last error: ' + w.live.lastError;
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
    App.mktTestBinance = async function () {
      try {
        var d = await post('/api/connections/test', { which: 'binance' });
        var res = (d && d.results && d.results.binance) || {};
        var ok = /^binance/.test(res.source || '');
        toastMsg(ok ? 'Binance is live' : 'Binance not reachable' + (res.lastError ? ' · ' + res.lastError : ''), ok ? 'ok' : 'err');
        paint();
      } catch (e) { toastMsg('Test failed: ' + e.message, 'err'); }
    };
    App.mktSaveTwelve = async function () {
      var key = val('mktTwdKey');
      if (!key) return toastMsg('Paste your Twelve Data API key', 'err');
      try {
        var d = await post('/api/connections', { twelvedata: { enabled: true, apiKey: key }, twelvedataPoll: true });
        if (!d.ok) return toastMsg(d.error || 'Could not save', 'err');
        toastMsg('Twelve Data key saved · connecting…', 'ok');
        await sleep(4000);
        paint();
      } catch (e) { toastMsg('Save failed: ' + e.message, 'err'); }
    };
    App.mktTestTwelve = async function () {
      try {
        await post('/api/connections', { twelvedataPoll: true });
        await sleep(4000);
        var d = await readStatus();
        var live = d && d.twelvedata && d.twelvedata.live;
        var ok = !!(d && d.twelvedata && d.twelvedata.configured) && !(live && live.lastError);
        toastMsg(ok ? 'Twelve Data is connected' + (live && live.ticks ? ' · ' + live.ticks + ' quotes received' : '') : 'Twelve Data not reachable' + (live && live.lastError ? ' · ' + live.lastError : ' · save the key first'), ok ? 'ok' : 'err');
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
