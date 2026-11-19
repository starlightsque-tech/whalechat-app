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
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
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
    /* 1) the provider catalogue owned by Binance (20-50 pairs), 2) an admin
       override, 3) the built-in fallback map */
    try {
      const dyn = typeof opts.getSymbols === 'function' ? opts.getSymbols() : null;
      if (Array.isArray(dyn) && dyn.length) {
        const o = {};
        dyn.map((x) => String(x || '').toUpperCase()).filter(Boolean).forEach((t) => { o[t] = t; });
        if (Object.keys(o).length) return o;
      }
    } catch (e) {}
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
        /* REST snapshots seed every pair immediately — the WebSocket then
           keeps them moving tick by tick between polls */
        if (onTick) { try { onTick(symbol, price); } catch (e) {} }
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

  /* ---- live websocket stream (miniTicker) --------------------------------
     REST gives the 24h snapshot, the websocket gives every trade so the chart
     and the alerts move with the real market between polls. */
  let ws = null, wsRetry = 0, wsStop = false;
  function wsStatus() {
    return { connected: !!(ws && ws.readyState === 1), retry: wsRetry, url: state.wsUrl || null, ticks: state.wsTicks || 0 };
  }
  function connectWS() {
    if (wsStop) return;
    let WebSocket = null;
    try { WebSocket = require('ws'); } catch (e) { return; }
    const syms = Object.keys(map()).map(s => s.toLowerCase() + '@miniTicker').join('/');
    /* alternate hosts: some server regions (e.g. US) are refused by stream.binance.com */
    const hosts = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];
    const url = hosts[(wsRetry || 0) % hosts.length] + '/stream?streams=' + syms;
    state.wsUrl = url;
    try { ws = new WebSocket(url); } catch (e) { return; }
    ws.on('open', () => { wsRetry = 0; state.wsConnected = true; state.lastError = ''; });
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const d = msg && msg.data;
        if (!d || !d.s) return;
        const symbol = String(d.s).toUpperCase();
        const price = Number(d.c);
        if (!(price > 0)) return;
        const open = Number(d.o) || price;
        state.prices[symbol] = {
          price,
          openPrice: open,
          changePct: open ? ((price - open) / open) * 100 : 0,
          high: Number(d.h) || price,
          low: Number(d.l) || price,
          quoteVolume: Number(d.q) || 0,
          at: Date.now(),
          source: 'binance-ws'
        };
        state.wsTicks = (state.wsTicks || 0) + 1;
        if (onTick) { try { onTick(symbol, price); } catch (e) {} }
        state.lastAt = Date.now();
        state.source = 'binance-ws';
      } catch (e) {}
    });
    ws.on('close', () => {
      state.wsConnected = false;
      if (wsStop) return;
      wsRetry++;
      const wait = Math.min(30000, 1000 * Math.pow(2, Math.min(5, wsRetry)));
      setTimeout(connectWS, wait).unref && setTimeout(connectWS, wait).unref();
    });
    ws.on('error', () => { state.lastError = 'ws error'; state.wsConnected = false; });
  }

  function start() {
    if (timer) return;
    poll();
    connectWS();
    timer = setInterval(() => { poll().catch(() => {}); }, everyMs);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer); timer = null;
    wsStop = true;
    try { if (ws) ws.close(); } catch (e) {}
  }

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
      ws: wsStatus(),
      prices: state.prices
    };
  }

  return { poll, start, stop, status, map, DEFAULT_MAP };
}

module.exports = { createBinanceFeed, DEFAULT_MAP };
