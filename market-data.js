/* =========================================================================
   WhaleChat market data proxy (server side)
   Binance / Finnhub / Twelve Data are only ever called from here. The browser
   talks to /api/market/symbols|quote|candles|symbol-search and /ws/market.
   - quote cache 5s, candle cache 30s
   - provider failure -> last cached value flagged delayed:true
   - never a made-up price: no demo/synthetic quotes or candles (3.46)
   - when market-admin is wired in, quote() is answered from market_price_cache
   ========================================================================= */
'use strict';
const https = require('https');
const crypto = require('crypto');

const QUOTE_TTL = 5000, CANDLE_TTL = 30000;
const TFS = { '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '4H': 14400, '1D': 86400 };
const CRYPTO = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','TRXUSDT','DOTUSDT','LTCUSDT'];
const STOCKS = ['AAPL','MSFT','NVDA','TSLA','AMZN','GOOGL','META','NFLX','AMD','JPM','V','DIS'];
const FOREX = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','EURGBP'];

function getJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'user-agent': 'whalechat/1.0' }, headers || {}), timeout: 10000 }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function kindOf(sym) {
  sym = String(sym || '').toUpperCase();
  if (/USDT$|USDC$|BUSD$/.test(sym) && sym.length > 5) return 'crypto';
  if (FOREX.includes(sym) || (/^[A-Z]{6}$/.test(sym) && /(USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD)/.test(sym) && !STOCKS.includes(sym))) return 'forex';
  return 'stocks';
}
const fxPair = (s) => s.slice(0, 3) + '/' + s.slice(3);

function createMarketData(opts) {
  const conn = opts.connections;             // connections.js registry
  const log = opts.log || (() => {});
  const qCache = new Map(), cCache = new Map();
  const health = { binance: { state: 'not_connected' }, finnhub: { state: 'not_connected' }, twelvedata: { state: 'not_connected' } };

  function cfg() {
    const s = (conn && conn.stored()) || {};
    const m = s.marketData || {};
    return {
      binance: { apiKey: (s.binance || {}).apiKey || '', secret: (m.binance || {}).secret || '', testnet: !!(m.binance || {}).testnet },
      finnhub: { apiKey: (s.finnhub || {}).apiKey || '' },
      twelvedata: { apiKey: (m.twelvedata || {}).apiKey || '' }
    };
  }
  const binBase = (c) => c.binance.testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';

  function setHealth(p, ok, err) { health[p] = ok ? { state: 'connected', at: Date.now() } : { state: 'error', error: String(err && err.message || err), at: Date.now() }; }

  /* ---------- providers ---------- */
  async function quoteRaw(sym) {
    const c = cfg(), k = kindOf(sym);
    if (k === 'crypto') {
      const d = await getJSON(binBase(c) + '/api/v3/ticker/24hr?symbol=' + sym);
      setHealth('binance', true);
      return { symbol: sym, price: +d.lastPrice, change: +d.priceChange, changePct: +d.priceChangePercent, high: +d.highPrice, low: +d.lowPrice, volume: +d.volume, source: 'binance' };
    }
    if (k === 'stocks' && c.finnhub.apiKey) {
      const d = await getJSON('https://finnhub.io/api/v1/quote?symbol=' + sym + '&token=' + encodeURIComponent(c.finnhub.apiKey));
      if (!d || !d.c) throw new Error('no quote');
      setHealth('finnhub', true);
      return { symbol: sym, price: d.c, change: d.d, changePct: d.dp, high: d.h, low: d.l, source: 'finnhub' };
    }
    if (c.twelvedata.apiKey) {
      const d = await getJSON('https://api.twelvedata.com/quote?symbol=' + encodeURIComponent(k === 'forex' ? fxPair(sym) : sym) + '&apikey=' + encodeURIComponent(c.twelvedata.apiKey));
      if (d.status === 'error' || !d.close) throw new Error(d.message || 'no quote');
      setHealth('twelvedata', true);
      return { symbol: sym, price: +d.close, change: +d.change, changePct: +d.percent_change, high: +d.high, low: +d.low, source: 'twelvedata' };
    }
    return null;
  }

  let quoteSource = null;   // market-admin: provider-only market_price_cache
  function setQuoteSource(fn) { quoteSource = typeof fn === 'function' ? fn : null; }

  async function quote(symbol) {
    const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!sym) throw new Error('symbol required');
    if (quoteSource) return quoteSource(sym);
    const hit = qCache.get(sym);
    if (hit && Date.now() - hit.at < QUOTE_TTL) return hit.v;
    try {
      const q = await quoteRaw(sym);
      if (!q) throw new Error('no provider configured for ' + sym);
      q.ts = Date.now(); q.delayed = false; q.is_delayed = false;
      qCache.set(sym, { at: Date.now(), v: q, real: true });
      return q;
    } catch (e) {
      const pv = kindOf(sym) === 'crypto' ? 'binance' : (cfg().finnhub.apiKey && kindOf(sym) === 'stocks' ? 'finnhub' : 'twelvedata');
      setHealth(pv, false, e);
      if (hit && hit.real) { const v = Object.assign({}, hit.v, { delayed: true, is_delayed: true, label: 'Delayed Data', stale: Date.now() - hit.v.ts }); return v; }
      throw new Error('no_price');
    }
  }

  async function candlesRaw(sym, tf) {
    const c = cfg(), k = kindOf(sym), sec = TFS[tf];
    if (k === 'crypto') {
      const iv = { '1m': '1m', '5m': '5m', '15m': '15m', '1H': '1h', '4H': '4h', '1D': '1d' }[tf];
      const a = await getJSON(binBase(c) + '/api/v3/klines?symbol=' + sym + '&interval=' + iv + '&limit=500');
      setHealth('binance', true);
      return { source: 'binance', candles: a.map((r) => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })) };
    }
    if (c.twelvedata.apiKey) {
      const iv = { '1m': '1min', '5m': '5min', '15m': '15min', '1H': '1h', '4H': '4h', '1D': '1day' }[tf];
      const d = await getJSON('https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(k === 'forex' ? fxPair(sym) : sym) + '&interval=' + iv + '&outputsize=300&timezone=UTC&apikey=' + encodeURIComponent(c.twelvedata.apiKey));
      if (d.status === 'error' || !Array.isArray(d.values)) throw new Error(d.message || 'no candles');
      setHealth('twelvedata', true);
      return { source: 'twelvedata', candles: d.values.slice().reverse().map((r) => ({ time: Math.floor(Date.parse(r.datetime.replace(' ', 'T') + 'Z') / 1000), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +(r.volume || 0) })) };
    }
    if (k === 'stocks' && c.finnhub.apiKey) {
      const res = { '1m': '1', '5m': '5', '15m': '15', '1H': '60', '4H': '60', '1D': 'D' }[tf];
      const to = Math.floor(Date.now() / 1000), from = to - (tf === '1D' ? 400 * 86400 : tf === '1m' ? 2 * 86400 : tf === '4H' ? 60 * 86400 : 20 * 86400);
      const d = await getJSON('https://finnhub.io/api/v1/stock/candle?symbol=' + sym + '&resolution=' + res + '&from=' + from + '&to=' + to + '&token=' + encodeURIComponent(c.finnhub.apiKey));
      if (d.s !== 'ok') throw new Error('no candles (Finnhub plan may not include candles)');
      setHealth('finnhub', true);
      let list = d.t.map((t, i) => ({ time: t, open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i], volume: d.v[i] }));
      if (tf === '4H') list = aggregate(list, 14400);
      return { source: 'finnhub', candles: list };
    }
    return null;
  }
  function aggregate(list, sec) {
    const out = []; let cur = null;
    list.forEach((c) => {
      const b = Math.floor(c.time / sec) * sec;
      if (!cur || cur.time !== b) { cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; out.push(cur); }
      else { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume += c.volume; }
    });
    return out;
  }
  async function candles(symbol, tf) {
    const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!TFS[tf]) tf = '1H';
    const key = sym + '|' + tf, hit = cCache.get(key);
    if (hit && Date.now() - hit.at < CANDLE_TTL) return hit.v;
    try {
      const r = await candlesRaw(sym, tf);
      if (!r) return { symbol: sym, tf, source: null, candles: [], delayed: false, error: 'no_provider' };
      const v = { symbol: sym, tf, source: r.source, candles: r.candles, delayed: false };
      cCache.set(key, { at: Date.now(), v, real: true });
      return v;
    } catch (e) {
      log('[market-data] candles ' + sym + ': ' + e.message);
      if (hit && hit.real) return Object.assign({}, hit.v, { delayed: true, label: 'Delayed Data' });
      return { symbol: sym, tf, source: null, delayed: true, label: 'Delayed Data', error: 'provider_unavailable', candles: [] };
    }
  }

  function symbols(type) {
    const t = String(type || 'crypto').toLowerCase();
    const list = t === 'forex' ? FOREX : t === 'stocks' || t === 'us' ? STOCKS : CRYPTO;
    return list.map((s) => ({ symbol: s, type: t === 'us' ? 'stocks' : t }));
  }

  async function search(q) {
    q = String(q || '').trim().toUpperCase();
    if (!q) return [];
    const all = [].concat(symbols('crypto'), symbols('stocks'), symbols('forex')).filter((x) => x.symbol.includes(q));
    const c = cfg();
    if (c.finnhub.apiKey && all.length < 5) {
      try {
        const d = await getJSON('https://finnhub.io/api/v1/search?q=' + encodeURIComponent(q) + '&token=' + encodeURIComponent(c.finnhub.apiKey));
        (d.result || []).slice(0, 8).forEach((r) => { if (!all.some((x) => x.symbol === r.symbol)) all.push({ symbol: r.symbol, type: 'stocks', name: r.description }); });
      } catch (e) {}
    }
    return all.slice(0, 20);
  }

  /* ---------- admin: status / save / test ---------- */
  function status() {
    const c = cfg();
    const st = (p, has) => has ? (health[p].state === 'not_connected' ? { state: 'connected', note: 'key saved' } : health[p]) : { state: 'not_connected' };
    return {
      binance: { hasKey: !!c.binance.apiKey, hasSecret: !!c.binance.secret, testnet: c.binance.testnet, status: health.binance.state === 'error' ? health.binance : { state: 'connected', note: c.binance.apiKey ? 'key saved' : 'public data' } },
      finnhub: { hasKey: !!c.finnhub.apiKey, status: st('finnhub', !!c.finnhub.apiKey) },
      twelvedata: { hasKey: !!c.twelvedata.apiKey, status: st('twelvedata', !!c.twelvedata.apiKey) }
    };
  }
  function save(body) {
    const cur = cfg(), s = (conn.stored() || {}).marketData || {};
    const v = (x) => (x == null ? '' : String(x).trim());
    if (body.binance) {
      if (v(body.binance.apiKey)) conn.saveFrom({ binance: { apiKey: v(body.binance.apiKey) } });
      s.binance = { secret: v(body.binance.secret) || (s.binance || {}).secret || '', testnet: body.binance.testnet === true };
    }
    if (body.finnhub && v(body.finnhub.apiKey)) conn.saveFrom({ finnhub: { apiKey: v(body.finnhub.apiKey) } });
    if (body.twelvedata) s.twelvedata = { apiKey: v(body.twelvedata.apiKey) || (s.twelvedata || {}).apiKey || '' };
    conn.saveExtra('marketData', s);
    qCache.clear(); cCache.clear();
    return status();
  }
  async function test(which) {
    const c = cfg();
    try {
      if (which === 'binance') {
        await getJSON(binBase(c) + '/api/v3/ping');
        if (c.binance.apiKey && c.binance.secret) {
          const qs = 'timestamp=' + Date.now(), sig = crypto.createHmac('sha256', c.binance.secret).update(qs).digest('hex');
          await getJSON(binBase(c) + '/api/v3/account?' + qs + '&signature=' + sig, { 'X-MBX-APIKEY': c.binance.apiKey });
        } else if (c.binance.apiKey) {
          await getJSON(binBase(c) + '/api/v3/ticker/price?symbol=BTCUSDT');
        }
        setHealth('binance', true);
      } else if (which === 'finnhub') {
        if (!c.finnhub.apiKey) throw new Error('no key saved');
        const d = await getJSON('https://finnhub.io/api/v1/quote?symbol=AAPL&token=' + encodeURIComponent(c.finnhub.apiKey));
        if (!d || !d.c) throw new Error('key rejected or no data');
        setHealth('finnhub', true);
      } else if (which === 'twelvedata') {
        if (!c.twelvedata.apiKey) throw new Error('no key saved');
        const d = await getJSON('https://api.twelvedata.com/price?symbol=AAPL&apikey=' + encodeURIComponent(c.twelvedata.apiKey));
        if (d.status === 'error' || !d.price) throw new Error(d.message || 'key rejected');
        setHealth('twelvedata', true);
      } else throw new Error('unknown provider');
    } catch (e) { setHealth(which, false, e); }
    return status()[which];
  }

  /* ---------- websocket /ws/market ---------- */
  function attachWs(server) {
    let WS; try { WS = require('ws'); } catch (e) { return; }
    const wss = new WS.Server({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      let p = ''; try { p = new URL(req.url, 'http://x').pathname; } catch (e) {}
      if (p !== '/ws/market') return;   // other upgrade handlers keep working
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    });
    wss.on('connection', (ws) => {
      ws.syms = new Set();
      ws.on('message', (m) => { try { const d = JSON.parse(String(m)); if (d.sub) { ws.syms = new Set([String(d.sub).toUpperCase()]); push(ws); } } catch (e) {} });
      ws.on('error', () => {});
    });
    async function push(ws) {
      for (const s of ws.syms) { try { const q = await quote(s); if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'quote', quote: q })); } catch (e) {} }
    }
    const t = setInterval(() => { wss.clients.forEach(push); }, 3000);
    if (t.unref) t.unref();
  }

  return { quote, candles, symbols, search, status, save, test, attachWs, kindOf, setQuoteSource };
}
module.exports = { createMarketData };
