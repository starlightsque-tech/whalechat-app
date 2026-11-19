/* =========================================================================
   WhaleChat Twelve Data feed  (server side)

   Twelve Data is the second real stock/forex source next to Finnhub. Both run
   at the same time: Finnhub keeps its websocket, Twelve Data polls quotes for
   the equity/forex symbols, and Binance keeps feeding crypto. A tick coming
   from any of them is written through market.ingestExternal(), so the chart,
   the B2B desk and price alerts all see the same real price.

   Free-tier friendly: one batched request per cycle (8 symbols per request),
   a rotation so every symbol is refreshed, and the API key never leaves the
   server.
   ========================================================================= */
'use strict';

const https = require('https');

function getJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs || 12000,
      headers: { 'user-agent': 'whalechat/1.0', accept: 'application/json' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(body); } catch (e) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = (data && (data.message || data.error)) || ('HTTP ' + res.statusCode);
          return reject(new Error(msg));
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function createTwelveDataFeed(opts) {
  const getDb = opts.getDb || (() => null);
  const getTargets = typeof opts.getTargets === 'function' ? opts.getTargets : (() => []);
  const getManagedKey = typeof opts.getApiKey === 'function' ? opts.getApiKey : null;
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
  const everyMs = Math.max(15000, Number(opts.everyMs) || 65000);
  const batch = Math.max(1, Math.min(8, Number(opts.batch) || 8));
  const state = {
    enabled: true, hasKey: false, lastAt: 0, lastError: '', ticks: 0, source: 'none',
    symbols: 0, rotating: 0, host: 'api.twelvedata.com', running: false
  };
  let timer = null;
  let cursor = 0;
  let busy = false;

  function cfg() {
    try {
      const db = getDb();
      const c = (db && db.settings && db.settings.connections) || {};
      const legacy = (db && db.settings && db.settings.twelvedata) || {};
      let managed = '';
      try { managed = String((getManagedKey && getManagedKey()) || '').trim(); } catch (e) {}
      return {
        enabled: true,
        apiKey: String(managed || (c.twelvedata && c.twelvedata.apiKey) || legacy.apiKey || process.env.TWELVEDATA_API_KEY || '').trim()
      };
    } catch (e) { return { enabled: true, apiKey: '' }; }
  }

  function providerSymbol(target) {
    const sym = String(target.symbol || '').trim().toUpperCase();
    if (!sym) return '';
    if (target.kind === 'forex') return sym.replace(/^OANDA:/, '').replace(/_/g, '/');
    return sym.replace(/^[A-Z]+:/, '');   /* strip BINANCE:/NASDAQ: prefixes */
  }

  async function poll() {
    if (busy) return;
    const c = cfg();
    state.hasKey = !!c.apiKey;
    if (!c.apiKey) { state.source = 'waiting_for_key'; state.lastError = ''; return; }
    const all = (getTargets() || []).filter((t) => t && t.ticker);
    state.symbols = all.length;
    if (!all.length) return;
    /* rotate through the catalogue so a free plan can cover every symbol */
    const take = [];
    for (let i = 0; i < all.length && take.length < batch; i++) {
      take.push(all[(cursor + i) % all.length]);
    }
    cursor = (cursor + take.length) % Math.max(1, all.length);
    state.rotating = cursor;
    const bySym = new Map();
    take.forEach((t) => bySym.set(providerSymbol(t), t));
    const list = Array.from(bySym.keys()).filter(Boolean);
    if (!list.length) return;
    busy = true;
    try {
      const url = 'https://api.twelvedata.com/quote?symbol=' + encodeURIComponent(list.join(',')) +
        '&apikey=' + encodeURIComponent(c.apiKey);
      const d = await getJSON(url);
      const rows = Array.isArray(d) ? d
        : (d && d.symbol ? [d]
        : (d && typeof d === 'object' ? Object.keys(d).filter((k) => d[k] && typeof d[k] === 'object').map((k) => Object.assign({ symbol: (d[k].symbol || k) }, d[k])) : []));
      let n = 0;
      rows.forEach((row) => {
        if (!row) return;
        const key = String(row.symbol || '').toUpperCase();
        const t = bySym.get(key) || bySym.get(key.replace('/', '')) || bySym.get(key.replace('/', '_'));
        const price = Number(row.close != null ? row.close : row.price);
        const ts = Number(row.timestamp);
        if (!t || !(price > 0)) return;
        if (row.status === 'error' || row.code) return;
        state.lastAt = ts > 0 ? ts * 1000 : Date.now();
        state.ticks++;
        n++;
        if (onTick) { try { onTick(t.ticker, price, row); } catch (e) {} }
      });
      state.source = n ? 'twelvedata' : state.source;
      state.lastError = n ? '' : (d && (d.message || d.error) ? String(d.message || d.error) : 'no quotes returned');
    } catch (e) {
      state.lastError = e.message || String(e);
      state.source = 'error';
    } finally { busy = false; }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    poll().catch(() => {});
    timer = setInterval(() => { poll().catch(() => {}); }, everyMs);
    if (timer.unref) timer.unref();
  }
  function status() {
    return {
      configured: !!cfg().apiKey, enabled: true, source: state.source,
      lastAt: state.lastAt, lastError: state.lastError, ticks: state.ticks,
      symbols: state.symbols, everyMs, batch, host: state.host
    };
  }
  return { start, stop: () => { state.running = false; if (timer) { clearInterval(timer); timer = null; } }, poll, status };
}

module.exports = { createTwelveDataFeed };
