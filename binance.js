/* =========================================================================
   WhaleChat Binance price feed  (server side)

   Adds Binance as a second live price source next to Finnhub. Binance only
   quotes crypto/meme assets, so those tickers get a real Binance price while
   stocks keep coming from Finnhub. Chart history keeps using the existing
   Finnhub/simulated series.

   Public endpoints need no key; an optional API key can be stored from the
   admin panel and is never returned to the browser.
   ========================================================================= */
'use strict';

const https = require('https');

const DEFAULT_MAP = {
  BTCUSDT: 'BTCUSDT', ETHUSDT: 'ETHUSDT', SOLUSDT: 'SOLUSDT', BNBUSDT: 'BNBUSDT',
  XRPUSDT: 'XRPUSDT', DOGEUSDT: 'DOGEUSDT', TRUMPUSDT: 'TRUMPUSDT', ADAUSDT: 'ADAUSDT'
};

function getJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'user-agent': 'whalechat/1.0' }, headers || {}), timeout: 12000 }, (res) => {
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

function createBinanceFeed(opts) {
  const getDb = opts.getDb || (() => null);
  const everyMs = Math.max(5000, Number(opts.everyMs) || 15000);
  const state = {
    enabled: true, lastAt: 0, lastError: '', ticks: 0, source: 'none',
    prices: {}, symbols: Object.keys(DEFAULT_MAP)
  };
  let timer = null;

  function cfg() {
    try {
      const db = getDb();
      return (db && db.settings && db.settings.binance) || {};
    } catch (e) { return {}; }
  }

  function map() {
    const c = cfg();
    if (c.symbols && typeof c.symbols === 'object') return Object.assign({}, DEFAULT_MAP, c.symbols);
    return DEFAULT_MAP;
  }

  /* public price hosts, tried in order — some regions block api.binance.com */
  const HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision', 'https://api1.binance.com'];

  async function fetchTickers(symbols) {
    let lastErr = null;
    for (const host of HOSTS) {
      try {
        const url = host + '/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(symbols)) + '&type=MINI';
        const rows = await getJSON(url);
        if (Array.isArray(rows) && rows.length) { state.host = host; return rows; }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no binance host reachable');
  }

  /* public price endpoint — no key required */
  async function poll() {
    if (cfg().enabled === false) { state.enabled = false; return state; }
    state.enabled = true;
    state.symbols = Object.keys(map());
    try {
      const rows = await fetchTickers(state.symbols);
      const now = Date.now();
      rows.forEach((r) => {
        const symbol = String(r.symbol || '').toUpperCase();
        const price = Number(r.lastPrice);
        const open = Number(r.openPrice);
        if (!(price > 0)) return;
        state.prices[symbol] = {
          price,
          openPrice: open > 0 ? open : price,
          changePct: open > 0 ? ((price - open) / open) * 100 : 0,
          high: Number(r.highPrice) || price,
          low: Number(r.lowPrice) || price,
          quoteVolume: Number(r.quoteVolume) || 0,
          at: now
        };
      });
      state.lastAt = now; state.ticks++; state.source = 'binance'; state.lastError = '';
      try {
        const c = cfg();
        if (c.enabled !== false) {
          const db = getDb();
          if (db) {
            if (!db.settings) db.settings = {};
            db.settings.binanceStatus = { at: now, symbols: state.symbols.length, source: 'binance' };
          }
        }
      } catch (e) {}
    } catch (e) {
      state.lastError = e.message;
      state.source = 'error';
    }
    return state;
  }

  function start() {
    if (timer) return;
    poll();
    timer = setInterval(() => { poll().catch(() => {}); }, everyMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  function status() {
    const c = cfg();
    return {
      enabled: c.enabled !== false,
      hasKey: !!c.apiKey,
      symbols: state.symbols,
      ticks: state.ticks,
      lastAt: state.lastAt,
      lastError: state.lastError,
      source: state.source,
      host: state.host || null,
      prices: state.prices
    };
  }

  return { poll, start, stop, status, map, DEFAULT_MAP };
}

module.exports = { createBinanceFeed, DEFAULT_MAP };
