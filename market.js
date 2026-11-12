'use strict';
/* =========================================================================
   WhaleChat market data service — Alpaca
   - Alpaca Market Data REST (historical 1-minute bars + snapshots)
   - one shared Alpaca IEX WebSocket for live trades/bars
   - per-stock admin Price Override % applied to every quote and chart bar
   - Alpaca Assets + Corporate Actions sync for metadata and dividends
   - server-side settlement of spot positions (TP / SL / due time) so funds
     are returned even when every browser is closed
   API keys never leave this process.
   ========================================================================= */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ASSETS = [
  { ticker: 'AAPL', displayTicker: 'AAPL', alpacaSymbol: 'AAPL', assetClass: 'us', name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD', sector: 'Technology', color: '#2ee6c9' },
  { ticker: 'TSLA', displayTicker: 'TSLA', alpacaSymbol: 'TSLA', assetClass: 'us', name: 'Tesla Inc.', exchange: 'NASDAQ', currency: 'USD', sector: 'Automotive', color: '#e82127' },
  { ticker: 'NVDA', displayTicker: 'NVDA', alpacaSymbol: 'NVDA', assetClass: 'us', name: 'NVIDIA Corporation', exchange: 'NASDAQ', currency: 'USD', sector: 'Semiconductors', color: '#76b900' },
  { ticker: 'AMZN', displayTicker: 'AMZN', alpacaSymbol: 'AMZN', assetClass: 'us', name: 'Amazon.com Inc.', exchange: 'NASDAQ', currency: 'USD', sector: 'Consumer', color: '#ff9900' },
  { ticker: 'MSFT', displayTicker: 'MSFT', alpacaSymbol: 'MSFT', assetClass: 'us', name: 'Microsoft Corporation', exchange: 'NASDAQ', currency: 'USD', sector: 'Technology', color: '#00a4ef' },
  { ticker: 'GOOGL', displayTicker: 'GOOGL', alpacaSymbol: 'GOOGL', assetClass: 'us', name: 'Alphabet Inc.', exchange: 'NASDAQ', currency: 'USD', sector: 'Technology', color: '#4285f4' },
  { ticker: 'META', displayTicker: 'META', alpacaSymbol: 'META', assetClass: 'us', name: 'Meta Platforms Inc.', exchange: 'NASDAQ', currency: 'USD', sector: 'Technology', color: '#0866ff' },
  { ticker: 'AMD', displayTicker: 'AMD', alpacaSymbol: 'AMD', assetClass: 'us', name: 'Advanced Micro Devices', exchange: 'NASDAQ', currency: 'USD', sector: 'Semiconductors', color: '#ed1c24' },
  { ticker: 'NFLX', displayTicker: 'NFLX', alpacaSymbol: 'NFLX', assetClass: 'us', name: 'Netflix Inc.', exchange: 'NASDAQ', currency: 'USD', sector: 'Media', color: '#e50914' },
  { ticker: 'JPM', displayTicker: 'JPM', alpacaSymbol: 'JPM', assetClass: 'us', name: 'JPMorgan Chase & Co.', exchange: 'NYSE', currency: 'USD', sector: 'Financials', color: '#5a8dcc' },
  { ticker: 'V', displayTicker: 'V', alpacaSymbol: 'V', assetClass: 'us', name: 'Visa Inc.', exchange: 'NYSE', currency: 'USD', sector: 'Financials', color: '#1a1f71' },
  { ticker: 'KO', displayTicker: 'KO', alpacaSymbol: 'KO', assetClass: 'us', name: 'The Coca-Cola Company', exchange: 'NYSE', currency: 'USD', sector: 'Consumer', color: '#f40009' },
  { ticker: 'WMT', displayTicker: 'WMT', alpacaSymbol: 'WMT', assetClass: 'us', name: 'Walmart Inc.', exchange: 'NYSE', currency: 'USD', sector: 'Retail', color: '#0071ce' },
  { ticker: 'DIS', displayTicker: 'DIS', alpacaSymbol: 'DIS', assetClass: 'us', name: 'The Walt Disney Company', exchange: 'NYSE', currency: 'USD', sector: 'Media', color: '#113ccf' },
  { ticker: 'UBER', displayTicker: 'UBER', alpacaSymbol: 'UBER', assetClass: 'us', name: 'Uber Technologies Inc.', exchange: 'NYSE', currency: 'USD', sector: 'Technology', color: '#000000' },
  { ticker: 'COIN', displayTicker: 'COIN', alpacaSymbol: 'COIN', assetClass: 'us', name: 'Coinbase Global Inc.', exchange: 'NASDAQ', currency: 'USD', sector: 'Financials', color: '#0052ff' },
  { ticker: 'PLTR', displayTicker: 'PLTR', alpacaSymbol: 'PLTR', assetClass: 'us', name: 'Palantir Technologies', exchange: 'NASDAQ', currency: 'USD', sector: 'Technology', color: '#101113' },
  { ticker: 'AVGO', displayTicker: 'AVGO', alpacaSymbol: 'AVGO', assetClass: 'us', name: 'Broadcom Inc.', exchange: 'NASDAQ', currency: 'USD', sector: 'Semiconductors', color: '#cc0000' },
  { ticker: 'NKE', displayTicker: 'NKE', alpacaSymbol: 'NKE', assetClass: 'us', name: 'NIKE Inc.', exchange: 'NYSE', currency: 'USD', sector: 'Consumer', color: '#111111' },
  { ticker: 'UNH', displayTicker: 'UNH', alpacaSymbol: 'UNH', assetClass: 'us', name: 'UnitedHealth Group', exchange: 'NYSE', currency: 'USD', sector: 'Healthcare', color: '#002677' }
];

const DURATION_LABELS = { 5: '5 min', 15: '15 min', 60: '1 hour', 240: '4 hours', 1440: '1 day' };
const POPULAR_ORDER = DEFAULT_ASSETS.map((a) => a.ticker);

function assetKey(symbol, assetClass) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (assetClass === 'us' || !assetClass) return sym;
  return sym.replace(/[^A-Z0-9]/g, '_');
}
function displayTickerFor(symbol) { return String(symbol || '').toUpperCase(); }

function durationLabel(minutes, stored) {
  return stored || DURATION_LABELS[Number(minutes)] || (Number(minutes) ? Number(minutes) + ' min' : 'duration');
}

const NY_HOLIDAYS = new Set([
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19',
  '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'
]);

const ALPACA_DATA_BASE = (process.env.ALPACA_DATA_BASE || 'https://data.alpaca.markets').replace(/\/+$/, '');
const ALPACA_WS_URL = process.env.ALPACA_WS_URL || 'wss://stream.data.alpaca.markets/v2/iex';
const ALPACA_FEED = process.env.ALPACA_FEED || 'iex';
const SEED_DELAY_MS = Math.max(0, Number(process.env.ALPACA_SEED_DELAY_MS) || 250);
const FORCE_MARKET_OPEN = process.env.US_MARKET_FORCE_OPEN === '1';
const ASSET_IMPORT_LIMIT = Math.max(20, Math.min(500, Number(process.env.ALPACA_ASSET_LIMIT) || 150));
const MAX_WS_SYMBOLS = Math.max(20, Math.min(500, Number(process.env.ALPACA_MAX_WS_SYMBOLS) || 200));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, n) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n);

function humanAge(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return 'never';
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

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
  } catch (e) { return new Date(d || Date.now()).toISOString().slice(0, 10); }
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
function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }

class MarketService {
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.getDb = opts.getDb;
    this.persist = opts.persist || (() => {});
    this.broadcast = opts.broadcast || (() => {});
    this.configFile = path.join(this.dataDir, 'market-config.json');
    this.config = { mode: 'paper', keyId: '', secret: '', refreshSec: 15, feed: ALPACA_FEED, syncEnabled: true, syncIntervalMin: 60 };
    this.quotes = {};
    this.assets = [];
    this.bySymbol = new Map();
    this.history = {};
    this.barsCache = new Map();
    this.assetsCache = null;
    this.assetsCacheAt = 0;
    this._lastSettleAt = 0;
    this.lastReal = {};
    this.lastRealTime = {};
    this.lastRealAt = 0;
    this.lastTickAt = 0;
    this.ws = null;
    this.wsConnected = false;
    this.wsAuthed = false;
    this.wsTicks = 0;
    this.lastWsTickAt = 0;
    this.rateLimitedUntil = 0;
    this.polling = false;
    this.stopped = false;
    this.lastError = '';
    this.seeding = false;
    this.syncingAssets = false;
    this.syncRunning = false;
    this.lastSyncAt = 0;
    this.lastSyncError = '';
    this.startedAt = Date.now();
    this.syncingDividends = false;
    this.dividendSyncedAt = 0;
    this.dividendSource = '';
    this.dividendFetched = 0;
    this.dividendAttempted = 0;
    this.dividendFailed = [];
    this.timers = [];
    this.settleLock = false;
    this.apiCalls = [];
    this.maxCallsPerMin = Math.max(30, Math.min(200, Number(process.env.ALPACA_MAX_CALLS_PER_MIN) || 180));
    this.seedOk = 0;
    this.seedFailed = [];
    this.lastLatencyMs = 0;
    this.lastRestOkAt = 0;
    this.lastRestFailAt = 0;
    this.lastRestFail = '';
    this.lastTestAt = 0;
    this.lastTestOk = null;
  }

  /* ------------------------------- config ------------------------------- */
  configured() { return !!(this.config.keyId && this.config.secret); }
  tradingBase() {
    if (process.env.ALPACA_TRADING_BASE) return String(process.env.ALPACA_TRADING_BASE).replace(/\/+$/, '');
    /* paper keys must use the paper host for assets / corporate actions */
    return this.config.mode === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
  }
  rawConfig() {
    return {
      mode: this.config.mode, keyId: this.config.keyId, secret: this.config.secret,
      refreshSec: this.config.refreshSec, feed: this.config.feed,
      syncEnabled: this.config.syncEnabled, syncIntervalMin: this.config.syncIntervalMin
    };
  }

  writeConfigFile() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify(this.rawConfig(), null, 2), { mode: 0o600 });
      try { fs.chmodSync(this.configFile, 0o600); } catch (e) {}
    } catch (e) { this.lastError = 'Could not save Alpaca config: ' + e.message; }
  }

  hydrateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return false;
    if (cfg.mode === 'live' || cfg.mode === 'paper') this.config.mode = cfg.mode;
    if (typeof cfg.keyId === 'string') this.config.keyId = cfg.keyId.trim();
    if (typeof cfg.secret === 'string') this.config.secret = cfg.secret.trim();
    if (cfg.refreshSec != null) this.config.refreshSec = Math.min(300, Math.max(5, Math.round(Number(cfg.refreshSec) || 15)));
    if (cfg.feed) this.config.feed = String(cfg.feed).toLowerCase() === 'sip' ? 'sip' : 'iex';
    if (cfg.syncEnabled != null) this.config.syncEnabled = !!cfg.syncEnabled;
    if (cfg.syncIntervalMin != null) this.config.syncIntervalMin = Math.min(10080, Math.max(5, Math.round(Number(cfg.syncIntervalMin) || 60)));
    this.writeConfigFile();
    return true;
  }

  loadConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.mode === 'live' || raw.mode === 'paper') this.config.mode = raw.mode;
        this.config.keyId = typeof raw.keyId === 'string' ? raw.keyId.trim() : '';
        this.config.secret = typeof raw.secret === 'string' ? raw.secret.trim() : '';
        this.config.refreshSec = Math.min(300, Math.max(5, Number(raw.refreshSec) || 15));
        this.config.feed = String(raw.feed || ALPACA_FEED).toLowerCase() === 'sip' ? 'sip' : 'iex';
        if (raw.syncEnabled != null) this.config.syncEnabled = !!raw.syncEnabled;
        if (raw.syncIntervalMin != null) this.config.syncIntervalMin = Math.min(10080, Math.max(5, Number(raw.syncIntervalMin) || 60));
      }
    } catch (e) { /* first run */ }
    if (!this.config.keyId && process.env.ALPACA_KEY_ID) this.config.keyId = String(process.env.ALPACA_KEY_ID).trim();
    if (!this.config.secret && process.env.ALPACA_SECRET_KEY) this.config.secret = String(process.env.ALPACA_SECRET_KEY).trim();
    if (process.env.ALPACA_MODE === 'live') this.config.mode = 'live';
    if (process.env.ALPACA_SYNC_INTERVAL_MIN) this.config.syncIntervalMin = Math.min(10080, Math.max(5, Number(process.env.ALPACA_SYNC_INTERVAL_MIN) || 60));
  }

  saveConfig(next) {
    const cfg = this.rawConfig();
    if (next.mode === 'live' || next.mode === 'paper') cfg.mode = next.mode;
    if (typeof next.keyId === 'string' && next.keyId.trim()) cfg.keyId = next.keyId.trim();
    if (typeof next.secret === 'string' && next.secret.trim()) cfg.secret = next.secret.trim();
    if (next.clearKeys === true || next.clearKey === true) { cfg.keyId = ''; cfg.secret = ''; }
    if (next.refreshSec != null) cfg.refreshSec = Math.min(300, Math.max(5, Math.round(Number(next.refreshSec) || 15)));
    if (next.feed) cfg.feed = String(next.feed).toLowerCase() === 'sip' ? 'sip' : 'iex';
    if (next.syncEnabled != null) cfg.syncEnabled = !!next.syncEnabled;
    if (next.syncIntervalMin != null) cfg.syncIntervalMin = Math.min(10080, Math.max(5, Math.round(Number(next.syncIntervalMin) || 60)));
    this.config = cfg;
    this.assetsCache = null;
    this.assetsCacheAt = 0;
    this.writeConfigFile();
    this.restart();
    return this.publicConfig();
  }

  maskedKeyId() {
    const key = this.config.keyId || '';
    return key ? (key.slice(0, 4) + '…' + key.slice(-4)) : '';
  }

  publicConfig() {
    const key = this.config.keyId;
    return {
      ok: true,
      mode: this.config.mode,
      environment: this.config.mode === 'live' ? 'Live Data' : 'Paper / Sandbox',
      refreshSec: this.config.refreshSec,
      feed: this.config.feed,
      syncEnabled: this.config.syncEnabled,
      syncIntervalMin: this.config.syncIntervalMin,
      hasKeys: this.configured(),
      hasKey: this.configured(),
      keyIdMasked: key ? (key.slice(0, 4) + '…' + key.slice(-4)) : '',
      status: this.status()
    };
  }

  /* --------------------------- Alpaca call budget ----------------------- */
  async reserveApiCall() {
    for (let guard = 0; guard < 30; guard++) {
      const now = Date.now();
      this.apiCalls = this.apiCalls.filter((t) => now - t < 60000);
      if (this.apiCalls.length < this.maxCallsPerMin) { this.apiCalls.push(now); return; }
      await sleep(Math.max(250, 60000 - (now - this.apiCalls[0]) + 120));
    }
  }
  async waitForCooldown() {
    const left = this.rateLimitedUntil - Date.now();
    if (left > 0) await sleep(Math.min(90000, left + 400));
  }

  /* ------------------------------- quotes ------------------------------- */
  refreshAssets() {
    const db = this.getDb && this.getDb();
    const list = (db && Array.isArray(db.stocks)) ? db.stocks.filter((s) => s && s.ticker) : [];
    this.assets = list.map((s) => ({
      ticker: String(s.ticker).toUpperCase(),
      displayTicker: s.displayTicker || s.ticker,
      alpacaSymbol: s.alpacaSymbol || s.ticker,
      symbol: s.alpacaSymbol || s.ticker,
      assetClass: s.assetClass || 'us',
      name: s.name || s.ticker,
      exchange: s.exchange || 'US',
      currency: s.currency || 'USD',
      overridePct: Number(s.overridePct) || 0,
      paused: !!s.paused,
      price: Number(s.price) || 0
    }));
    this.bySymbol = new Map(this.assets.map((a) => [String(a.alpacaSymbol).toUpperCase(), a.ticker]));
    return this.assets;
  }

  assetList() { return this.assets.length ? this.assets : this.refreshAssets(); }
  assetClasses() {
    const out = { us: 0, global: 0, forex: 0, crypto: 0 };
    this.assetList().forEach((a) => { out[a.assetClass] = (out[a.assetClass] || 0) + 1; });
    return out;
  }

  effectivePrice(raw, overridePct) {
    return round(Number(raw) * (1 + (Number(overridePct) || 0) / 100), 4);
  }

  seedBaseQuotes() {
    const now = Date.now();
    this.refreshAssets();
    this.assetList().forEach((a) => {
      if (this.quotes[a.ticker]) return;
      const raw = Number(a.price) || 0;
      const price = raw > 0 ? this.effectivePrice(raw, a.overridePct) : 0;
      this.quotes[a.ticker] = {
        ticker: a.ticker, price, rawPrice: raw, overridePct: a.overridePct,
        prevClose: price, open: price, dayHigh: price, dayLow: price,
        changePct: 0, changeUsd: 0, vol: 0,
        dir: 0, updatedAt: now, source: 'cached', real: false
      };
      if (price > 0) this.recordHistory(a.ticker, price, now, 'cached', false);
    });
  }

  writeQuote(ticker, rawPrice, meta) {
    if (!Number.isFinite(Number(rawPrice)) || Number(rawPrice) <= 0) return;
    const asset = this.assetList().find((a) => a.ticker === String(ticker).toUpperCase());
    const override = asset ? Number(asset.overridePct) || 0 : 0;
    const price = this.effectivePrice(rawPrice, override);
    if (!(price > 0)) return;
    const now = Date.now();
    const prev = this.quotes[ticker] || { prevClose: price, open: price, dayHigh: price, dayLow: price, vol: 1000000 };
    const q = {
      ticker,
      price: round(price, 4),
      rawPrice: round(rawPrice, 4),
      overridePct: override,
      prevClose: Number(meta && meta.prevClose) > 0 ? this.effectivePrice(meta.prevClose, override) : (prev.prevClose || round(price, 4)),
      open: Number(meta && meta.open) > 0 ? this.effectivePrice(meta.open, override) : (prev.open || round(price, 4)),
      dayHigh: Math.max(prev.dayHigh || price, Number(meta && meta.dayHigh) ? this.effectivePrice(meta.dayHigh, override) : 0, price),
      dayLow: Math.min(prev.dayLow || price, Number(meta && meta.dayLow) ? this.effectivePrice(meta.dayLow, override) : price, price),
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

  repriceAll() {
    this.refreshAssets();
    const touched = [];
    this.assetList().forEach((a) => {
      const q = this.quotes[a.ticker];
      if (!q) return;
      const raw = Number(q.rawPrice) > 0 ? Number(q.rawPrice) : Number(a.price) || 0;
      if (!(raw > 0)) return;
      const price = this.effectivePrice(raw, a.overridePct);
      const factor = (Number(q.prevClose) || 0) > 0 && Number(q.overridePct) !== Number(a.overridePct)
        ? (1 + (Number(a.overridePct) || 0) / 100) / (1 + (Number(q.overridePct) || 0) / 100) : 1;
      q.overridePct = a.overridePct;
      q.price = round(price, 4);
      q.rawPrice = round(raw, 4);
      if (factor !== 1) {
        q.prevClose = round((Number(q.prevClose) || price) * factor, 4);
        q.open = round((Number(q.open) || price) * factor, 4);
        q.dayHigh = round((Number(q.dayHigh) || price) * factor, 4);
        q.dayLow = round((Number(q.dayLow) || price) * factor, 4);
      }
      q.changeUsd = round(q.price - q.prevClose, 4);
      q.changePct = q.prevClose ? round((q.changeUsd / q.prevClose) * 100, 4) : 0;
      q.updatedAt = Date.now();
      this.recordHistory(a.ticker, q.price, q.updatedAt, 'override', false);
      touched.push(a.ticker);
    });
    return touched;
  }

  recordHistory(ticker, price, now, source, real) {
    const arr = this.history[ticker] || (this.history[ticker] = []);
    const at = now || Date.now();
    const last = arr[arr.length - 1];
    if (last && at - last.t < 2000) { last.p = round(price, 4); last.t = at; last.real = !!real; return; }
    arr.push({ t: at, p: round(price, 4), real: !!real, source: source || 'alpaca' });
    if (arr.length > 3000) arr.splice(0, arr.length - 3000);
  }

  historyFor(tickers, limit) {
    const out = {};
    const n = Math.max(10, Math.min(3000, Number(limit) || 600));
    (tickers || []).forEach((t) => { out[t] = (this.history[t] || []).slice(-n); });
    return out;
  }

  _settleSoon() {
    const now = Date.now();
    if (now - this._lastSettleAt < 500) return;
    this._lastSettleAt = now;
    try { this.settleTrades(); this.settleSpot(); } catch (e) { this.lastError = e.message; }
  }

  /* --------------------------- Alpaca REST ------------------------------ */
  getJSON(url, timeoutMs, headers) {
    return new Promise((resolve, reject) => {
      const client = /^http:\/\//i.test(url) ? http : https;
      const req = client.get(url, {
        timeout: timeoutMs || 10000,
        headers: Object.assign({ 'User-Agent': 'WhaleChat/3.26 alpaca-market', Accept: 'application/json' }, headers || {})
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 40e6) req.destroy(); });
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

  authHeaders() {
    return {
      'APCA-API-KEY-ID': this.config.keyId,
      'APCA-API-SECRET-KEY': this.config.secret
    };
  }

  async apiGet(pathname, base, timeout) {
    if (!this.configured()) throw new Error('Add your Alpaca API Key ID and Secret Key');
    const host = base === 'trading' ? this.tradingBase() : ALPACA_DATA_BASE;
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.waitForCooldown();
      await this.reserveApiCall();
      const t0 = Date.now();
      const r = await this.getJSON(host + pathname, timeout || 12000, this.authHeaders());
      this.lastLatencyMs = Date.now() - t0;
      if (r.status === 200) { this.lastRestOkAt = Date.now(); }
      else { this.lastRestFailAt = Date.now(); this.lastRestFail = 'HTTP ' + r.status; }
      last = r;
      if (r.status === 429) {
        this.rateLimitedUntil = Date.now() + 30000;
        this.lastError = 'Alpaca rate limit hit — retrying shortly';
        if (attempt < 2) { await this.waitForCooldown(); continue; }
        const e = new Error('Alpaca rate limit'); e.code = 429; throw e;
      }
      if (r.status === 401 || r.status === 403) {
        this.lastError = 'Alpaca rejected the API keys (' + r.status + ')';
        const e = new Error('Alpaca authentication failed — check your Key ID and Secret Key'); e.code = r.status; throw e;
      }
      if (r.status >= 500 && attempt < 2) { await sleep(1200); continue; }
      if (r.status !== 200 || !r.data) {
        this.lastError = 'Alpaca HTTP ' + r.status;
        throw new Error((r.data && (r.data.message || r.data.error)) || ('Alpaca HTTP ' + r.status));
      }
      this.rateLimitedUntil = 0;
      this.lastError = '';
      return r.data;
    }
    throw new Error('Alpaca request failed' + (last ? ' (HTTP ' + last.status + ')' : ''));
  }

  snapshotForSymbol(snap) {
    if (!snap || typeof snap !== 'object') return null;
    const raw = Number(
      (snap.latestTrade && snap.latestTrade.p) ||
      (snap.minuteBar && snap.minuteBar.c) ||
      (snap.dailyBar && snap.dailyBar.c) ||
      (snap.prevDailyBar && snap.prevDailyBar.c)
    );
    if (!(raw > 0)) return null;
    return {
      price: raw,
      prevClose: Number(snap.prevDailyBar && snap.prevDailyBar.c) || raw,
      open: Number(snap.dailyBar && snap.dailyBar.o) || raw,
      dayHigh: Number(snap.dailyBar && snap.dailyBar.h) || raw,
      dayLow: Number(snap.dailyBar && snap.dailyBar.l) || raw,
      vol: Number(snap.dailyBar && snap.dailyBar.v) || 0
    };
  }

  async fetchSnapshots(symbols) {
    const list = Array.from(new Set((symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean)));
    const out = {};
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      try {
        const data = await this.apiGet('/v2/stocks/snapshots?symbols=' + encodeURIComponent(chunk.join(',')) + '&feed=' + encodeURIComponent(this.config.feed), 'data', 15000);
        Object.keys(data || {}).forEach((sym) => { out[String(sym).toUpperCase()] = data[sym]; });
      } catch (e) {
        if (e.code === 429) await this.waitForCooldown();
        else throw e;
      }
      if (i + 100 < list.length) await sleep(SEED_DELAY_MS);
    }
    return out;
  }

  async fetchQuote(symbol) {
    try {
      const snap = (await this.fetchSnapshots([symbol.toUpperCase()]))[String(symbol).toUpperCase()];
      return this.snapshotForSymbol(snap);
    } catch (e) { return null; }
  }

  async seedAsset(ticker) {
    const a = this.assetList().find((x) => x.ticker === ticker);
    if (!a) return null;
    const q = await this.fetchQuote(a.alpacaSymbol);
    if (!q) return null;
    this.writeQuote(a.ticker, q.price, { prevClose: q.prevClose, open: q.open, dayHigh: q.dayHigh, dayLow: q.dayLow, vol: q.vol, source: 'live', real: true });
    return q;
  }

  async seedFromAlpaca() {
    if (this.seeding || !this.configured()) return;
    this.seeding = true;
    this.seedOk = 0;
    this.seedFailed = [];
    try {
      const assets = this.assetList().filter((a) => a.assetClass === 'us');
      if (!assets.length) { this.seedFailed = []; return; }
      const snaps = await this.fetchSnapshots(assets.map((a) => a.alpacaSymbol));
      for (const a of assets) {
        const q = this.snapshotForSymbol(snaps[String(a.alpacaSymbol).toUpperCase()]);
        if (q) {
          this.writeQuote(a.ticker, q.price, { prevClose: q.prevClose, open: q.open, dayHigh: q.dayHigh, dayLow: q.dayLow, vol: q.vol, source: 'live', real: true });
          this.seedOk++;
        } else this.seedFailed.push(a.ticker);
      }
      if (!this.seedFailed.length) this.lastError = '';
      console.log('[market] Alpaca snapshots ·', this.seedOk + '/' + assets.length, 'assets live', this.seedFailed.length ? '· missing: ' + this.seedFailed.slice(0, 10).join(',') : '');
    } catch (e) {
      this.lastError = 'Alpaca snapshot sync failed: ' + e.message;
      console.error('[market] Alpaca snapshot sync failed:', e.message);
    } finally { this.seeding = false; }
  }

  async pollCycle() {
    if (this.polling || !this.configured()) return;
    if (this.stopped) return;
    if (Date.now() < this.rateLimitedUntil) return;
    this.polling = true;
    try {
      const wsFresh = this.wsConnected && this.lastWsTickAt && Date.now() - this.lastWsTickAt < 45000;
      if (!wsFresh) await this.seedFromAlpaca();
    } finally { this.polling = false; }
  }

  /* --------------------------- historical bars -------------------------- */
  async fetchBars(symbol, limit, timeframe) {
    const sym = String(symbol || '').toUpperCase();
    const n = Math.max(30, Math.min(2000, Number(limit) || 600));
    const tf = timeframe || '1Min';
    const key = sym + '|' + n + '|' + tf;
    const cached = this.barsCache.get(key);
    if (cached && Date.now() - cached.at < 45000) return cached.bars;
    if (!this.configured()) return [];
    try {
      const data = await this.apiGet('/v2/stocks/' + encodeURIComponent(sym) + '/bars?timeframe=' + encodeURIComponent(tf) + '&limit=' + n + '&adjustment=raw&feed=' + encodeURIComponent(this.config.feed) + '&sort=asc', 'data', 15000);
      const asset = this.assetList().find((a) => a.alpacaSymbol.toUpperCase() === sym || a.ticker === sym);
      const override = asset ? Number(asset.overridePct) || 0 : 0;
      const bars = (Array.isArray(data.bars) ? data.bars : []).map((b) => ({
        t: new Date(b.t).getTime(),
        o: this.effectivePrice(b.o, override),
        h: this.effectivePrice(b.h, override),
        l: this.effectivePrice(b.l, override),
        c: this.effectivePrice(b.c, override),
        v: Number(b.v) || 0
      })).filter((b) => b.t > 0 && b.c > 0);
      this.barsCache.set(key, { at: Date.now(), bars });
      return bars;
    } catch (e) {
      this.lastError = 'Alpaca bars failed: ' + e.message;
      return [];
    }
  }

  /* ------------------------------- assets ------------------------------- */
  async loadAssetsCache(force) {
    if (!force && this.assetsCache && Date.now() - this.assetsCacheAt < 12 * 3600 * 1000) return this.assetsCache;
    const data = await this.apiGet('/v2/assets?status=active&asset_class=us_equity', 'trading', 20000);
    const list = (Array.isArray(data) ? data : []).filter((a) => a && a.symbol && a.tradable && a.status === 'active');
    this.assetsCache = list;
    this.assetsCacheAt = Date.now();
    return list;
  }

  async searchAssets(query, cls) {
    const q = String(query || '').trim().toUpperCase();
    if (!q) return [];
    if (cls && cls !== 'us') return [];
    try {
      const list = await this.loadAssetsCache(false);
      return list.filter((a) => String(a.symbol).toUpperCase().includes(q) || String(a.name || '').toUpperCase().includes(q))
        .slice(0, 25)
        .map((a) => ({ symbol: a.symbol, display: a.symbol, description: a.name || a.symbol, type: 'Stock', exchange: a.exchange || 'US' }));
    } catch (e) { throw e; }
  }

  async profileFor(symbol) {
    try {
      const list = await this.loadAssetsCache(false);
      return list.find((a) => String(a.symbol).toUpperCase() === String(symbol).toUpperCase()) || {};
    } catch (e) { return {}; }
  }

  async addAsset(cls, symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) throw new Error('Symbol is required');
    if (cls && cls !== 'us') throw new Error('Alpaca market data supports US stocks only');
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database is not ready');
    const ticker = assetKey(sym, 'us');
    if ((db.stocks || []).some((s) => String(s.ticker).toUpperCase() === ticker || String(s.alpacaSymbol || '').toUpperCase() === sym)) {
      return { existing: true, asset: (db.stocks || []).find((s) => String(s.ticker).toUpperCase() === ticker) };
    }
    const profile = await this.profileFor(sym).catch(() => ({}));
    if (!profile.symbol) throw new Error('Alpaca did not find a tradable US stock called ' + sym);
    const quote = await this.fetchQuote(sym).catch(() => null);
    const dividendYield = await this.fetchDividendYield(sym).catch(() => null) || 0;
    const asset = {
      id: 'st_' + ticker.toLowerCase().replace(/[^a-z0-9]/g, ''),
      ticker, displayTicker: sym, alpacaSymbol: sym, assetClass: 'us',
      name: profile.name || sym, sector: 'Stock', exchange: profile.exchange || 'US', currency: 'USD',
      logo: '', website: '', ceo: '', about: profile.name || sym,
      price: quote ? quote.price : 0, prevClose: quote ? quote.prevClose : 0,
      div: dividendYield, dividendYield, overridePct: 0,
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
    if (quote) this.writeQuote(ticker, quote.price, { prevClose: quote.prevClose, open: quote.open, dayHigh: quote.dayHigh, dayLow: quote.dayLow, vol: quote.vol, source: 'live', real: true });
    this.persist();
    try { this.broadcast('change', { rev: null, source: 'market-asset-add', at: Date.now() }); } catch (e) {}
    this.subscribeSymbol(sym);
    return { existing: false, asset };
  }

  async syncAssets() {
    if (this.syncingAssets) return { ok: false, error: 'sync already running' };
    if (!this.configured()) throw new Error('Add your Alpaca API keys first');
    this.syncingAssets = true;
    const db = this.getDb && this.getDb();
    if (!db) { this.syncingAssets = false; throw new Error('Database is not ready'); }
    try {
      const list = await this.loadAssetsCache(true);
      const bySym = new Map(list.map((a) => [String(a.symbol).toUpperCase(), a]));
      db.stocks = db.stocks || [];
      let updated = 0, added = 0;
      const existing = new Set(db.stocks.map((s) => String(s.ticker).toUpperCase()));
      for (const s of db.stocks) {
        const sym = String(s.alpacaSymbol || s.ticker).toUpperCase();
        const a = bySym.get(sym);
        if (!a) continue;
        if (s.name !== a.name || s.exchange !== (a.exchange || 'US') || s.assetClass !== 'us') {
          s.name = a.name || s.name; s.exchange = a.exchange || s.exchange; s.assetClass = 'us';
        }
        s.alpacaSymbol = sym;
        if (s.overridePct == null) s.overridePct = 0;
        updated++;
      }
      const candidates = list.filter((a) => a.tradable && a.status === 'active' && String(a.symbol).indexOf('/') === -1)
        .sort((a, b) => {
          const ia = POPULAR_ORDER.indexOf(a.symbol), ib = POPULAR_ORDER.indexOf(b.symbol);
          if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
          return String(a.symbol).localeCompare(String(b.symbol));
        });
      for (const a of candidates) {
        const sym = String(a.symbol).toUpperCase();
        const ticker = assetKey(sym, 'us');
        if (existing.has(ticker)) continue;
        if (db.stocks.filter((s) => (s.assetClass || 'us') === 'us').length >= ASSET_IMPORT_LIMIT) break;
        db.stocks.push({
          id: 'st_' + ticker.toLowerCase().replace(/[^a-z0-9]/g, ''),
          ticker, displayTicker: sym, alpacaSymbol: sym, assetClass: 'us',
          name: a.name || sym, sector: 'Stock', exchange: a.exchange || 'US', currency: 'USD',
          logo: '', website: '', ceo: '', about: a.name || sym,
          price: 0, prevClose: 0, div: 0, dividendYield: 0, overridePct: 0,
          color: ['#2ee6c9', '#3aa0ff', '#8b7bff', '#ffc861', '#2fd6a6', '#ff7bb0'][ticker.length % 6],
          paused: false, custom: true, createdAt: Date.now()
        });
        existing.add(ticker);
        added++;
      }
      this.refreshAssets();
      this.persist();
      try { this.broadcast('change', { rev: null, source: 'market-asset-sync', at: Date.now() }); } catch (e) {}
      console.log('[market] Alpaca asset sync · updated', updated, '· added', added, '· tracked', this.assetList().length);
      return { ok: true, updated, added, tracked: this.assetList().length, assets: list.length };
    } finally { this.syncingAssets = false; }
  }

  async onAssetsChanged() {
    this.refreshAssets();
    if (this.wsConnected) this.connectWS();
  }

  /* ----------------------------- WebSocket ------------------------------ */
  wsClass() {
    if (typeof global.WebSocket === 'function') return global.WebSocket;
    try { return require('ws'); } catch (e) { return null; }
  }

  wsUrl() {
    return process.env.ALPACA_WS_URL || ('wss://stream.data.alpaca.markets/v2/' + (this.config.feed === 'sip' ? 'sip' : 'iex'));
  }

  connectWS() {
    if (this.stopped || !this.configured()) return;
    const WS = this.wsClass();
    if (!WS) { this.lastError = 'WebSocket client unavailable — REST polling active'; return; }
    this.closeWS();
    let ws;
    try { ws = new WS(this.wsUrl()); } catch (e) { this.lastError = 'Alpaca WebSocket failed: ' + e.message; return; }
    this.ws = ws;
    this.wsAuthed = false;
    let retryDelay = 5000;
    const retry = () => {
      if (this.stopped || this.ws !== ws) return;
      this.wsConnected = false;
      this.wsAuthed = false;
      setTimeout(() => { if (!this.stopped) this.connectWS(); }, retryDelay);
      retryDelay = Math.min(60000, retryDelay * 2);
    };
    ws.onopen = () => {
      this.wsConnected = true;
      this.lastWsTickAt = Date.now();
      try { ws.send(JSON.stringify({ action: 'auth', key: this.config.keyId, secret: this.config.secret })); } catch (e) {}
    };
    ws.onmessage = (ev) => {
      let msgs;
      try { msgs = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
      if (!Array.isArray(msgs)) msgs = [msgs];
      for (const msg of msgs) {
        if (!msg || !msg.T) continue;
        if (msg.T === 'success' && msg.msg === 'authenticated') {
          this.wsAuthed = true;
          this.lastError = '';
          const symbols = this.assetList().filter((a) => a.assetClass === 'us').slice(0, MAX_WS_SYMBOLS).map((a) => a.alpacaSymbol);
          if (symbols.length) {
            try { ws.send(JSON.stringify({ action: 'subscribe', trades: symbols, bars: symbols })); } catch (e) {}
          }
          console.log('[market] Alpaca WebSocket authenticated ·', symbols.length, 'symbols');
        } else if (msg.T === 'error') {
          this.lastError = 'Alpaca stream: ' + (msg.msg || msg.code || 'error');
          if (msg.code === 401 || msg.code === 403) { this.wsAuthed = false; try { ws.close(); } catch (e) {} }
        } else if (msg.T === 't' || msg.T === 'b') {
          const sym = String(msg.S || '').toUpperCase();
          let t = this.bySymbol.get(sym);
          if (!t) { this.refreshAssets(); t = this.bySymbol.get(sym); }
          if (!t) continue;
          const raw = msg.T === 't' ? Number(msg.p) : Number(msg.c);
          if (!(raw > 0)) continue;
          const old = this.quotes[t] || {};
          this.writeQuote(t, raw, {
            prevClose: msg.T === 'b' ? (Number(msg.o) || old.prevClose) : old.prevClose,
            open: msg.T === 'b' ? (Number(msg.o) || old.open) : old.open,
            dayHigh: msg.T === 'b' ? Math.max(Number(msg.h) || raw, old.dayHigh || raw) : old.dayHigh,
            dayLow: msg.T === 'b' ? Math.min(Number(msg.l) || raw, old.dayLow || raw) : old.dayLow,
            vol: (Number(msg.v) || 0) || old.vol,
            source: 'live', real: true
          });
          this.wsTicks++;
          this.lastWsTickAt = Date.now();
          this._settleSoon();
        }
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
    this.wsAuthed = false;
    try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (e) {}
  }

  subscribeSymbol(symbol) {
    if (!this.ws || !this.wsConnected || !this.wsAuthed) return false;
    try { this.ws.send(JSON.stringify({ action: 'subscribe', trades: [symbol], bars: [symbol] })); return true; } catch (e) { return false; }
  }

  /* ------------------------- real-data status --------------------------- */
  fallbackReason() {
    if (!this.configured()) return 'no-alpaca-keys';
    if (Date.now() < this.rateLimitedUntil) return 'rate-limit';
    return '';
  }
  notice() {
    if (this.configured()) return 'Live market data via Alpaca (' + String(this.config.feed).toUpperCase() + ')';
    return 'Add Alpaca API keys in Admin → Stocks';
  }
  source() { return this.configured() ? 'live' : 'offline'; }

  status() {
    return {
      mode: this.config.mode,
      environment: this.config.mode === 'live' ? 'Live Data' : 'Paper / Sandbox',
      refreshSec: this.config.refreshSec,
      feed: this.config.feed,
      hasKey: this.configured(),
      hasKeys: this.configured(),
      marketOpen: usMarketOpen(),
      source: this.source(),
      notice: this.notice(),
      fallbackReason: this.fallbackReason(),
      wsConnected: this.wsConnected,
      wsAuthed: this.wsAuthed,
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
      seed: { live: this.seedOk || 0, failed: (this.seedFailed || []).length, failedTickers: (this.seedFailed || []).slice(0, 20), running: !!this.seeding },
      sync: { enabled: this.config.syncEnabled, intervalMin: this.config.syncIntervalMin, lastSyncAt: this.lastSyncAt || null, running: this.syncRunning, lastError: this.lastSyncError || '' },
      apiCallsLastMin: (this.apiCalls || []).filter((t) => Date.now() - t < 60000).length,
      apiBudgetPerMin: this.maxCallsPerMin,
      startedAt: this.startedAt
    };
  }

  snapshot() {
    return { ok: true, at: Date.now(), source: this.source(), marketOpen: usMarketOpen(), notice: this.notice(), status: this.status(), quotes: this.quotes };
  }

  /* --------------------- market audit trail -----------------------------
     Durable, append-only log of every admin override change and every data
     sync (manual + scheduled). Secrets are never recorded: only a masked key
     id is ever stored. */
  audit(action, opts) {
    const db = this.getDb && this.getDb();
    if (!db) return null;
    const o = opts || {};
    if (!Array.isArray(db.marketAudit)) db.marketAudit = [];
    const entry = {
      id: id('ma'),
      at: Date.now(),
      action: String(action || 'event'),
      category: o.category || 'system',
      actor: String(o.actor || 'system').slice(0, 60),
      actorId: o.actorId || null,
      target: String(o.target || '').slice(0, 120),
      summary: String(o.summary || '').slice(0, 400),
      changes: Array.isArray(o.changes) ? o.changes.slice(0, 50) : [],
      result: o.result || 'ok',
      durationMs: o.durationMs != null ? Number(o.durationMs) : null
    };
    db.marketAudit.unshift(entry);
    if (db.marketAudit.length > 1000) db.marketAudit.length = 1000;
    try { this.persist(); } catch (e) {}
    return entry;
  }

  auditList(limit, category) {
    const db = this.getDb && this.getDb();
    const all = (db && Array.isArray(db.marketAudit)) ? db.marketAudit : [];
    const cat = String(category || '').toLowerCase();
    const rows = cat && cat !== 'all' ? all.filter((e) => String(e.category || '').toLowerCase() === cat) : all;
    return rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  /* --------------------- connection health ----------------------------- */
  health() {
    const st = this.status();
    const now = Date.now();
    const checks = [];
    const add = (key, label, state, detail) => checks.push({ key, label, state, detail });
    const keys = !!st.hasKeys;

    add('keys', 'API credentials', keys ? 'ok' : 'error',
      keys ? ('Key ID ' + this.maskedKeyId()) : 'No Alpaca Key ID / Secret saved');

    const restAge = st.lastRealAt ? now - st.lastRealAt : null;
    const failing = this.lastRestFailAt && this.lastRestFailAt > (this.lastRestOkAt || 0);
    const restState = !keys ? 'error' : failing ? 'warn' : restAge == null ? 'warn' : restAge < 300000 ? 'ok' : 'warn';
    add('rest', 'REST snapshots', restState,
      failing ? ('Failing · ' + (this.lastRestFail || 'request error'))
        : 'Last tick ' + humanAge(restAge) + (this.lastLatencyMs ? ' · ' + this.lastLatencyMs + ' ms' : ''));

    const wsState = !keys ? 'error' : (st.wsConnected && st.wsAuthed) ? 'ok' : 'warn';
    add('ws', 'IEX WebSocket', wsState,
      !keys ? 'Needs credentials' : st.wsConnected ? (st.wsAuthed ? 'Authenticated · ' + st.wsTicks + ' ticks' : 'Open · authenticating') : 'Offline · REST fallback active');

    const limited = st.rateLimitedUntil && st.rateLimitedUntil > now;
    add('rate', 'Rate limit', limited ? 'error' : 'ok',
      limited ? ('Cooling down until ' + new Date(st.rateLimitedUntil).toLocaleTimeString()) : ((st.apiCallsLastMin || 0) + ' / ' + (st.apiBudgetPerMin || 180) + ' calls per min'));

    const syncEvery = Math.max(5, Number(st.sync && st.sync.intervalMin) || 60) * 60000;
    const syncAge = st.sync && st.sync.lastSyncAt ? now - st.sync.lastSyncAt : null;
    let syncState = 'ok', syncDetail = 'Never synced yet';
    if (!st.sync || !st.sync.enabled) { syncState = 'warn'; syncDetail = 'Auto-sync is off'; }
    else if (syncAge != null && syncAge < syncEvery * 1.5) { syncDetail = 'Last full sync ' + humanAge(syncAge) + ' · every ' + st.sync.intervalMin + ' min'; }
    else if (syncAge == null) { syncState = 'warn'; syncDetail = 'Waiting for the first scheduled sync'; }
    else { syncState = 'warn'; syncDetail = 'Overdue · last full sync ' + humanAge(syncAge); }
    if (st.sync && st.sync.lastError) { syncState = 'warn'; syncDetail = 'Last error: ' + st.sync.lastError; }
    add('sync', 'Scheduled data sync', syncState, syncDetail);

    const priced = st.tickers ? (st.tickers - (st.unpriced || 0)) / st.tickers : 0;
    const priceState = !st.tickers ? 'warn' : priced >= 0.95 ? 'ok' : priced >= 0.6 ? 'warn' : 'error';
    add('pricing', 'Price coverage', priceState, (st.tickers - (st.unpriced || 0)) + ' / ' + st.tickers + ' symbols priced');

    add('session', 'Trading session', 'info', st.marketOpen ? 'US market open' : 'US market closed');

    const scored = checks.filter((c) => c.state !== 'info');
    const points = scored.reduce((sum, c) => sum + (c.state === 'ok' ? 100 : c.state === 'warn' ? 55 : 0), 0);
    const score = scored.length ? Math.round(points / scored.length) : 100;
    const grade = score >= 90 ? 'healthy' : score >= 70 ? 'degraded' : score >= 40 ? 'at risk' : 'offline';
    return {
      ok: true, at: now, score, grade, checks,
      latencyMs: this.lastLatencyMs || null,
      lastRestOkAt: this.lastRestOkAt || null,
      lastRestFailAt: this.lastRestFailAt || null,
      lastTestAt: this.lastTestAt || null,
      lastTestOk: this.lastTestOk,
      uptimeSec: Math.floor((now - this.startedAt) / 1000),
      status: st
    };
  }

  /* --------------------------- dividends ------------------------------- */
  fallbackDividendMap() { return {}; }

  dividendYieldFor(db, ticker) {
    const inv = (db && db.invest) || {};
    const ov = inv.dividendOverrides && inv.dividendOverrides[ticker];
    if (ov != null && ov !== '' && Number.isFinite(Number(ov))) return Math.max(0, Math.min(100, Number(ov)));
    const auto = inv.dividendYields && inv.dividendYields[ticker];
    if (auto != null && Number.isFinite(Number(auto))) return Math.max(0, Math.min(100, Number(auto)));
    return 0;
  }

  applyDividendMap(map, source, liveCount) {
    const db = this.getDb && this.getDb();
    if (!db) return null;
    if (!db.invest) db.invest = {};
    db.invest.dividendYields = Object.assign({}, db.invest.dividendYields || {}, map || {});
    db.invest.dividendSyncedAt = Date.now();
    db.invest.dividendSource = source || 'alpaca';
    if (!(Number(db.invest.dividendMultiplier) > 0)) db.invest.dividendMultiplier = 1;
    if (!db.invest.dividendPayoutMode) db.invest.dividendPayoutMode = 'all';
    if (!db.invest.dividendOverrides || typeof db.invest.dividendOverrides !== 'object') db.invest.dividendOverrides = {};
    this.dividendSyncedAt = db.invest.dividendSyncedAt;
    this.dividendSource = db.invest.dividendSource;
    this.dividendFetched = liveCount != null ? Number(liveCount) : 0;
    this.persist();
    try { this.broadcast('change', { rev: null, source: 'dividend-sync', at: Date.now() }); } catch (e) {}
    return db.invest.dividendYields;
  }

  async fetchCorporateDividends(symbols, days) {
    const list = Array.from(new Set((symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean)));
    const end = new Date();
    const start = new Date(Date.now() - Math.max(30, Number(days) || 365) * 86400000);
    const out = [];
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const path = '/v1/corporate-actions?ca_types=dividend&start=' + isoDate(start) + '&end=' + isoDate(end) + '&symbols=' + encodeURIComponent(chunk.join(','));
      /* Corporate Actions lives on the market-data host, not the trading host */
      const data = await this.apiGet(path, 'data', 20000);
      const divs = (data && data.corporate_actions && data.corporate_actions.dividends) || [];
      out.push.apply(out, divs);
      if (i + 100 < list.length) await sleep(SEED_DELAY_MS);
    }
    return out;
  }

  async fetchDividendYield(ticker) {
    try {
      const divs = await this.fetchCorporateDividends([ticker], 365);
      const sum = divs.filter((d) => String(d.symbol).toUpperCase() === String(ticker).toUpperCase())
        .reduce((a, d) => a + (Number(d.rate) || 0), 0);
      const asset = this.assetList().find((a) => a.alpacaSymbol.toUpperCase() === String(ticker).toUpperCase() || a.ticker === String(ticker).toUpperCase());
      const q = asset ? this.quotes[asset.ticker] : null;
      const price = q && Number(q.rawPrice) > 0 ? Number(q.rawPrice) : Number(asset && asset.price) || 0;
      if (!(price > 0)) return null;
      return round(Math.min(100, Math.max(0, (sum / price) * 100)), 2);
    } catch (e) {
      this.lastError = 'Alpaca dividend sync failed: ' + e.message;
      return null;
    }
  }

  async syncDividends(manual, actor, nested) {
    if (this.syncingDividends) return this.dividendStatus();
    const started = Date.now();
    const who = (actor && actor.name) || (manual ? (nested ? 'admin' : 'admin') : 'scheduler');
    const whoId = (actor && actor.id) || null;
    this.syncingDividends = true;
    const db = this.getDb && this.getDb();
    const prior = (db && db.invest && db.invest.dividendYields) || {};
    const map = Object.assign({}, prior);
    let fetched = 0, failed = 0;
    this.dividendFailed = [];
    this.dividendAttempted = 0;
    try {
      const stockAssets = this.assetList().filter((a) => a.assetClass === 'us');
      this.dividendAttempted = stockAssets.length;
      if (this.configured()) {
        const symbols = stockAssets.map((a) => a.alpacaSymbol);
        try {
          const divs = await this.fetchCorporateDividends(symbols, 365);
          const bySymbol = {};
          divs.forEach((d) => {
            const sym = String(d.symbol || '').toUpperCase();
            if (!sym) return;
            bySymbol[sym] = (bySymbol[sym] || 0) + (Number(d.rate) || 0);
          });
          for (const a of stockAssets) {
            const sum = bySymbol[String(a.alpacaSymbol).toUpperCase()] || 0;
            const q = this.quotes[a.ticker];
            const raw = q && Number(q.rawPrice) > 0 ? Number(q.rawPrice) : Number(a.price) || 0;
            if (raw > 0) {
              map[a.ticker] = round(Math.min(100, Math.max(0, (sum / raw) * 100)), 2);
              fetched++;
            } else {
              failed++;
              this.dividendFailed.push(a.ticker);
            }
          }
        } catch (e) {
          failed = stockAssets.length;
          this.dividendFailed = stockAssets.map((a) => a.ticker);
          this.lastError = 'Alpaca dividend sync failed: ' + e.message;
          if (e.code === 429) await this.waitForCooldown();
        }
      }
      const source = fetched > 0 ? 'alpaca' : (this.dividendSource || 'alpaca');
      this.applyDividendMap(map, source, fetched);
      console.log('[market] dividends synced ·', source, '·', fetched + '/' + stockAssets.length, 'symbols', failed ? '· ' + failed + ' pending' : '');
      if (failed && !this.stopped) this.scheduleDividendRetry();
      if (!nested) {
        this.audit('sync.dividends', {
          category: 'sync', actor: who, actorId: whoId, target: 'Dividend data', result: failed && !fetched ? 'error' : 'ok',
          durationMs: Date.now() - started,
          summary: fetched + ' / ' + stockAssets.length + ' symbols updated' + (failed ? ' · ' + failed + ' pending' : ''),
          changes: [{ field: 'dividends', from: null, to: fetched }]
        });
      }
    } finally { this.syncingDividends = false; }
    return this.dividendStatus();
  }

  scheduleDividendRetry() {
    if (this.dividendRetryTimer) return;
    this.dividendRetryTimer = setTimeout(() => {
      this.dividendRetryTimer = null;
      if (this.stopped) return;
      this.syncDividends(true, null, false).catch((e) => { this.lastError = 'Dividend retry failed: ' + e.message; });
    }, 180000);
    if (this.dividendRetryTimer.unref) this.dividendRetryTimer.unref();
  }

  dividendStatus() {
    return {
      syncedAt: this.dividendSyncedAt || null,
      source: this.dividendSource || '',
      live: this.dividendFetched || 0,
      attempted: this.dividendAttempted || 0,
      failed: (this.dividendFailed || []).length,
      failedTickers: (this.dividendFailed || []).slice(0, 20),
      tickers: this.assetList().filter((a) => a.assetClass === 'us').length,
      syncing: this.syncingDividends
    };
  }

  async testConnection(actor) {
    if (!this.configured()) {
      this.audit('connection.test', { category: 'connection', actor: (actor && actor.name) || 'admin', actorId: (actor && actor.id) || null, target: 'Alpaca', summary: 'Connection test blocked — no API keys saved', result: 'error' });
      return { ok: false, message: 'Add your Alpaca API Key ID and Secret Key first' };
    }
    const started = Date.now();
    try {
      const snap = await this.fetchSnapshots(['AAPL']);
      const q = this.snapshotForSymbol(snap.AAPL);
      if (!q) {
        this.lastTestAt = Date.now(); this.lastTestOk = false;
        this.audit('connection.test', { category: 'connection', actor: (actor && actor.name) || 'admin', actorId: (actor && actor.id) || null, target: 'Alpaca', summary: 'Alpaca replied but returned no AAPL price', result: 'error', durationMs: Date.now() - started });
        return { ok: false, message: 'Alpaca replied but returned no AAPL price', status: this.status() };
      }
      try { await this.apiGet('/v2/account', 'trading', 8000); } catch (e) { /* data-only keys are fine */ }
      this.lastTestAt = Date.now(); this.lastTestOk = true;
      this.audit('connection.test', { category: 'connection', actor: (actor && actor.name) || 'admin', actorId: (actor && actor.id) || null, target: 'Alpaca · ' + this.config.mode + ' / ' + String(this.config.feed).toUpperCase(), summary: 'Connection OK · AAPL $' + Number(q.price).toFixed(2) + ' · ' + (Date.now() - started) + ' ms', result: 'ok', durationMs: Date.now() - started });
      return { ok: true, price: q.price, rawPrice: q.price, symbol: 'AAPL', message: 'Alpaca connection OK', status: this.status() };
    } catch (e) {
      this.lastTestAt = Date.now(); this.lastTestOk = false;
      this.audit('connection.test', { category: 'connection', actor: (actor && actor.name) || 'admin', actorId: (actor && actor.id) || null, target: 'Alpaca', summary: 'Connection failed · ' + (e.message || 'unknown error'), result: 'error', durationMs: Date.now() - started });
      return { ok: false, message: e.message || 'Alpaca connection failed', status: this.status() };
    }
  }

  async syncAll(manual, actor) {
    if (this.syncRunning) return this.status();
    const who = (actor && actor.name) || (manual ? 'admin' : 'scheduler');
    const whoId = (actor && actor.id) || null;
    if (!this.configured()) {
      this.audit('sync.failed', { category: 'sync', actor: who, actorId: whoId, target: 'Alpaca full sync', summary: 'No API keys saved', result: 'error' });
      throw new Error('Add your Alpaca API keys first');
    }
    const started = Date.now();
    this.syncRunning = true;
    this.lastSyncError = '';
    try {
      const assets = await this.syncAssets();
      await this.seedFromAlpaca();
      await this.syncDividends(manual, null, true);
      this.lastSyncAt = Date.now();
      console.log('[market] Alpaca full sync complete · assets', assets, '· prices', this.seedOk, '· dividends', this.dividendFetched);
      this.audit('sync.completed', {
        category: 'sync', actor: who, actorId: whoId, target: 'Alpaca full sync', result: 'ok',
        durationMs: Date.now() - started,
        summary: 'Assets ' + (assets && assets.tracked ? assets.tracked : this.assetList().length) + ' · prices ' + this.seedOk + ' · dividends ' + this.dividendFetched,
        changes: [{ field: 'assets', from: null, to: (assets && assets.tracked) || this.assetList().length }, { field: 'prices', from: null, to: this.seedOk }, { field: 'dividends', from: null, to: this.dividendFetched }]
      });
    } catch (e) {
      this.lastSyncError = e.message;
      this.lastError = 'Alpaca sync failed: ' + e.message;
      this.audit('sync.failed', { category: 'sync', actor: who, actorId: whoId, target: 'Alpaca full sync', summary: e.message, result: 'error', durationMs: Date.now() - started });
      throw e;
    } finally { this.syncRunning = false; }
    return this.status();
  }

  /* --------------------- admin stock table / overrides ------------------ */
  adminStockTable() {
    const db = this.getDb && this.getDb();
    const list = (db && Array.isArray(db.stocks)) ? db.stocks : [];
    return list.filter((x) => x && x.ticker).map((x) => {
      const q = this.quotes[x.ticker] || {};
      const override = Number(x.overridePct) || 0;
      const raw = Number(q.rawPrice) > 0 ? Number(q.rawPrice) : Number(x.price) || 0;
      const paused = !!(x.paused || (db.invest && db.invest.paused && db.invest.paused[x.ticker]));
      return {
        ticker: x.ticker,
        symbol: x.alpacaSymbol || x.ticker,
        name: x.name || x.ticker,
        assetClass: x.assetClass || 'us',
        rawPrice: raw > 0 ? round(raw, 4) : 0,
        overridePct: override,
        price: raw > 0 ? this.effectivePrice(raw, override) : 0,
        dividendYield: this.dividendYieldFor(db, x.ticker),
        paused,
        active: !paused,
        source: q.source || 'cached',
        updatedAt: q.updatedAt || null
      };
    }).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  saveStockSettings(updates, actor) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    db.invest = db.invest || {};
    db.invest.paused = db.invest.paused || {};
    let changed = 0;
    const changes = [];
    for (const u of (updates || [])) {
      if (!u || !u.ticker) continue;
      const stock = (db.stocks || []).find((s) => String(s.ticker).toUpperCase() === String(u.ticker).toUpperCase());
      if (!stock) continue;
      const ticker = String(stock.ticker).toUpperCase();
      if (u.overridePct != null) {
        const n = Number(u.overridePct);
        if (!Number.isFinite(n)) throw new Error('Invalid override for ' + u.ticker);
        const prev = Number(stock.overridePct) || 0;
        const next = Math.max(-90, Math.min(500, Math.round(n * 100) / 100));
        stock.overridePct = next;
        if (next !== prev) changes.push({ ticker, field: 'overridePct', from: prev, to: next });
      }
      if (u.paused != null) {
        const prevPaused = !!(stock.paused || (db.invest.paused && db.invest.paused[stock.ticker]));
        stock.paused = !!u.paused;
        db.invest.paused[stock.ticker] = !!u.paused;
        if (!!u.paused !== prevPaused) changes.push({ ticker, field: 'active', from: !prevPaused, to: !u.paused });
      }
      changed++;
    }
    this.refreshAssets();
    this.repriceAll();
    this.barsCache.clear();
    this.persist();
    if (changes.length) {
      const overrides = changes.filter((c) => c.field === 'overridePct').length;
      const toggles = changes.length - overrides;
      const summary = [overrides ? overrides + ' override' + (overrides === 1 ? '' : 's') : '', toggles ? toggles + ' active toggle' + (toggles === 1 ? '' : 's') : ''].filter(Boolean).join(' · ');
      this.audit('overrides.saved', {
        category: 'override',
        actor: (actor && actor.name) || 'admin',
        actorId: (actor && actor.id) || null,
        target: overrides ? 'Price overrides' : 'Trading status',
        summary,
        changes
      });
    }
    if (changed) {
      try { this.broadcast('change', { rev: null, source: 'market-overrides', at: Date.now() }); } catch (e) {}
    }
    return this.adminStockTable();
  }

  /* ------------------------- spot buy / sell ---------------------------- */
  spotQuote(ticker) {
    const q = this.quotes[String(ticker || '').toUpperCase()];
    return q && Number(q.price) > 0 ? q : null;
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
    if (!q) throw new Error('No live Alpaca quote for this stock yet');
    const stock = (db.stocks || []).find((s) => s.ticker === ticker);
    if ((db.invest && db.invest.paused && db.invest.paused[ticker]) || (stock && stock.paused)) throw new Error('Trading is paused for this asset');

    let qty = Number(opts.shares) || 0;
    /* USD is the primary input: USD / live effective price = shares,
       and WC cost is always USD / 0.50 (1 WC = $0.50). */
    if (!(qty > 0) && Number(opts.amountUsd) > 0) qty = Number(opts.amountUsd) / q.price;
    if (!(qty > 0) && Number(opts.amountCoins) > 0) qty = (Number(opts.amountCoins) * 0.5) / q.price;
    qty = Math.round(qty * 1e8) / 1e8;
    if (!(qty > 0)) throw new Error('Enter an investment amount or quantity');
    const costUsd = Math.round(qty * q.price * 100) / 100;
    const cost = Math.round((costUsd / 0.5) * 100) / 100;
    if (!(cost > 0)) throw new Error('Order value is too small');
    if ((Number(u.balance) || 0) < cost) throw new Error('Not enough WC — top up your wallet');

    const tp = Number(opts.tpPrice) || 0;
    const sl = Number(opts.slPrice) || 0;
    if (tp > 0 && tp <= q.price) throw new Error('Take Profit must be above the current price');
    if (sl > 0 && sl >= q.price) throw new Error('Stop Loss must be below the current price');

    let dueTime = Number(opts.dueTime) || 0;
    if (!(dueTime > 0) && Number(opts.dueMinutes) > 0) dueTime = Date.now() + Number(opts.dueMinutes) * 60000;
    if (dueTime > 0 && dueTime <= Date.now()) throw new Error('Due time must be in the future');
    if (dueTime > Date.now() + 30 * 86400000) throw new Error('Due time cannot be more than 30 days away');

    u.balance = Math.round((Number(u.balance) - cost) * 100) / 100;
    db.holdings = db.holdings || [];
    let holding = db.holdings.find((h) => h.userId === userId && h.ticker === ticker);
    if (holding) {
      const oldShares = Number(holding.shares) || 0;
      const newShares = oldShares + qty;
      holding.avgPrice = Math.round(((oldShares * (Number(holding.avgPrice) || q.price)) + qty * q.price) / newShares * 10000) / 10000;
      holding.shares = newShares;
      holding.investedCoins = Math.round(((Number(holding.investedCoins) || 0) + cost) * 100) / 100;
      holding.investedUsd = Math.round(((Number(holding.investedUsd) || ((oldShares * (Number(holding.avgPrice) || q.price)))) + costUsd) * 100) / 100;
      holding.entryPriceUsd = round(holding.avgPrice, 4);
      holding.wcRate = 0.5;
      if (tp > 0) holding.takeProfitPrice = round(tp, 4);
      if (sl > 0) holding.stopLossPrice = round(sl, 4);
      if (dueTime > 0) holding.dueTime = dueTime;
      holding.status = 'ACTIVE';
      holding.updatedAt = Date.now();
    } else {
      holding = {
        id: id('hd'), userId, ticker, shares: qty, avgPrice: round(q.price, 4),
        entryPriceUsd: round(q.price, 4), investedCoins: cost, investedUsd: costUsd, wcRate: 0.5,
        takeProfitPrice: tp > 0 ? round(tp, 4) : null,
        stopLossPrice: sl > 0 ? round(sl, 4) : null,
        dueTime: dueTime > 0 ? dueTime : null,
        status: 'ACTIVE', createdAt: Date.now(), updatedAt: Date.now()
      };
      db.holdings.push(holding);
    }
    const order = {
      id: id('tr'), userId, ticker, name: (db.stocks || []).find((s) => s.ticker === ticker)?.name || ticker,
      side: 'buy', shares: qty, priceUsd: round(q.price, 4), entryPriceUsd: round(q.price, 4),
      coins: cost, investedUsd: costUsd, wcRate: 0.5, feeCoins: 0,
      takeProfitPrice: tp > 0 ? round(tp, 4) : null, stopLossPrice: sl > 0 ? round(sl, 4) : null, dueTime: dueTime > 0 ? dueTime : null,
      type: 'market', status: 'Completed', plUsd: 0, reason: 'Market buy', createdAt: Date.now()
    };
    db.trades = db.trades || []; db.trades.unshift(order);
    db.txs = db.txs || [];
    db.txs.unshift({ id: id('tx_'), userId, type: 'stock-buy', label: `Bought ${qty} ${ticker} @ $${round(q.price, 4)}`, coins: -cost, meta: { ticker, shares: qty, priceUsd: q.price, investedUsd: costUsd, tp, sl, dueTime, spot: true }, createdAt: Date.now() });
    db.notifications = db.notifications || [];
    db.notifications.unshift({ id: id('nt_'), userId, title: 'Purchase complete', body: `Bought ${qty} ${ticker} @ $${round(q.price, 4)} · ${cost} WC`, link: '#/invest/stock/' + ticker, icon: 'trend', read: false, createdAt: Date.now() });
    this.persist();
    try { this.broadcast('change', { rev: null, source: 'spot-buy', at: Date.now() }); } catch (e) {}
    return { holding, order, cost };
  }

  sellSpotInternal(db, holding, price, reason) {
    if (!holding || !(Number(holding.shares) > 0)) return null;
    /* Atomic guard: the position must still be open in the live book. If a
       manual close and an automatic trigger land in the same instant, only the
       first call wins and the second sees the position already removed. */
    if (!Array.isArray(db.holdings) || !db.holdings.some((h) => h && h.id === holding.id)) return null;
    if (holding.closing) return null;
    holding.closing = true;
    const u = (db.users || []).find((x) => x.id === holding.userId);
    if (!u) { holding.closing = false; return null; }
    const shares = Number(holding.shares);
    const payoutUsd = Math.round(shares * Number(price) * 100) / 100;
    const payout = Math.round((payoutUsd / 0.5) * 100) / 100;
    u.balance = Math.round((Number(u.balance) + payout) * 100) / 100;
    const entryPriceUsd = Number(holding.avgPrice) || Number(price);
    const plUsd = Math.round((Number(price) - entryPriceUsd) * shares * 100) / 100;
    const plCoins = Math.round((plUsd / 0.5) * 100) / 100;
    db.holdings = (db.holdings || []).filter((h) => h.id !== holding.id);
    const order = {
      id: id('tr'), userId: holding.userId, ticker: holding.ticker, name: (db.stocks || []).find((s) => s.ticker === holding.ticker)?.name || holding.ticker,
      side: 'sell', shares, priceUsd: round(price, 4), entryPriceUsd: round(entryPriceUsd, 4), exitPriceUsd: round(price, 4),
      coins: payout, payoutUsd, plCoins, wcRate: 0.5, feeCoins: 0,
      type: 'market', status: 'Completed', plUsd, reason, createdAt: Date.now()
    };
    db.trades = db.trades || []; db.trades.unshift(order);
    db.txs = db.txs || [];
    db.txs.unshift({ id: id('tx_'), userId: u.id, type: 'stock-sell', label: `Sold ${shares} ${holding.ticker} @ $${round(price, 4)} · ${reason}`, coins: payout, meta: { ticker: holding.ticker, shares, priceUsd: price, entryPriceUsd, plUsd, plCoins, payoutUsd, spot: true, reason }, createdAt: Date.now() });
    db.notifications = db.notifications || [];
    db.notifications.unshift({ id: id('nt_'), userId: u.id, title: reason, body: `Sold ${shares} ${holding.ticker} @ $${round(price, 4)} · ${payout} WC credited (${plUsd >= 0 ? '+' : '−'}$${Math.abs(plUsd).toFixed(2)} / ${plCoins >= 0 ? '+' : '−'}${Math.abs(plCoins).toFixed(2)} WC).`, link: '#/invest/orders', icon: reason === 'Take Profit Hit' ? 'trend' : reason === 'Due time reached' ? 'clock' : 'ban', read: false, createdAt: Date.now() });
    return { order, payout, plUsd };
  }

  sellSpot(opts) {
    const db = this.getDb && this.getDb();
    if (!db) throw new Error('Database not ready');
    const holding = (db.holdings || []).find((h) => h.userId === String(opts.userId || '') && h.ticker === String(opts.ticker || '').toUpperCase());
    if (!holding) throw new Error('No open position for this asset');
    const q = this.spotQuote(holding.ticker);
    if (!q) throw new Error('No live Alpaca quote for this stock yet');
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
    if (!q) throw new Error('No live Alpaca quote for this stock yet');
    const tp = Number(opts.tpPrice) || 0;
    const sl = Number(opts.slPrice) || 0;
    const entry = Number(holding.avgPrice) || q.price;
    if (tp > 0 && tp <= entry) throw new Error('Take Profit must be above the position entry price');
    if (sl > 0 && sl >= entry) throw new Error('Stop Loss must be below the position entry price');
    holding.takeProfitPrice = tp > 0 ? round(tp, 4) : null;
    holding.stopLossPrice = sl > 0 ? round(sl, 4) : null;
    if (opts.dueTime !== undefined) {
      const due = Number(opts.dueTime) || 0;
      if (due > 0 && due <= Date.now()) throw new Error('Due time must be in the future');
      holding.dueTime = due > 0 ? due : null;
    }
    holding.updatedAt = Date.now();
    this.persist();
    try { this.broadcast('change', { rev: null, source: 'spot-tpsl', at: Date.now() }); } catch (e) {}
    return holding;
  }

  settleSpot() {
    const db = this.getDb && this.getDb();
    if (!db || !Array.isArray(db.holdings)) return 0;
    let changed = 0;
    const now = Date.now();
    for (const h of db.holdings.slice()) {
      if (!h || !(Number(h.shares) > 0)) continue;
      const tp = Number(h.takeProfitPrice) || 0;
      const sl = Number(h.stopLossPrice) || 0;
      const due = Number(h.dueTime) || 0;
      if (!tp && !sl && !due) continue;
      const q = this.quotes[h.ticker];
      if (!q || !(q.price > 0)) continue;
      let reason = '';
      if (due > 0 && now >= due) reason = 'Due time reached';
      else if (tp > 0 && q.price >= tp) reason = 'Take Profit Hit';
      else if (sl > 0 && q.price <= sl) reason = 'Stop Loss Hit';
      if (!reason) continue;
      /* due-time exits settle at the current live price, not at a synthetic price */
      if (this.sellSpotInternal(db, h, q.price, reason)) changed++;
    }
    if (changed) {
      this.persist();
      try { this.broadcast('change', { rev: null, source: 'spot-settlement', at: now }); } catch (e) {}
      console.log('[market] settled', changed, 'spot position(s) on TP/SL/due time');
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
    /* settlement runs every second so TP/SL/due-time exits pay out even offline */
    this.timers.push(setInterval(() => { try { this.settleTrades(); this.settleSpot(); } catch (e) { this.lastError = e.message; } }, 1000));
    /* REST snapshot fallback when the WebSocket is not delivering */
    this.timers.push(setInterval(() => {
      try { if (this.configured()) this.pollCycle(); } catch (e) { this.lastError = e.message; }
    }, Math.max(5000, this.config.refreshSec * 1000)));
    /* scheduled Alpaca assets / prices / dividends sync */
    if (this.config.syncEnabled) {
      const every = Math.max(5, Number(this.config.syncIntervalMin) || 60) * 60000;
      this.timers.push(setInterval(() => {
        if (!this.configured()) return;
        this.syncAll(false).catch((e) => { this.lastSyncError = e.message; });
      }, every));
      const stale = !this.lastSyncAt || Date.now() - this.lastSyncAt > every;
      if (stale && this.configured()) {
        setTimeout(() => {
          if (this.stopped || !this.configured()) return;
          this.syncAll(false).catch((e) => { this.lastSyncError = e.message; });
        }, 3000).unref?.();
      }
    }
    if (this.configured()) {
      this.connectWS();
      this.seedFromAlpaca().then(() => this.syncDividends()).catch((e) => { this.lastError = e.message; });
    }
  }

  stopTimers() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    if (this.dividendRetryTimer) { clearTimeout(this.dividendRetryTimer); this.dividendRetryTimer = null; }
  }

  start() {
    this.loadConfig();
    this.seedBaseQuotes();
    this.restart().catch((e) => { this.lastError = e.message; });
    console.log('[market] Alpaca · env:', this.config.mode, '· refresh:', this.config.refreshSec + 's', '· keys:', this.configured() ? 'set' : 'not set', '· sync:', this.config.syncEnabled ? this.config.syncIntervalMin + 'min' : 'off');
  }

  stop() {
    this.stopped = true;
    this.stopTimers();
    this.closeWS();
  }
}

module.exports = { MarketService, DEFAULT_ASSETS, assetKey, displayTickerFor, usMarketOpen, ALPACA_DATA_BASE, ALPACA_WS_URL };
