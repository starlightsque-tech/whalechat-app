#!/usr/bin/env node
/* Verify Alpaca market data end-to-end: snapshot, bars and corporate actions.
   Usage:
     ALPACA_KEY_ID=... ALPACA_SECRET_KEY=... node scripts/verify-alpaca.js
     node scripts/verify-alpaca.js KEY_ID SECRET [paper|live]
*/
'use strict';
const https = require('https');

const keyId = process.env.ALPACA_KEY_ID || process.argv[2] || '';
const secret = process.env.ALPACA_SECRET_KEY || process.argv[3] || '';
const mode = (process.env.ALPACA_MODE || process.argv[4] || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
const dataBase = (process.env.ALPACA_DATA_BASE || 'https://data.alpaca.markets').replace(/\/+$/, '');
const tradingBase = (process.env.ALPACA_TRADING_BASE || (mode === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets')).replace(/\/+$/, '');
const feed = process.env.ALPACA_FEED || 'iex';

if (!keyId || !secret) {
  console.error('Missing keys. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY (or pass them as arguments).');
  process.exit(1);
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secret,
        'User-Agent': 'WhaleChat-verify/3.26'
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(body); } catch (e) {}
        resolve({ status: res.statusCode || 0, data, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  let failed = false;
  const check = (ok, label, detail) => {
    console.log((ok ? '  OK  ' : ' FAIL ') + ' · ' + label + (detail ? ' · ' + detail : ''));
    if (!ok) failed = true;
  };
  console.log('Alpaca verification · env', mode, '· feed', feed);

  const snap = await get(dataBase + '/v2/stocks/snapshots?symbols=AAPL,MSFT&feed=' + encodeURIComponent(feed));
  const s = snap.data || {};
  const aapl = s.AAPL || {};
  const price = (aapl.latestTrade && aapl.latestTrade.p) || (aapl.minuteBar && aapl.minuteBar.c) || (aapl.dailyBar && aapl.dailyBar.c);
  check(snap.status === 200 && Number(price) > 0, 'snapshots', snap.status + (price ? ' · AAPL $' + Number(price).toFixed(2) : ' · ' + snap.body.slice(0, 120)));

  const bars = await get(dataBase + '/v2/stocks/AAPL/bars?timeframe=1Min&limit=10&feed=' + encodeURIComponent(feed) + '&sort=asc');
  const barList = (bars.data && bars.data.bars) || [];
  check(bars.status === 200 && barList.length > 0, 'historical bars', bars.status + ' · ' + barList.length + ' bar(s)');

  const start = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const div = await get(tradingBase + '/v1/corporate-actions?ca_types=dividend&start=' + start + '&end=' + end + '&symbols=AAPL,MSFT');
  const divs = (div.data && div.data.corporate_actions && div.data.corporate_actions.dividends) || [];
  check(div.status === 200, 'corporate actions', div.status + ' · ' + divs.length + ' dividend(s)');

  const assets = await get(tradingBase + '/v2/assets?status=active&asset_class=us_equity');
  check(assets.status === 200 && Array.isArray(assets.data), 'assets', assets.status + ' · ' + (Array.isArray(assets.data) ? assets.data.length : 0) + ' asset(s)');

  console.log(failed ? '\nAlpaca verification FAILED.' : '\nAlpaca verification passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Alpaca verification error:', e.message); process.exit(1); });
