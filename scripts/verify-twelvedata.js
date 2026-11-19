#!/usr/bin/env node
/* Verify Twelve Data end-to-end: quote endpoint, plan/credits and one symbol.
   Usage:
     TWELVEDATA_API_KEY=... node scripts/verify-twelvedata.js
     node scripts/verify-twelvedata.js <API_KEY> [SYMBOL]
*/
'use strict';
const https = require('https');

const key = process.env.TWELVEDATA_API_KEY || process.argv[2] || '';
const symbol = String(process.env.TWELVEDATA_SYMBOL || process.argv[3] || 'AAPL').toUpperCase();

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { accept: 'application/json', 'user-agent': 'whalechat-verify/1.0' } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b.slice(0, 200))); } });
    }).on('error', reject);
  });
}

(async () => {
  if (!key) {
    console.error('Missing key. Set TWELVEDATA_API_KEY or pass it as the first argument.');
    process.exit(2);
  }
  console.log('Twelve Data verification · symbol', symbol);
  const q = await getJSON('https://api.twelvedata.com/quote?symbol=' + encodeURIComponent(symbol) + '&apikey=' + encodeURIComponent(key));
  if (q.status === 'error' || !q.close) {
    console.error('Quote FAILED:', q.message || q.code || 'no close price');
    process.exit(1);
  }
  console.log('quote ok · ' + symbol + ' $' + q.close + ' (' + (q.percent_change || 0) + '%) · ' + q.exchange + ' · ' + q.currency);
  const api = await getJSON('https://api.twelvedata.com/api_usage?apikey=' + encodeURIComponent(key));
  if (api && api.current_usage != null) console.log('credits used this minute:', api.current_usage + '/' + (api.plan_limit || '?'));
  console.log('\nTwelve Data verification passed.');
})().catch((e) => { console.error('Twelve Data verification error:', e.message); process.exit(1); });
