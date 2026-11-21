/* =========================================================================
   WhaleChat Twelve Data price feed (server side)

   Twelve Data covers US stocks, global equities, forex pairs and crypto
   pairs from one REST endpoint, which makes it the widest single source the
   app can use. The admin saves the key in Admin > Market data hub (or the
   connection registry keeps it across deploys) and it is never returned to a
   browser.

   Quotes are polled in batches and fed into the shared market cache through
   onTick(), exactly like the Alpaca and Binance feeds, so trades, charts and
   portfolio values pick the price up with no extra wiring.

   Symbol mapping (WhaleChat ticker -> Twelve Data symbol):
     AAPL            -> AAPL
     VOD_L (VOD.L)   -> VOD.L        (global equities keep their suffix)
     BTCUSDT         -> BTC/USDT     (crypto pairs get a slash)
     EURUSD          -> EUR/USD      (forex pairs get a slash)
   ========================================================================= */
'use strict';
const https = require('https');

function getJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ accept: 'application/json', 'user-agent': 'whalechat/1.0' }, headers), timeout: 15000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* Twelve Data uses a slash between the two legs of crypto and forex pairs */
function toTwelveSymbol(ticker) {
  const raw = String(ticker || '').toUpperCase().trim();
  if (!raw) return '';
  /* global listings are stored with an underscore in some catalogues (VOD_L) */
  if (/^[A-Z0-9]+_[A-Z]{1,3}$/.test(raw)) return raw.replace('_', '.');
  if (/^(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|TRUMP|LTC|AVAX|DOT|MATIC|LINK|SHIB|TON|SUI|PEPE)(USDT|USD|BTC|ETH)$/.test(raw)) {
    const m = raw.match(/^([A-Z]+)(USDT|USD|BTC|ETH)$/);
    return m[1] + '/' + m[2];
  }
  if (/^[A-Z]{6}$/.test(raw) && /^(EUR|GBP|USD|JPY|AUD|CAD|CHF|NZD|CNY)/.test(raw)) {
    return raw.slice(0, 3) + '/' + raw.slice(3);
  }
  return raw;
}

/* map a Twelve Data response key back to the catalogue ticker */
function fromTwelveSymbol(twelveSym, catalogue) {
  const want = String(twelveSym || '').toUpperCase().replace('/', '').replace('.', '_');
  const hit = (catalogue || []).find((t) => String(t).toUpperCase().replace(/[^A-Z0-9]/g, '') === want.replace(/[^A-Z0-9]/g, ''));
  return hit || String(twelveSym || '').toUpperCase().replace('/', '');
}

function createTwelveFeed(opts) {
  const getDb = opts.getDb || (() => null);
  const getTickers = opts.getTickers || (() => []);
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
  const everyMs = Math.max(15000, Number(opts.everyMs) || 60000);
  const maxSymbols = Math.min(120, Number(opts.maxSymbols) || 40);
  const state = { lastAt: 0, lastError: '', ticks: 0, symbols: 0, source: 'none', credits: null };
  let timer = null;

  function cfg() {
    try { const db = getDb(); return (db && db.settings && db.settings.twelvedata) || {}; } catch (e) { return {}; }
  }
  function apiKey() { return cfg().apiKey || process.env.TWELVEDATA_API_KEY || ''; }
  function hasKey() { return !!apiKey(); }

  async function poll() {
    const key = apiKey();
    const c = cfg();
    if (!key || c.enabled === false) { state.source = 'none'; return state; }
    let list = [];
    try { list = getTickers() || []; } catch (e) {}
    const pairs = list
      .map((t) => ({ ticker: t, twelve: toTwelveSymbol(t) }))
      .filter((p) => p.twelve && /^[A-Z0-9./:_-]{2,20}$/.test(p.twelve))
      .slice(0, maxSymbols);
    state.symbols = pairs.length;
    if (!pairs.length) { state.source = 'idle'; return state; }
    const base = (process.env.TWELVEDATA_BASE || 'https://api.twelvedata.com').replace(/\/+$/, '');
    try {
      let got = 0;
      /* Twelve Data accepts a comma separated symbol list and answers with an
         object keyed by the symbol (or a single object for one symbol) */
      for (let i = 0; i < pairs.length; i += 20) {
        const chunk = pairs.slice(i, i + 20);
        const url = base + '/quote?symbol=' + encodeURIComponent(chunk.map((p) => p.twelve).join(',')) + '&apikey=' + encodeURIComponent(key);
        const data = await getJSON(url);
        if (data && data.status === 'error') throw new Error(data.message || 'twelvedata error');
        const rows = chunk.length === 1 && data && data.symbol ? { [data.symbol]: data } : (data || {});
        Object.keys(rows).forEach((sym) => {
          const row = rows[sym] || {};
          const price = Number(row.close) || Number(row.price) || Number(row.previous_close);
          if (price > 0 && onTick) {
            try { onTick(fromTwelveSymbol(row.symbol || sym, pairs.map((p) => p.ticker)), price); got++; } catch (e) {}
          }
        });
      }
      state.lastAt = Date.now(); state.ticks += got; state.lastError = ''; state.source = 'twelvedata';
    } catch (e) {
      state.lastError = e.message; state.source = 'error';
    }
    return state;
  }

  function start() {
    if (timer) return;
    poll().catch(() => {});
    timer = setInterval(() => poll().catch(() => {}), everyMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function status() {
    return { hasKey: hasKey(), enabled: cfg().enabled !== false, source: state.source, symbols: state.symbols, ticks: state.ticks, lastAt: state.lastAt, lastError: state.lastError, everySec: Math.round(everyMs / 1000) };
  }
  return { start, stop, poll, status, toTwelveSymbol };
}

module.exports = { createTwelveFeed, toTwelveSymbol };
