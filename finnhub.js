/* WhaleChat chart data provider — Finnhub
   - real market candles for the stock chart (1D / 1W / 1M / 3M / 1Y / ALL)
   - real-time quote endpoint used for the chart's latest point
   - key stays on the server (env FINNHUB_API_KEY or Admin -> Stocks) and is
     never sent to a browser. Every response is cached to respect the free
     tier rate limit (60 calls/min). */
'use strict';
const https = require('https');

const BASE = 'https://finnhub.io/api/v1';

/* timeframe -> Finnhub resolution + lookback + points we keep */
const TF = {
  '1D': { res: '5', back: 2 * 864e5, max: 900 },
  '1W': { res: '15', back: 7 * 864e5, max: 900 },
  '1M': { res: '60', back: 30 * 864e5, max: 900 },
  '3M': { res: 'D', back: 92 * 864e5, max: 900 },
  '1Y': { res: 'D', back: 366 * 864e5, max: 900 },
  'ALL': { res: 'W', back: 5 * 365 * 864e5, max: 900 }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url, timeoutMs, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs || 12000,
      headers: Object.assign({ Accept: 'application/json', 'User-Agent': 'WhaleChat/3.28 finnhub-chart' }, headers || {})
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(body); } catch (e) {}
        resolve({ status: res.statusCode || 0, data, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Finnhub timeout')));
    req.on('error', reject);
  });
}

class FinnhubClient {
  constructor(opts) {
    const o = opts || {};
    this.getKey = o.getKey || (() => '');
    this.cache = new Map();
    this.calls = [];
    this.maxCallsPerMin = Math.max(10, Math.min(60, Number(process.env.FINNHUB_MAX_CALLS_PER_MIN) || 50));
    this.lastOkAt = 0;
    this.lastError = '';
    this.lastErrorAt = 0;
    this.lastLatencyMs = 0;
  }

  configured() { return !!String(this.getKey() || '').trim(); }

  async reserve() {
    for (let guard = 0; guard < 40; guard++) {
      const now = Date.now();
      this.calls = this.calls.filter((t) => now - t < 60000);
      if (this.calls.length < this.maxCallsPerMin) { this.calls.push(now); return; }
      await sleep(Math.max(300, 60000 - (now - this.calls[0]) + 120));
    }
  }

  async call(pathname, params, cacheMs) {
    const key = String(this.getKey() || '').trim();
    if (!key) { const e = new Error('No Finnhub API key saved'); e.code = 'no_key'; throw e; }
    const qs = Object.keys(params || {}).map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
    const url = BASE + pathname + (qs ? '?' + qs : '');
    const cacheKey = url;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < (cacheMs || 30000)) return hit.data;
    await this.reserve();
    const t0 = Date.now();
    const r = await getJSON(url, 15000, { 'X-Finnhub-Token': key });
    this.lastLatencyMs = Date.now() - t0;
    if (r.status === 401 || r.status === 403) {
      const msg = (r.data && (r.data.error || r.data.message)) || ('Finnhub HTTP ' + r.status);
      this.lastError = msg; this.lastErrorAt = Date.now();
      const e = new Error(msg); e.code = r.status; throw e;
    }
    if (r.status === 429) {
      this.lastError = 'Finnhub rate limit'; this.lastErrorAt = Date.now();
      const e = new Error('Finnhub rate limit — retrying shortly'); e.code = 429; throw e;
    }
    if (r.status !== 200 || !r.data) {
      const msg = (r.data && (r.data.error || r.data.message)) || ('Finnhub HTTP ' + r.status);
      this.lastError = msg; this.lastErrorAt = Date.now();
      const e = new Error(msg); e.code = r.status; throw e;
    }
    this.lastOkAt = Date.now();
    this.lastError = '';
    this.cache.set(cacheKey, { at: Date.now(), data: r.data });
    if (this.cache.size > 400) {
      const oldest = Array.from(this.cache.keys()).slice(0, 100);
      oldest.forEach((k) => this.cache.delete(k));
    }
    return r.data;
  }

  async quote(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    try {
      const d = await this.call('/quote', { symbol: sym }, 4000);
      const price = Number(d && d.c);
      if (!(price > 0)) return null;
      return {
        price,
        prevClose: Number(d.pc) || price,
        open: Number(d.o) || price,
        dayHigh: Number(d.h) || price,
        dayLow: Number(d.l) || price,
        change: Number(d.d) || 0,
        changePct: Number(d.dp) || 0,
        at: Number(d.t) ? Number(d.t) * 1000 : Date.now()
      };
    } catch (e) { return null; }
  }

  async candles(symbol, tf) {
    const sym = String(symbol || '').toUpperCase();
    const cfg = TF[tf] || TF['1D'];
    const to = Math.floor(Date.now() / 1000);
    const from = Math.floor((Date.now() - cfg.back) / 1000);
    const d = await this.call('/stock/candle', { symbol: sym, resolution: cfg.res, from, to }, 45000);
    if (!d || d.s !== 'ok' || !Array.isArray(d.t) || !Array.isArray(d.c)) {
      const e = new Error('Finnhub returned no candles for ' + sym);
      e.code = 'empty';
      throw e;
    }
    const out = [];
    for (let i = 0; i < d.t.length; i++) {
      const t = Number(d.t[i]) * 1000;
      const p = Number(d.c[i]);
      if (!(t > 0) || !(p > 0)) continue;
      out.push({ t, p });
    }
    if (out.length > cfg.max) out.splice(0, out.length - cfg.max);
    return { points: out, resolution: cfg.res, source: 'finnhub' };
  }

  status() {
    const key = String(this.getKey() || '').trim();
    return {
      configured: !!key,
      maskedKey: key ? key.slice(0, 4) + '…' + key.slice(-4) : '',
      lastOkAt: this.lastOkAt || null,
      lastError: this.lastError || '',
      lastErrorAt: this.lastErrorAt || null,
      latencyMs: this.lastLatencyMs || null,
      callsLastMin: this.calls.filter((t) => Date.now() - t < 60000).length,
      budgetPerMin: this.maxCallsPerMin
    };
  }
}

module.exports = { FinnhubClient, TF };
