/* =========================================================================
   WhaleChat Alpaca price feed (server side)
   Polls Alpaca market-data snapshots for the listed US stocks and feeds the
   latest real trade price into the shared market cache. Keys are saved by the
   admin (Admin > Markets) and never returned to a browser.
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

function createAlpacaFeed(opts) {
  const getDb = opts.getDb || (() => null);
  const getTickers = opts.getTickers || (() => []);
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
  const everyMs = Math.max(5000, Number(opts.everyMs) || 10000);
  const state = { lastAt: 0, lastError: '', ticks: 0, symbols: 0, source: 'none' };
  let timer = null;

  function cfg() {
    try { const db = getDb(); return (db && db.settings && db.settings.alpaca) || {}; } catch (e) { return {}; }
  }
  function hasKey() { const c = cfg(); return !!(c.keyId && c.secret); }

  async function poll() {
    const c = cfg();
    if (!c.keyId || !c.secret || c.enabled === false) { state.source = 'none'; return state; }
    const headers = { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secret };
    const feed = c.feed === 'sip' ? 'sip' : 'iex';
    const base = (process.env.ALPACA_DATA_BASE || 'https://data.alpaca.markets').replace(/\/+$/, '');
    let list = [];
    try { list = getTickers() || []; } catch (e) {}
    list = list.filter((s) => /^[A-Z.]{1,6}$/.test(s));
    state.symbols = list.length;
    try {
      let got = 0;
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const data = await getJSON(base + '/v2/stocks/snapshots?feed=' + feed + '&symbols=' + encodeURIComponent(chunk.join(',')), headers);
        Object.keys(data || {}).forEach((sym) => {
          const s = data[sym] || {};
          const p = Number(s.latestTrade && s.latestTrade.p) || Number(s.minuteBar && s.minuteBar.c) || Number(s.dailyBar && s.dailyBar.c);
          if (p > 0 && onTick) { try { onTick(sym.toUpperCase(), p); got++; } catch (e) {} }
        });
      }
      state.lastAt = Date.now(); state.ticks += got; state.lastError = ''; state.source = 'alpaca';
    } catch (e) {
      state.lastError = e.message; state.source = 'error';
    }
    return state;
  }

  function start() { if (timer) return; poll().catch(() => {}); timer = setInterval(() => poll().catch(() => {}), everyMs); if (timer.unref) timer.unref(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function status() {
    return { hasKey: hasKey(), enabled: cfg().enabled !== false, feed: cfg().feed || 'iex', source: state.source, symbols: state.symbols, ticks: state.ticks, lastAt: state.lastAt, lastError: state.lastError };
  }
  return { start, stop, poll, status };
}

module.exports = { createAlpacaFeed };
