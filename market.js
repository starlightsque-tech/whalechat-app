'use strict';
/* =========================================================================
   WhaleChat market data service
   - Finnhub REST seeding + one shared backend WebSocket
   - server-side price cache shared by every user/browser
   - rate-limit safe (1.2s spacing, 60 req/min free tier)
   - 24/7 smooth simulated fallback when the US market is closed, Finnhub
     returns 429, or the WebSocket stops delivering ticks
   - server-side settlement of live Rise/Fall trades so funds are returned
     even when every browser tab is closed
   The Finnhub API key never leaves this process.
   ========================================================================= */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TICKERS = ['AAPL', 'TSLA', 'NVDA', 'COIN', 'MSTR', 'MARA', 'KO', 'JPM', 'NKE', 'UNH', 'AVGO', 'WMT', 'DIS', 'V', 'UBER', 'AMZN'];

const BASE_PRICES = {
  AAPL: 231.42, TSLA: 352.41, NVDA: 141.28, COIN: 298.41, MSTR: 412.88, MARA: 21.64,
  KO: 63.21, JPM: 242.61, NKE: 78.42, UNH: 562.31, AVGO: 172.44, WMT: 89.64,
  DIS: 112.44, V: 309.51, UBER: 74.21, AMZN: 206.74
};

const FALLBACK_DIVIDEND_YIELDS = {
  AAPL: 0.45, TSLA: 0, NVDA: 0.03, COIN: 0, MSTR: 0, MARA: 0, KO: 3.00, JPM: 2.20,
  NKE: 1.80, UNH: 1.50, AVGO: 1.20, WMT: 1.00, DIS: 0.80, V: 0.75, UBER: 0, AMZN: 0,
  MSFT: 0.70, GOOGL: 0.45, META: 0.35, NFLX: 0, AMD: 0, PEP: 3.40, PLTR: 0, ARM: 0,
  SHOP: 0, HOOD: 0, LLY: 0.70, XOM: 3.30, SMCI: 0, RIVN: 0,
  VOD_L: 7.0, SAP_DE: 1.3, '7203_T': 2.5, SHOP_TO: 0
};

const DURATION_LABELS = { 5: '5 min', 15: '15 min', 60: '1 hour', 240: '4 hours', 1440: '1 day' };
const DEFAULT_ASSETS = [
  { ticker: 'VOD_L', displayTicker: 'VOD.L', finnhubSymbol: 'VOD.L', assetClass: 'global', name: 'Vodafone Group', exchange: 'London', currency: 'GBP', color: '#e60000', sector: 'Communication' },
  { ticker: 'SAP_DE', displayTicker: 'SAP.DE', finnhubSymbol: 'SAP.DE', assetClass: 'global', name: 'SAP SE', exchange: 'Frankfurt', currency: 'EUR', color: '#0faaff', sector: 'Technology' },
  { ticker: '7203_T', displayTicker: '7203.T', finnhubSymbol: '7203.T', assetClass: 'global', name: 'Toyota Motor', exchange: 'Tokyo', currency: 'JPY', color: '#eb0a1e', sector: 'Automotive' },
  { ticker: 'SHOP_TO', displayTicker: 'SHOP.TO', finnhubSymbol: 'SHOP.TO', assetClass: 'global', name: 'Shopify Inc.', exchange: 'Toronto', currency: 'CAD', color: '#96bf48', sector: 'Technology' },
  { ticker: 'EURUSD', displayTicker: 'EUR/USD', finnhubSymbol: 'OANDA:EUR_USD', assetClass: 'forex', name: 'Euro / US Dollar', exchange: 'OANDA', currency: 'USD', color: '#2f6fd0', sector: 'Forex' },
  { ticker: 'GBPUSD', displayTicker: 'GBP/USD', finnhubSymbol: 'OANDA:GBP_USD', assetClass: 'forex', name: 'British Pound / US Dollar', exchange: 'OANDA', currency: 'USD', color: '#7a5cff', sector: 'Forex' },
  { ticker: 'USDJPY', displayTicker: 'USD/JPY', finnhubSymbol: 'OANDA:USD_JPY', assetClass: 'forex', name: 'US Dollar / Japanese Yen', exchange: 'OANDA', currency: 'JPY', color: '#e60012', sector: 'Forex' },
  { ticker: 'XAUUSD', displayTicker: 'XAU/USD', finnhubSymbol: 'OANDA:XAU_USD', assetClass: 'forex', name: 'Gold / US Dollar', exchange: 'OANDA', currency: 'USD', color: '#ffc861', sector: 'Forex' },
  { ticker: 'BTCUSDT', displayTicker: 'BTC/USDT', finnhubSymbol: 'BINANCE:BTCUSDT', assetClass: 'crypto', name: 'Bitcoin', exchange: 'Binance', currency: 'USDT', color: '#f7931a', sector: 'Crypto' },
  { ticker: 'ETHUSDT', displayTicker: 'ETH/USDT', finnhubSymbol: 'BINANCE:ETHUSDT', assetClass: 'crypto', name: 'Ethereum', exchange: 'Binance', currency: 'USDT', color: '#627eea', sector: 'Crypto' },
  { ticker: 'SOLUSDT', displayTicker: 'SOL/USDT', finnhubSymbol: 'BINANCE:SOLUSDT', assetClass: 'crypto', name: 'Solana', exchange: 'Binance', currency: 'USDT', color: '#14f195', sector: 'Crypto' },
  { ticker: 'BNBUSDT', displayTicker: 'BNB/USDT', finnhubSymbol: 'BINANCE:BNBUSDT', assetClass: 'crypto', name: 'BNB', exchange: 'Binance', currency: 'USDT', color: '#f3ba2f', sector: 'Crypto' },
  { ticker: 'XRPUSDT', displayTicker: 'XRP/USDT', finnhubSymbol: 'BINANCE:XRPUSDT', assetClass: 'crypto', name: 'XRP', exchange: 'Binance', currency: 'USDT', color: '#23292f', sector: 'Crypto' }
];

function assetKey(finnhubSymbol, assetClass) {
  const sym = String(finnhubSymbol || '').toUpperCase();
  if (assetClass === 'forex') return sym.split(':').pop().replace(/_/g, '');
  if (assetClass === 'crypto') return sym.split(':').pop().replace(/[^A-Z0-9]/g, '');
  return sym.replace(/[^A-Z0-9]/g, '_');
}
function displayTickerFor(finnhubSymbol, assetClass) {
  const sym = String(finnhubSymbol || '').toUpperCase();
  if (assetClass === 'forex') {
    const pair = sym.split(':').pop();
    return pair.includes('_') ? pair.replace('_', '/') : pair;
  }
  if (assetClass === 'crypto') {
    const pair = sym.split(':').pop();
    const m = pair.match(/^(.*?)(USDT|USDC|BUSD|USD)$/);
    return m ? m[1] + '/' + m[2] : pair;
  }
  return sym;
}

function durationLabel(minutes, stored) {
  return stored || DURATION_LABELS[Number(minutes)] || (Number(minutes) ? Number(minutes) + ' min' : 'duration');
}

const NY_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19',
  '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'
]);

const FINNHUB_REST_BASE = (process.env.FINNHUB_REST_BASE || 'https://finnhub.io').replace(/\/+$/, '');
const FINNHUB_WS_URL = process.env.FINNHUB_WS_URL || 'wss://ws.finnhub.io';
const SEED_DELAY_MS = Math.max(0, Number(process.env.FINNHUB_SEED_DELAY_MS) || 1200);
const FORCE_MARKET_OPEN = process.env.US_MARKET_FORCE_OPEN === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, n) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n);

function nyClock(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d || new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  const hour = Number(get('hour')) % 24;
  return { weekday: get('weekday'), hour, minute: Number(get('minute')) };
}

function nyDateKey(d) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
  } catch (e) {
    return new Date(d || Date.now()).toISOString().slice(0, 10);
  }
}

function usMarketOpen(d) {
  if (FORCE_MARKET_OPEN) return true;
  const t = d || new Date();
  const c = nyClock(t);
  if (c.weekday === 'Sat' || c.weekday === 'Sun') return false;
  if (NY_HOLIDAYS.has(nyDateKey(t))) return false;
  const mins = c.hour * 60 + c.minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function id(prefix) { return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

class MarketService {
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.getDb = opts.getDb;
    this.persist = opts.persist || (() => {});
    this.broadcast = opts.broadcast || (() => {});
    this.configFile = path.join(this.dataDir, 'market-config.json');
    this.config = { mode: 'simulated', apiKey: '', refreshSec: 15 };
    this.quotes = {};
    this.assets = [];
    this.byFinnhub = new Map();
    this.history = {};
    this._lastSettleAt = 0;
    this.lastReal = {};
    this.lastRealTime = {};
    this.lastRealAt = 0;
    this.lastTickAt = 0;
    this.ws = null;
    this.wsConnected = false;
    this.wsTicks = 0;
    this.lastWsTickAt = 0;
    this.rateLimitedUntil = 0;
    this.polling = false;
    this.stopped = false;
    this.lastError = '';
    this.seeding = false;
    this.startedAt = Date.now();
    this.syncingDividends = false;
    this.dividendSyncedAt = 0;
    this.dividendSource = '';
    this.dividendFetched = 0;
    this.timers = [];
    this.settleLock = false;
  }

  /* ------------------------------- config ------------------------------- */
  rawConfig() { return { mode: this.config.mode, apiKey: this.config.apiKey, refreshSec: this.config.refreshSec }; }

  writeConfigFile() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify(this.rawConfig(), null, 2), { mode: 0o600 });
      try { fs.chmodSync(this.configFile, 0o600); } catch (e) {}
    } catch (e) { this.lastError = 'Could not save market config: ' + e.message; }
  }

  /* Restore config from durable storage (Postgres) before start(). */
  hydrateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return false;
    if (cfg.mode === 'hybrid' || cfg.mode === 'simulated') this.config.mode = cfg.mode;
    if (typeof cfg.apiKey === 'string') this.config.apiKey = cfg.apiKey.trim();
    if (cfg.refreshSec != null) this.config.refreshSec = Math.min(300, Math.max(5, Math.round(Number(cfg.refreshSec) || 15)));
    this.writeConfigFile();
    return true;
  }

  loadConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.config.mode = raw.mode === 'hybrid' ? 'hybrid' : 'simulated';
        this.config.apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
        this.config.refreshSec = Math.min(300, Math.max(5, Number(raw.refreshSec) || 15));
      }
    } catch (e) { /* first run */ }
    if (!this.config.apiKey && process.env.FINNHUB_API_KEY) {
      this.config.apiKey = String(process.env.FINNHUB_API_KEY).trim();
    }
    if (this.config.mode !== 'hybrid' && process.env.FINNHUB_MODE === 'hybrid' && this.config.apiKey) {
      this.config.mode = 'hybrid';
    }
  }

  saveConfig(next) {
    const cfg = { mode: this.config.mode, apiKey: this.config.apiKey, refreshSec: this.config.refreshSec };
    if (next.mode) cfg.mode = next.mode === 'hybrid' ? 'hybrid' : 'simulated';
    if (typeof next.apiKey === 'string' && next.apiKey.trim()) cfg.apiKey = next.apiKey.trim();
    if (next.clearKey === true) cfg.apiKey = '';
    if (next.refreshSec != null) cfg.refreshSec = Math.min(300, Math.max(5, Math.round(Number(next.refreshSec) || 15)));
    this.config = cfg;
    this.writeConfigFile();
    this.restart();
    return this.publicConfig();
  }

  publicConfig() {
    const key = this.config.apiKey;
    return {
      ok: true,
      mode: this.config.mode,
      refreshSec: this.config.refreshSec,
      hasKey: !!key,
      keyMasked: key ? (key.slice(0, 4) + '…' + key.slice(-4)) : '',
      status: this.status()
    };
  }

  /* ------------------------------- quotes ------------------------------- */
  refreshAssets() {
    const db = this.getDb && this.getDb();
    const list = (db && Array.isArray(db.stocks)) ? db.stocks.filter((s) => s && s.ticker) : [];
    this.assets = list.map((s) => ({
      ticker: String(s.ticker).toUpperCase(),
      displayTicker: s.displayTicker || s.ticker,
      finnhubSymbol: s.finnhubSymbol || s.ticker,
      assetClass: s.assetClass || 'us',
      name: s.name || s.ticker,
      exchange: s.exchange || (s.assetClass === 'forex' ? 'OANDA' : s.assetClass === 'crypto' ? 'Binance' : 'US'),
      currency: s.currency || 'USD',
      price: Number(s.price) || 0
    }));
    this.byFinnhub = new Map(this.assets.map((a) => [String(a.finnhubSymbol).toUpperCase(), a.ticker]));
    return this.assets;
  }

  assetList() { return this.assets.length ? this.assets : this.refreshAssets(); }

  assetClasses() {
    const out = { us: 0, global: 0, forex: 0, crypto: 0 };
    this.assetList().forEach((a) => { out[a.assetClass] = (out[a.assetClass] || 0) + 1; });
    return out;
  }

  seedBaseQuotes() {
    const now = Date.now();
    this.refreshAssets();
    this.assetList().forEach((a) => {
      if (this.quotes[a.ticker]) return;
      const price = Number(a.price) || 0;
      this.quotes[a.ticker] = {
        ticker: a.ticker, price, prevClose: price, open: price,
        dayHigh: price, dayLow: price,
        changePct: 0, changeUsd: 0, vol: 0,
        dir: 0, updatedAt: now, source: 'cached', real: false
      };
      if (price > 0) this.recordHistory(a.ticker, price, now, 'cached', false);
    });
  }

  async seedAsset(ticker) {
    const a = this.assetList().find((x) => x.ticker === ticker);
    if (!a) return null;
    const q = await this.fetchQuote(a.finnhubSymbol);
    if (!q) return null;
    this.writeQuote(a.ticker, q.price, { prevClose: q.prevClose, open: q.open, dayHigh: q.dayHigh, dayLow: q.dayLow, vol: 0, source: 'live', real: true });
    return q;
  }

  subscribeSymbol(symbol) {
    if (!this.ws || !this.wsConnected) return false;
    try { this.ws.send(JSON.stringify({ type: 'subscribe', symbol })); return true; } catch (e) { return false; }
  }

  writeQuote(ticker, price, meta) {
    if (!Number.isFinite(price) || price <= 0) return;
    const now = Date.now();
    const prev = this.quotes[ticker] || { prevClose: price, open: price, dayHigh: price, dayLow: price, vol: 1000000 };
    const q = {
      ticker,
      price: round(price, 4),
      prevClose: Number(meta && meta.prevClose) > 0 ? round(meta.prevClose, 4) : (prev.prevClose || round(price, 4)),
      open: Number(meta && meta.open) > 0 ? round(meta.open, 4) : (prev.open || round(price, 4)),
      dayHigh: Math.max(prev.dayHigh || price, Number(meta && meta.dayHigh) || 0, price),
      dayLow: Math.min(prev.dayLow || price, Number(meta && meta.dayLow) || price, price),
      vol: Number(meta && meta.vol) || prev.vol || 1000000,
      dir: price > (prev.price || price) ? 1 : price < (prev.price || price) ? -1 : 0,
      updatedAt: now,
      source: (meta && meta.source) || 'live',
      real: !!(meta && meta.real)
    };
    q.changeUsd = round(q.price - q.prevClose, 4);
    q.changePct = q.prevClose ? round((q.changeUsd / q.prevClose) * 100, 4) : 0;
    this.quotes[ticker] = q;
    this.lastTickAt = now;
    this.recordHistory(ticker, q.price, now, q.source, q.real);
    if (q.real) { this.lastReal[ticker] = q.price; this.lastRealTime[ticker] = now; this.lastRealAt = now; }
    return q;
  }

  /* ------------------------------- history ------------------------------ */
  recordHistory(ticker, price, now, source, real) {
    const arr = this.history[ticker] || (this.history[ticker] = []);
    const at = now || Date.now();
    const last = arr[arr.length - 1];
    if (last && at - last.t < 2000) {
      last.p = round(price, 4);
      last.t = at;
      last.real = !!real;
      return;
    }
    arr.push({ t: at, p: round(price, 4), real: !!real, source: source || 'simulated' });
    if (arr.length > 3000) arr.splice(0, arr.length - 3000);
  }

  historyFor(tickers, limit) {
    const out = {};
    const n = Math.max(10, Math.min(3000, Number(limit) || 600));
    (tickers || []).forEach((t) => {
      out[t] = (this.history[t] || []).slice(-n);
    });
    return out;
  }

  _settleSoon() {
    const now = Date.now();
    if (now - this._lastSettleAt < 500) return;
    this._lastSettleAt = now;
    try { this.settleTrades(); this.settleSpot(); } catch (e) { this.lastError = e.message; }
  }

  /* --------------------------- Finnhub REST ----------------------------- */
  getJSON(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const client = /^http:\/\//i.test(url) ? http : https;
      const req = client.get(url, {
        timeout: timeoutMs || 8000,
        headers: { 'User-Agent': 'WhaleChat/3.17 market-feed', Accept: 'application/json' }
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(body); } catch (e) {}
          resolve({ status: res.statusCode || 0, data, body });
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
    });
  }

  async fetchQuote(ticker) {
    const key = this.config.apiKey;
    if (!key) return null;
    if (Date.now() < this.rateLimitedUntil) return null;
    const url = FINNHUB_REST_BASE + '/api/v1/quote?symbol=' + encodeURIComponent(ticker) + '&token=' + encodeURIComponent(key);
    try {
      const r = await this.getJSON(url, 9000);
      if (r.status === 429) {
        this.rateLimitedUntil = Date.now() + 60 * 1000;
        this.lastError = 'Finnhub rate limit hit — falling back to 24/7 simulated ticks';
        return null;
      }
      if (r.status !== 200 || !r.data) {
        this.lastError = 'Finnhub HTTP ' + r.status;
        return null;
      }
      const d = r.data;
      if (!(Number(d.c) > 0)) {
        this.lastError = 'Finnhub returned no price for ' + ticker;
        return null;
      }
      this.rateLimitedUntil = 0;
      this.lastError = '';
      return {
        price: Number(d.c),
        prevClose: Number(d.pc) || Number(d.c),
        open: Number(d.o) || Number(d.c),
        dayHigh: Number(d.h) || Number(d.c),
        dayLow: Number(d.l) || Number(d.c)
      };
    } catch (e) {
      this.lastError = 'Finnhub request failed: ' + e.message;
      return null;
    }
  }

  async seedFromFinnhub() {
    if (this.seeding || !this.config.apiKey) return;
    this.seeding = true;
    try {
      const assets = this.assetList();
      for (const a of assets) {
        if (this.stopped) break;
        if (Date.now() < this.rateLimitedUntil) break;
        const q = await this.fetchQuote(a.finnhubSymbol);
        if (q) {
          this.writeQuote(a.ticker, q.price, { prevClose: q.prevClose, open: q.open, dayHigh: q.dayHigh, dayLow: q.dayLow, vol: 0, source: 'live', real: true });
        }
        await sleep(SEED_DELAY_MS);                            // default 1.2s < 60 requests / minute
      }
      this.lastError = '';
      console.log('[market] Finnhub seed complete ·', assets.length, 'assets ·', usMarketOpen() ? 'market open' : 'market closed');
    } finally {
      this.seeding = false;
    }
  }

  async pollCycle() {
    if (this.polling || !this.config.apiKey) return;
    if (Date.now() < this.rateLimitedUntil) return;
    this.polling = true;
    try {
      for (const a of this.assetList()) {
        const wsFresh = this.wsConnected && this.lastWsTickAt && Date.now() - this.lastWsTickAt < 45000;
        if (this.stopped || wsFresh) break;
        const t = a.ticker;
        const q = this.quotes[t];
        const realAt = this.lastRealTime[t] || 0;
        const stale = !q || !realAt || Date.now() - realAt > Math.max(30000, this.config.refreshSec * 2000);
        if (stale) {
          const fresh = await this.fetchQuote(a.finnhubSymbol);
          if (fresh) this.writeQuote(t, fresh.price, { prevClose: fresh.prevClose, open: fresh.open, dayHigh: fresh.dayHigh, dayLow: fresh.dayLow, vol: q ? q.vol : 0, source: 'live', real: true });
        }
        await sleep(1200);
      }
    } finally {
      this.polling = false;
    }
  }

  /* ----------------------------- WebSocket ------------------------------ */
  wsClass() {
    if (typeof global.WebSocket === 'function') return global.WebSocket;
    try { return require('ws'); } catch (e) { return null; }
  }

  async finnhubGet(path) {
    const key = this.config.apiKey;
    if (!key) throw new Error('Finnhub API key is not configured');
    if (Date.now() < this.rateLimitedUntil) throw new Error('Finnhub rate limit cooldown is active');
    const url = FINNHUB_REST_BASE + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(key);
    const r = await this.getJSON(url, 12000);
    if (r.status === 429) { this.rateLimitedUntil = Date.now() + 60 * 1000; throw new Error('Finnhub rate limit'); }
    if (r.status !== 200 || !r.data) throw new Error('Finnhub HTTP ' + r.status);
    return r.data;
  }

  async searchAssets(query, cls) {
    const q = String(query || '').trim();
    if (!q) return [];
    if (cls === 'forex' || cls === 'crypto') {
      const path = cls === 'forex' ? '/api/v1/forex/symbol?exchange=oanda' : '/api/v1/crypto/symbol?exchange=binance';
      const data = await this.finnhubGet(path);
      const list = Array.isArray(data) ? data : (data && data.data) || [];
      const needle = q.toUpperCase();
      return list.filter((x) => String(x.symbol || '').toUpperCase().includes(needle) || String(x.description || '').toUpperCase().includes(needle))
        .slice(0, 25)
        .map((x) => ({ symbol: x.symbol, display: displayTickerFor(x.symbol, cls), description: x.description || displayTickerFor(x.symbol, cls), type: cls }));
    }
    const data = await this.finnhubGet('/api/v1/search?q=' + encodeURIComponent(q));
    const list = (data && data.result) || [];
    return list.filter((x) => {
      const sym = String(x.symbol || '');
      if (cls === 'us') return sym && !sym.includes('.') && !sym.includes(':');
      if (cls === 'global') return sym.includes('.');
      return true;
    }).slice(0, 25).map((x) => ({ symbol: x.symbol, display: x.displaySymbol || x.symbol, description: x.description || x.symbol, type: x.type || 'Stock' }));
  }

  async profileFor(symbol) {
    try { return await this.finnhubGet('/api/v1/stock/profile2?symbol=' + encodeURIComponent(symbol)); }
    catch (e) { return {}; }
  }

  async addAsset(cls, symbol) {
    const klass = ['us', 'global', 'forex', 'crypto'].includes(cls) ? cls : 'us';
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) throw new Error('Symbol is required');
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database is not ready');
    const ticker = assetKey(sym, klass);
    if ((db.stocks || []).some((s) => String(s.ticker).toUpperCase() === ticker || String(s.finnhubSymbol || '').toUpperCase() === sym)) {
      return { existing: true, asset: (db.stocks || []).find((s) => String(s.ticker).toUpperCase() === ticker) };
    }
    const quote = await this.fetchQuote(sym).catch(() => null);
    const profile = (klass === 'us' || klass === 'global') ? await this.profileFor(sym) : {};
    let dividendYield = 0;
    if (klass === 'us' || klass === 'global') {
      const y = await this.fetchDividendYield(sym).catch(() => null);
      if (y != null) dividendYield = y;
    }
    const display = displayTickerFor(sym, klass);
    const name = profile.name || (klass === 'forex' ? display : klass === 'crypto' ? display : display);
    const asset = {
      id: 'st_' + ticker.toLowerCase().replace(/[^a-z0-9]/g, ''),
      ticker, displayTicker: display, finnhubSymbol: sym, assetClass: klass,
      name, sector: profile.finnhubIndustry || (klass === 'forex' ? 'Forex' : klass === 'crypto' ? 'Crypto' : 'Stock'),
      exchange: profile.exchange || (klass === 'forex' ? 'OANDA' : klass === 'crypto' ? 'Binance' : 'US'),
      currency: profile.currency || (klass === 'crypto' ? 'USDT' : 'USD'),
      logo: profile.logo || '', website: profile.weburl || '', ceo: '', about: profile.name || name,
      price: quote ? quote.price : 0, prevClose: quote ? quote.prevClose : 0,
      div: dividendYield, dividendYield,
      color: ['#2ee6c9', '#3aa0ff', '#8b7bff', '#ffc861', '#2fd6a6', '#ff7bb0'][ticker.length % 6],
      paused: false, custom: true, createdAt: Date.now()
    };
    db.stocks = db.stocks || [];
    db.stocks.push(asset);
    if (db.invest) {
      if (!db.invest.dividendYields) db.invest.dividendYields = {};
      if (dividendYield > 0) db.invest.dividendYields[ticker] = dividendYield;
    }
    this.refreshAssets();
    if (quote) this.writeQuote(ticker, quote.price, { prevClose: quote.prevClose, open: quote.open, dayHigh: quote.dayHigh, dayLow: quote.dayLow, source: 'live', real: true });
    this.persist();
    try { this.broadcast('change', { rev: null, source: 'market-asset-add', at: Date.now() }); } catch (e) {}
    this.subscribeSymbol(sym);
    return { existing: false, asset };
  }

  async onAssetsChanged() {
    this.refreshAssets();
    if (this.wsConnected) this.connectWS();
  }

  connectWS() {
    if (this.stopped || this.config.mode !== 'hybrid' || !this.config.apiKey) return;
    const WS = this.wsClass();
    if (!WS) {
      this.lastError = 'WebSocket client unavailable — REST polling + simulation active';
      return;
    }
    this.closeWS();
    const url = FINNHUB_WS_URL + '?token=' + encodeURIComponent(this.config.apiKey);
    let ws;
    try { ws = new WS(url); } catch (e) { this.lastError = 'WebSocket failed: ' + e.message; return; }
    this.ws = ws;
    const retry = () => {
      if (this.stopped || this.ws !== ws) return;
      this.wsConnected = false;
      setTimeout(() => { if (!this.stopped && this.config.mode === 'hybrid') this.connectWS(); }, 5000).unref?.();
    };
    ws.onopen = () => {
      this.wsConnected = true;
      this.lastWsTickAt = Date.now();
      this.lastError = '';
      this.assetList().forEach((a) => {
        try { ws.send(JSON.stringify({ type: 'subscribe', symbol: a.finnhubSymbol })); } catch (e) {}
      });
      console.log('[market] Finnhub WebSocket connected ·', this.assetList().length, 'subscriptions');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
      if (!msg || msg.type !== 'trade' || !Array.isArray(msg.data)) return;
      const touched = new Set();
      msg.data.forEach((tr) => {
        const sym = String(tr.s || '').toUpperCase();
        let t = this.byFinnhub.get(sym);
        if (!t) { this.refreshAssets(); t = this.byFinnhub.get(sym); }
        if (!t || !this.quotes[t] || !(Number(tr.p) > 0)) return;
        const old = this.quotes[t];
        this.writeQuote(t, Number(tr.p), {
          prevClose: old.prevClose, open: old.open,
          vol: (old.vol || 0) + (Number(tr.v) || 0),
          source: 'live', real: true
        });
        touched.add(t);
      });
      if (touched.size) {
        this.wsTicks += touched.size;
        this.lastWsTickAt = Date.now();
        this._settleSoon();
      }
    };
    ws.onerror = () => { this.wsConnected = false; };
    ws.onclose = retry;
  }

  closeWS() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    this.wsConnected = false;
    try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (e) {}
  }

  /* ------------------------- real-data status --------------------------- */
  fallbackReason() {
    if (this.config.mode !== 'hybrid' || !this.config.apiKey) return 'no-finnhub';
    if (Date.now() < this.rateLimitedUntil) return 'rate-limit';
    return '';
  }

  notice() {
    if (this.config.mode === 'hybrid' && this.config.apiKey) return 'Live market data via Finnhub';
    return 'Connect Finnhub in Admin → Markets';
  }

  source() {
    return (this.config.mode === 'hybrid' && this.config.apiKey) ? 'live' : 'offline';
  }

  status() {
    return {
      mode: this.config.mode,
      refreshSec: this.config.refreshSec,
      hasKey: !!this.config.apiKey,
      marketOpen: usMarketOpen(),
      source: this.source(),
      notice: this.notice(),
      fallbackReason: this.fallbackReason(),
      wsConnected: this.wsConnected,
      wsTicks: this.wsTicks,
      lastRealAt: this.lastRealAt || null,
      realTickers: Object.keys(this.lastReal).length,
      lastTickAt: this.lastTickAt || null,
      lastWsTickAt: this.lastWsTickAt || null,
      rateLimitedUntil: this.rateLimitedUntil > Date.now() ? this.rateLimitedUntil : null,
      lastError: this.lastError || '',
      tickers: this.assetList().length,
      assetCounts: this.assetClasses(),
      unpriced: this.assetList().filter((a) => !(this.quotes[a.ticker] && this.quotes[a.ticker].price > 0)).length,
      dividends: this.dividendStatus(),
      startedAt: this.startedAt
    };
  }

  snapshot() {
    return {
      ok: true,
      at: Date.now(),
      source: this.source(),
      marketOpen: usMarketOpen(),
      notice: this.notice(),
      status: this.status(),
      quotes: this.quotes
    };
  }

  /* --------------------------- dividends ------------------------------- */
  fallbackDividendMap() { return Object.assign({}, FALLBACK_DIVIDEND_YIELDS); }

  dividendYieldFor(db, ticker) {
    const inv = (db && db.invest) || {};
    const ov = inv.dividendOverrides && inv.dividendOverrides[ticker];
    if (ov != null && ov !== '' && Number.isFinite(Number(ov))) return Math.max(0, Math.min(100, Number(ov)));
    const auto = inv.dividendYields && inv.dividendYields[ticker];
    if (auto != null && Number.isFinite(Number(auto))) return Math.max(0, Math.min(100, Number(auto)));
    return Number(FALLBACK_DIVIDEND_YIELDS[ticker]) || 0;
  }

  applyDividendMap(map, source, liveCount) {
    const db = this.getDb && this.getDb();
    if (!db) return null;
    if (!db.invest) db.invest = {};
    db.invest.dividendYields = Object.assign({}, db.invest.dividendYields || {}, map || {});
    db.invest.dividendSyncedAt = Date.now();
    db.invest.dividendSource = source || 'fallback';
    if (!(Number(db.invest.dividendMultiplier) > 0)) db.invest.dividendMultiplier = 1;
    if (!db.invest.dividendPayoutMode) db.invest.dividendPayoutMode = 'all';
    if (!db.invest.dividendOverrides || typeof db.invest.dividendOverrides !== 'object') db.invest.dividendOverrides = {};
    this.dividendSyncedAt = db.invest.dividendSyncedAt;
    this.dividendSource = db.invest.dividendSource;
    const stockCount = this.assetList().filter((a) => a.assetClass === 'us' || a.assetClass === 'global').length;
    this.dividendFetched = liveCount != null ? Number(liveCount) : (source === 'finnhub' ? stockCount : 0);
    this.persist();
    try { this.broadcast('change', { rev: null, source: 'dividend-sync', at: Date.now() }); } catch (e) {}
    return db.invest.dividendYields;
  }

  async fetchDividendYield(ticker) {
    const key = this.config.apiKey;
    if (!key || Date.now() < this.rateLimitedUntil) return null;
    const url = FINNHUB_REST_BASE + '/api/v1/stock/metric?symbol=' + encodeURIComponent(ticker) + '&metric=all&token=' + encodeURIComponent(key);
    try {
      const r = await this.getJSON(url, 9000);
      if (r.status === 429) {
        this.rateLimitedUntil = Date.now() + 60 * 1000;
        this.lastError = 'Finnhub rate limit hit during dividend sync';
        return null;
      }
      if (r.status !== 200 || !r.data) return null;
      const m = r.data.metric || r.data;
      const v = Number(m.dividendYieldIndicatedAnnual);
      if (!Number.isFinite(v) || v < 0) return null;
      return round(Math.min(100, v), 2);
    } catch (e) {
      this.lastError = 'Dividend sync failed: ' + e.message;
      return null;
    }
  }

  async syncDividends(manual) {
    if (this.syncingDividends) return this.dividendStatus();
    this.syncingDividends = true;
    const fallback = this.fallbackDividendMap();
    const map = Object.assign({}, fallback);
    let source = 'fallback';
    let fetched = 0;
    try {
      const stockAssets = this.assetList().filter((a) => a.assetClass === 'us' || a.assetClass === 'global');
      if (this.config.mode === 'hybrid' && this.config.apiKey) {
        for (const a of stockAssets) {
          if (this.stopped || Date.now() < this.rateLimitedUntil) break;
          const v = await this.fetchDividendYield(a.finnhubSymbol);
          if (v != null) { map[a.ticker] = v; fetched++; } else { map[a.ticker] = fallback[a.ticker] || 0; }
          await sleep(SEED_DELAY_MS);                       // default 1.2s spacing
        }
        source = fetched ? 'finnhub' : 'fallback';
      }
      this.assetList().filter((a) => a.assetClass === 'forex' || a.assetClass === 'crypto').forEach((a) => { map[a.ticker] = 0; });
      this.applyDividendMap(map, source, fetched);
      console.log('[market] dividends synced ·', source, '·', fetched, 'live /', stockAssets.length, 'stock assets');
    } finally {
      this.syncingDividends = false;
    }
    return this.dividendStatus();
  }

  dividendStatus() {
    return {
      syncedAt: this.dividendSyncedAt || null,
      source: this.dividendSource || 'fallback',
      live: this.dividendFetched || 0,
      tickers: this.assetList().filter((a) => a.assetClass === 'us' || a.assetClass === 'global').length,
      syncing: this.syncingDividends
    };
  }

  /* ------------------------- spot buy / sell ---------------------------- */
  spotQuote(ticker) {
    const q = this.quotes[String(ticker || '').toUpperCase()];
    return q && Number(q.price) > 0 ? q : null;
  }

  buySpot(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    const userId = String(opts.userId || '');
    const ticker = String(opts.ticker || '').toUpperCase();
    const u = (db.users || []).find((x) => x.id === userId);
    if (!u) throw new Error('User not found');
    const q = this.spotQuote(ticker);
    if (!q) throw new Error('No live Finnhub quote for this asset yet');
    const stock = (db.stocks || []).find((s) => s.ticker === ticker);
    if ((db.invest && db.invest.paused && db.invest.paused[ticker]) || (stock && stock.paused)) throw new Error('Trading is paused for this asset');
    let qty = Number(opts.shares) || 0;
    if (!(qty > 0) && Number(opts.amountCoins) > 0) qty = (Number(opts.amountCoins) * 0.5) / q.price;
    qty = Math.round(qty * 1e8) / 1e8;
    if (!(qty > 0)) throw new Error('Enter an investment amount or quantity');
    const cost = Math.round((qty * q.price / 0.5) * 100) / 100;
    if (!(cost > 0)) throw new Error('Order value is too small');
    if ((Number(u.balance) || 0) < cost) throw new Error('Not enough WC — top up your wallet');
    const tp = Number(opts.tpPrice) || 0;
    const sl = Number(opts.slPrice) || 0;
    if (tp > 0 && tp <= q.price) throw new Error('Take Profit must be above the current price');
    if (sl > 0 && sl >= q.price) throw new Error('Stop Loss must be below the current price');
    u.balance = Math.round((Number(u.balance) - cost) * 100) / 100;
    db.holdings = db.holdings || [];
    let holding = db.holdings.find((h) => h.userId === userId && h.ticker === ticker);
    if (holding) {
      const oldShares = Number(holding.shares) || 0;
      const newShares = oldShares + qty;
      holding.avgPrice = Math.round(((oldShares * (Number(holding.avgPrice) || q.price)) + qty * q.price) / newShares * 10000) / 10000;
      holding.shares = newShares;
      holding.investedCoins = Math.round(((Number(holding.investedCoins) || 0) + cost) * 100) / 100;
      if (tp > 0) holding.takeProfitPrice = round(tp, 4);
      if (sl > 0) holding.stopLossPrice = round(sl, 4);
      holding.updatedAt = Date.now();
    } else {
      holding = {
        id: id('hd'), userId, ticker, shares: qty, avgPrice: round(q.price, 4),
        investedCoins: cost, takeProfitPrice: tp > 0 ? round(tp, 4) : null,
        stopLossPrice: sl > 0 ? round(sl, 4) : null, createdAt: Date.now(), updatedAt: Date.now()
      };
      db.holdings.push(holding);
    }
    const order = {
      id: id('tr'), userId, ticker, name: (db.stocks || []).find((s) => s.ticker === ticker)?.name || ticker,
      side: 'buy', shares: qty, priceUsd: round(q.price, 4), coins: cost, feeCoins: 0,
      type: 'market', status: 'Completed', plUsd: 0, reason: 'Market buy', createdAt: Date.now()
    };
    db.trades = db.trades || []; db.trades.unshift(order);
    db.txs = db.txs || [];
    db.txs.unshift({ id: id('tx_'), userId, type: 'stock-buy', label: `Bought ${qty} ${ticker} @ $${round(q.price, 4)}`, coins: -cost, meta: { ticker, shares: qty, priceUsd: q.price, spot: true }, createdAt: Date.now() });
    db.notifications = db.notifications || [];
    db.notifications.unshift({ id: id('nt_'), userId, title: 'Purchase complete', body: `Bought ${qty} ${ticker} @ $${round(q.price, 4)} · ${cost} WC`, link: '#/invest/stock/' + ticker, icon: 'trend', read: false, createdAt: Date.now() });
    this.persist();
    try { this.broadcast('change', { rev: null, source: 'spot-buy', at: Date.now() }); } catch (e) {}
    return { holding, order, cost };
  }

  sellSpotInternal(db, holding, price, reason) {
    if (!holding || !(Number(holding.shares) > 0)) return null;
    const u = (db.users || []).find((x) => x.id === holding.userId);
    if (!u) return null;
    const shares = Number(holding.shares);
    const payoutUsd = shares * Number(price);
    const payout = Math.round((payoutUsd / 0.5) * 100) / 100;
    u.balance = Math.round((Number(u.balance) + payout) * 100) / 100;
    const plUsd = Math.round((Number(price) - Number(holding.avgPrice)) * shares * 100) / 100;
    db.holdings = (db.holdings || []).filter((h) => h.id !== holding.id);
    const order = {
      id: id('tr'), userId: holding.userId, ticker: holding.ticker, name: (db.stocks || []).find((s) => s.ticker === holding.ticker)?.name || holding.ticker,
      side: 'sell', shares, priceUsd: round(price, 4), coins: payout, feeCoins: 0,
      type: 'market', status: 'Completed', plUsd, reason, createdAt: Date.now()
    };
    db.trades = db.trades || []; db.trades.unshift(order);
    db.txs = db.txs || [];
    db.txs.unshift({ id: id('tx_'), userId: u.id, type: 'stock-sell', label: `Sold ${shares} ${holding.ticker} @ $${round(price, 4)} · ${reason}`, coins: payout, meta: { ticker: holding.ticker, shares, priceUsd: price, spot: true, reason }, createdAt: Date.now() });
    db.notifications = db.notifications || [];
    db.notifications.unshift({ id: id('nt_'), userId: u.id, title: reason, body: `Sold ${shares} ${holding.ticker} @ $${round(price, 4)} · ${payout} WC credited.`, link: '#/invest/orders', icon: reason === 'Take Profit Hit' ? 'trend' : 'ban', read: false, createdAt: Date.now() });
    return { order, payout, plUsd };
  }

  sellSpot(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    const userId = String(opts.userId || '');
    const ticker = String(opts.ticker || '').toUpperCase();
    const holding = (db.holdings || []).find((h) => h.userId === userId && h.ticker === ticker);
    if (!holding) throw new Error('No open position for this asset');
    const q = this.spotQuote(ticker);
    if (!q) throw new Error('No live Finnhub quote for this asset yet');
    const out = this.sellSpotInternal(db, holding, q.price, 'Manual sell');
    if (!out) throw new Error('Could not sell this position');
    this.persist();
    try { this.broadcast('change', { rev: null, source: 'spot-sell', at: Date.now() }); } catch (e) {}
    return out;
  }

  updateSpotTpsl(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    const holding = (db.holdings || []).find((h) => h.userId === String(opts.userId || '') && h.ticker === String(opts.ticker || '').toUpperCase());
    if (!holding) throw new Error('No open position for this asset');
    const q = this.spotQuote(holding.ticker);
    if (!q) throw new Error('No live Finnhub quote for this asset yet');
    const tp = Number(opts.tpPrice) || 0;
    const sl = Number(opts.slPrice) || 0;
    if (tp > 0 && tp <= q.price) throw new Error('Take Profit must be above the current price');
    if (sl > 0 && sl >= q.price) throw new Error('Stop Loss must be below the current price');
    holding.takeProfitPrice = tp > 0 ? round(tp, 4) : null;
    holding.stopLossPrice = sl > 0 ? round(sl, 4) : null;
    holding.updatedAt = Date.now();
    this.persist();
    try { this.broadcast('change', { rev: null, source: 'spot-tpsl', at: Date.now() }); } catch (e) {}
    return holding;
  }

  settleSpot() {
    const db = this.getDb && this.getDb();
    if (!db || !Array.isArray(db.holdings)) return 0;
    let changed = 0;
    for (const h of db.holdings.slice()) {
      if (!h || !(Number(h.shares) > 0)) continue;
      const tp = Number(h.takeProfitPrice) || 0;
      const sl = Number(h.stopLossPrice) || 0;
      if (!tp && !sl) continue;
      const q = this.quotes[h.ticker];
      if (!q || !(q.price > 0)) continue;
      let reason = '';
      if (tp > 0 && q.price >= tp) reason = 'Take Profit Hit';
      else if (sl > 0 && q.price <= sl) reason = 'Stop Loss Hit';
      if (!reason) continue;
      if (this.sellSpotInternal(db, h, q.price, reason)) changed++;
    }
    if (changed) {
      this.persist();
      try { this.broadcast('change', { rev: null, source: 'spot-settlement', at: Date.now() }); } catch (e) {}
      console.log('[market] settled', changed, 'spot position(s) on TP/SL');
    }
    return changed;
  }

  /* --------------------------- settlement ------------------------------- */
  settleTrades() {
    if (this.settleLock) return 0;
    const db = this.getDb && this.getDb();
    if (!db || !Array.isArray(db.trades)) return 0;
    this.settleLock = true;
    let changed = 0;
    let trailingChanged = false;
    try {
      const now = Date.now();
      for (const t of db.trades) {
        if (!t || t.type !== 'live' || t.status !== 'Open') continue;
        const q = this.quotes[t.ticker];
        if (!q || !(Number(t.entryPrice) > 0)) continue;
        const lev = Math.max(1, Math.min(20, Number(t.leverage) || 1));
        const direction = t.direction || (t.side === 'short' ? 'FALL' : 'RISE');
        const dir = direction === 'FALL' ? -1 : 1;
        if (!t.direction) t.direction = direction;
        if (t.stakeAmount == null) t.stakeAmount = t.capitalCoins;
        if (!(Number(t.takeProfitPrice) > 0) && Number(t.tpPct) > 0) {
          const m = Number(t.tpPct) / (100 * lev);
          t.takeProfitPrice = round(t.entryPrice * (direction === 'FALL' ? (1 - m) : (1 + m)), 4);
        }
        if (!(Number(t.stopLossPrice) > 0) && Number(t.slPct) > 0) {
          const m = Number(t.slPct) / (100 * lev);
          t.stopLossPrice = round(t.entryPrice * (direction === 'FALL' ? (1 + m) : (1 - m)), 4);
        }
        /* trailing stop: ratchet behind the best price, never loosen */
        if (t.trailingActive && Number(t.trailingStopPct) > 0) {
          const dist = Math.max(0.05, Math.min(50, Number(t.trailingStopPct))) / 100;
          let stop = Number(t.trailingStopPrice) || Number(t.stopLossPrice) || 0;
          if (!(stop > 0)) stop = direction === 'FALL' ? t.entryPrice * (1 + dist) : t.entryPrice * (1 - dist);
          const next = direction === 'FALL' ? q.price * (1 + dist) : q.price * (1 - dist);
          const tightened = direction === 'FALL' ? Math.min(stop, next) : Math.max(stop, next);
          const rounded = round(tightened, 4);
          if (rounded !== round(stop, 4)) {
            t.trailingStopPrice = rounded;
            t.stopLossPrice = rounded;
            trailingChanged = true;
          } else if (!t.trailingStopPrice) {
            t.trailingStopPrice = rounded;
            t.stopLossPrice = rounded;
            trailingChanged = true;
          }
        }
        const tpPrice = Number(t.takeProfitPrice) || 0;
        const slPrice = Number(t.stopLossPrice) || 0;
        const slReason = t.trailingActive ? 'Trailing Stop Hit' : 'Stop Loss Hit';
        let reason = '';
        if (direction === 'RISE') {
          if (tpPrice > 0 && q.price >= tpPrice) reason = 'Take Profit Hit';
          else if (slPrice > 0 && q.price <= slPrice) reason = slReason;
        } else {
          if (tpPrice > 0 && q.price <= tpPrice) reason = 'Take Profit Hit';
          else if (slPrice > 0 && q.price >= slPrice) reason = slReason;
        }
        let pnl = 0;
        let pnlCoins = 0;
        let pct = 0;
        if (!reason) {
          /* legacy trades created before absolute TP/SL prices existed */
          const move = (q.price - t.entryPrice) / t.entryPrice;
          pnl = (Number(t.capitalCoins) || 0) * lev * move * dir;
          pnl = Math.max(-(Number(t.capitalCoins) || 0), pnl);
          pnlCoins = round(pnl, 2);
          pct = (Number(t.capitalCoins) || 0) ? (pnlCoins / t.capitalCoins) * 100 : 0;
          if (Number(t.tpPct) > 0 && pct >= Number(t.tpPct)) reason = 'Take Profit Hit';
          else if (Number(t.slPct) > 0 && pct <= -Number(t.slPct)) reason = 'Stop Loss Hit';
          else if (Number(t.expiresAt) && now >= Number(t.expiresAt)) reason = 'Time limit reached';
        }
        if (!reason) continue;
        /* absolute TP/SL exits settle on the tick that triggered them */
        if (reason === 'Take Profit Hit' || reason === 'Stop Loss Hit' || reason === 'Trailing Stop Hit') {
          const move = (q.price - t.entryPrice) / t.entryPrice;
          pnl = (Number(t.capitalCoins) || 0) * lev * move * dir;
          pnl = Math.max(-(Number(t.capitalCoins) || 0), pnl);
          pnlCoins = round(pnl, 2);
          pct = (Number(t.capitalCoins) || 0) ? (pnlCoins / t.capitalCoins) * 100 : 0;
        }
        const payout = Math.max(0, round((Number(t.capitalCoins) || 0) + pnlCoins, 2));
        const u = (db.users || []).find((x) => x.id === t.userId);
        if (!u) continue;

        u.balance = round((Number(u.balance) || 0) + payout, 2);

        /* duration-scaled virtual dividend, paid only when the timer expires */
        let dividendCoins = 0;
        if (reason === 'Time limit reached' && !t.dividendPaid) {
          const inv = db.invest || {};
          const mode = inv.dividendPayoutMode || 'all';
          const yieldPct = Number(t.dividendYield) >= 0 ? Number(t.dividendYield) : this.dividendYieldFor(db, t.ticker);
          const minutes = Number(t.durationMinutes) || 0;
          const mult = Number(inv.dividendMultiplier) > 0 ? Number(inv.dividendMultiplier) : 1;
          let bonus = Number(t.dividendBonus);
          if (!(bonus > 0) && yieldPct > 0 && minutes > 0) {
            bonus = (Number(t.capitalCoins) || 0) * (yieldPct / 100 / 365) * mult * (minutes / 1440);
            if (bonus > 0 && bonus < 0.01) bonus = 0.01;
            bonus = round(bonus, 2);
          }
          if (mode === 'wins' && pnlCoins <= 0) bonus = 0;
          if (bonus > 0) {
            dividendCoins = round(bonus, 2);
            u.balance = round((Number(u.balance) || 0) + dividendCoins, 2);
            t.dividendPaid = true;
            t.dividendCoins = dividendCoins;
            t.dividendPaidAt = now;
            db.txs = db.txs || [];
            db.txs.unshift({
              id: id('tx_'), userId: u.id, type: 'dividend',
              label: `Dividend Bonus - ${t.ticker} (${durationLabel(minutes, t.durationLabel)})`,
              coins: dividendCoins,
              meta: { tradeId: t.id, annualYield: yieldPct, multiplier: mult, server: true },
              createdAt: now
            });
            db.notifications = db.notifications || [];
            db.notifications.unshift({
              id: id('nt_'), userId: u.id, title: 'Dividend bonus credited',
              body: `+${dividendCoins} WC dividend for ${t.ticker} (${durationLabel(minutes, t.durationLabel)}).`,
              link: '#/invest/orders', icon: 'gift', read: false, createdAt: now
            });
          }
        }
        t.totalPayoutCoins = round(payout + dividendCoins, 2);

        t.status = 'Completed';
        t.closedAt = now;
        t.closeReason = reason;
        t.exitPrice = q.price;
        t.pnlCoins = pnlCoins;
        t.pnlUsd = round(pnlCoins * 0.5, 2);
        t.payoutCoins = payout;
        t.result = payout <= 0 ? 'loss' : pnlCoins > 0 ? 'profit' : 'flat';
        t.settledBy = 'server';

        db.txs = db.txs || [];
        db.txs.unshift({
          id: id('tx_'), userId: u.id, type: 'trade-close',
          label: `${t.ticker} trade ${reason} · ${payout ? '+' + payout + ' WC returned' : 'total loss'}`,
          coins: payout, meta: { tradeId: t.id, pnlCoins, reason, server: true }, createdAt: now
        });
        db.notifications = db.notifications || [];
        const body = payout <= 0
          ? `${t.ticker} moved against your position and the stake was lost. Nothing was returned.`
          : pnlCoins >= 0
            ? `${t.ticker} closed with +${pnlCoins} WC profit. ${payout} WC (capital + profit) was credited.`
            : `${t.ticker} closed with −${Math.abs(pnlCoins)} WC. ${payout} WC of capital was returned.`;
        db.notifications.unshift({
          id: id('nt_'), userId: u.id,
          title: reason === 'Take Profit Hit' ? 'Take Profit Hit — trade won'
            : reason === 'Trailing Stop Hit' ? 'Trailing Stop Hit — trade closed'
            : reason === 'Stop Loss Hit' ? 'Stop Loss Hit — trade closed'
            : payout <= 0 ? 'Trade closed — total loss' : pnlCoins >= 0 ? 'Take profit — trade closed' : 'Trade closed at a loss',
          body, link: '#/invest/orders', icon: payout <= 0 ? 'ban' : 'trend', read: false, createdAt: now
        });
        changed++;
        console.log('[market] settled', t.ticker, direction, 'for', u.username, '·', reason, '· exit', q.price, '· payout', payout, 'WC');
      }
      if (changed) {
        this.persist();
        try { this.broadcast('change', { rev: null, source: 'market-settlement', at: now }); } catch (e) {}
      } else if (trailingChanged && (!this._lastTrailPersist || now - this._lastTrailPersist > 30000)) {
        this._lastTrailPersist = now;
        this.persist();
      }
    } finally {
      this.settleLock = false;
    }
    return changed;
  }

  /* ------------------------------- lifecycle ---------------------------- */
  async restart() {
    this.stopTimers();
    this.closeWS();
    this.loadConfig();
    this.refreshAssets();
    this.seedBaseQuotes();
    /* TP/SL checks run every second so a level hit is settled immediately */
    this.timers.push(setInterval(() => { try { this.settleTrades(); this.settleSpot(); } catch (e) { this.lastError = e.message; } }, 1000));
    this.timers.push(setInterval(() => {
      try {
        if (this.config.mode === 'hybrid' && this.config.apiKey) this.pollCycle();
      } catch (e) { this.lastError = e.message; }
    }, Math.max(5000, this.config.refreshSec * 1000)));
    /* make fallback yields available immediately, then refresh from Finnhub */
    this.applyDividendMap(this.fallbackDividendMap(), 'fallback', 0);
    this.timers.push(setInterval(() => { this.syncDividends().catch((e) => { this.lastError = e.message; }); }, 24 * 3600 * 1000));
    if (this.config.mode === 'hybrid' && this.config.apiKey) {
      this.connectWS();
      await this.seedFromFinnhub();
      await this.syncDividends();
    } else {
      this.dividendSource = 'fallback';
    }
  }

  stopTimers() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
  }

  start() {
    this.loadConfig();
    this.seedBaseQuotes();
    this.restart().catch((e) => { this.lastError = e.message; });
    console.log('[market] mode:', this.config.mode, '· refresh:', this.config.refreshSec + 's', '· key:', this.config.apiKey ? 'set' : 'not set');
  }

  stop() {
    this.stopped = true;
    this.stopTimers();
    this.closeWS();
  }
}

module.exports = { MarketService, TICKERS, DEFAULT_ASSETS, assetKey, displayTickerFor, usMarketOpen };
