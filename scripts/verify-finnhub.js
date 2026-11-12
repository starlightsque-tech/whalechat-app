#!/usr/bin/env node
/* Live Finnhub verification for WhaleChat hybrid mode.
   Usage:
     FINNHUB_API_KEY=xxxx node scripts/verify-finnhub.js
     FINNHUB_API_KEY=xxxx node scripts/verify-finnhub.js --fast
   Checks the REST quote endpoint for all 16 WhaleChat tickers (1.2s apart by
   default) and opens the same backend WebSocket subscriptions used in
   production. Run it on the server host so network access matches production. */
'use strict';
const https = require('https');
const TICKERS = ['AAPL','TSLA','NVDA','COIN','MSTR','MARA','KO','JPM','NKE','UNH','AVGO','WMT','DIS','V','UBER','AMZN'];
const key = String(process.env.FINNHUB_API_KEY || '').trim();
const fast = process.argv.includes('--fast');
const delay = fast ? 150 : 1200;
if (!key) { console.error('FINNHUB_API_KEY is required'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'WhaleChat-verify/1' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let data = null; try { data = JSON.parse(body); } catch (e) {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}
function wsClass() {
  if (typeof global.WebSocket === 'function') return global.WebSocket;
  try { return require('ws'); } catch (e) { return null; }
}
(async () => {
  let failures = 0, ok = 0;
  console.log('WhaleChat Finnhub verification · ' + TICKERS.length + ' tickers · spacing ' + delay + 'ms');
  for (const t of TICKERS) {
    const r = await get('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(t) + '&token=' + encodeURIComponent(key));
    if (r.status === 429) { console.log('⚠ ' + t + ' 429 rate limit — wait a minute and retry'); failures++; }
    else if (r.status === 200 && r.data && Number(r.data.c) > 0) {
      ok++;
      console.log('✓ ' + t + ' $' + Number(r.data.c).toFixed(2) + ' · prev ' + Number(r.data.pc || 0).toFixed(2) + ' · ' + new Date().toISOString());
    } else {
      failures++;
      console.log('✗ ' + t + ' HTTP ' + r.status + ' ' + (r.error || JSON.stringify(r.data || {}).slice(0, 120)));
      if (r.status === 401 || r.status === 403) { console.log('  API key rejected — create/copy a key at https://finnhub.io/register'); break; }
    }
    await sleep(delay);
  }
  const WS = wsClass();
  if (!WS) {
    console.log('⚠ WebSocket client unavailable — run `npm install` (ws dependency) and retry');
  } else {
    await new Promise((resolve) => {
      let ticks = 0, done = false;
      const ws = new WS('wss://ws.finnhub.io?token=' + encodeURIComponent(key));
      const finish = (msg) => { if (done) return; done = true; console.log(msg); try { ws.close(); } catch (e) {} resolve(); };
      ws.onopen = () => { TICKERS.forEach((t) => ws.send(JSON.stringify({ type: 'subscribe', symbol: t }))); console.log('✓ WebSocket connected · subscribed to ' + TICKERS.length + ' symbols'); };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
          if (m.type === 'trade' && Array.isArray(m.data)) ticks += m.data.length;
        } catch (e) {}
      };
      ws.onerror = () => finish('✗ WebSocket error (key/permissions/network)');
      ws.onclose = () => finish('• WebSocket closed · ticks received: ' + ticks);
      setTimeout(() => finish(ticks ? '✓ WebSocket live ticks: ' + ticks : '⚠ WebSocket connected but no trades in 20s (market may be closed)'), 20000);
    });
  }
  console.log('\nREST: ' + ok + '/' + TICKERS.length + ' ok · failures: ' + failures);
  process.exit(failures ? 1 : 0);
})();
