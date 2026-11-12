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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TICKERS = ['AAPL', 'TSLA', 'NVDA', 'COIN', 'MSTR', 'MARA', 'KO', 'JPM', 'NKE', 'UNH', 'AVGO', 'WMT', 'DIS', 'V', 'UBER', 'AMZN'];

const BASE_PRICES = {
  AAPL: 231.42, TSLA: 352.41, NVDA: 141.28, COIN: 298.41, MSTR: 412.88, MARA: 21.64,
  KO: 63.21, JPM: 242.61, NKE: 78.42, UNH: 562.31, AVGO: 172.44, WMT: 89.64,
  DIS: 112.44, V: 309.51, UBER: 74.21, AMZN: 206.74
};

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
    this.timers = [];
    this.settleLock = false;
  }

  /* ------------------------------- config ------------------------------- */
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
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      try { fs.chmodSync(this.configFile, 0o600); } catch (e) {}
    } catch (e) { this.lastError = 'Could not save market config: ' + e.message; }
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
  seedBaseQuotes() {
    const now = Date.now();
    TICKERS.forEach((t) => {
      if (this.quotes[t]) return;
      const price = BASE_PRICES[t] || 100;
      this.quotes[t] = {
        ticker: t, price, prevClose: price, open: price,
        dayHigh: price, dayLow: price,
        changePct: 0, changeUsd: 0, vol: 1000000,
        dir: 0, updatedAt: now, source: 'simulated', real: false
      };
      this.recordHistory(t, price, now, 'simulated', false);
    });
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
    try { this.settleTrades(); } catch (e) { this.lastError = e.message; }
  }

  /* smooth micro ticks anchored on the last real Finnhub price */
  simTick() {
    const now = Date.now();
    TICKERS.forEach((t) => {
      const q = this.quotes[t];
      if (!q) return;
      if (q.real && now - q.updatedAt < 5000) return;          // a fresh real tick wins
      const anchor = this.lastReal[t] || q.price;
      const drift = (anchor - q.price) * 0.015;                 // gently pull back to the real close
      const vol = Math.max(0.0004, Math.min(0.0022, 0.00055 + Math.abs(anchor) / 500000));
      const shock = (Math.random() - 0.5) * 2 * vol;
      let next = q.price * (1 + shock) + drift * q.price;
      if (!Number.isFinite(next) || next <= 0) next = q.price;
      this.writeQuote(t, next, { prevClose: q.prevClose, open: q.open, vol: q.vol + Math.floor(Math.random() * 9000), source: 'simulated', real: false });
    });
    this.settleTrades();
  }

  /* --------------------------- Finnhub REST ----------------------------- */
  getJSON(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
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
    const url = 'https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(ticker) + '&token=' + encodeURIComponent(key);
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
      for (const t of TICKERS) {
        if (this.stopped) break;
        if (Date.now() < this.rateLimitedUntil) break;
        const q = await this.fetchQuote(t);
        if (q) {
          this.writeQuote(t, q.price, { prevClose: q.prevClose, open: q.open, dayHigh: q.dayHigh, dayLow: q.dayLow, vol: this.quotes[t] ? this.quotes[t].vol : 1000000, source: 'live', real: true });
        }
        await sleep(1200);                                     // < 60 requests / minute
      }
      this.lastError = '';
      console.log('[market] Finnhub seed complete ·', TICKERS.length, 'tickers ·', usMarketOpen() ? 'market open' : 'market closed (using last close)');
    } finally {
      this.seeding = false;
    }
  }

  async pollCycle() {
    if (this.polling || !this.config.apiKey || !usMarketOpen()) return;
    if (Date.now() < this.rateLimitedUntil) return;
    this.polling = true;
    try {
      for (const t of TICKERS) {
        const wsFresh = this.wsConnected && this.lastWsTickAt && Date.now() - this.lastWsTickAt < 45000;
        if (this.stopped || !usMarketOpen() || wsFresh) break;
        const q = this.quotes[t];
        const realAt = this.lastRealTime[t] || 0;
        const stale = !q || !realAt || Date.now() - realAt > Math.max(30000, this.config.refreshSec * 2000);
        if (stale) {
          const fresh = await this.fetchQuote(t);
          if (fresh) this.writeQuote(t, fresh.price, { prevClose: fresh.prevClose, open: fresh.open, dayHigh: fresh.dayHigh, dayLow: fresh.dayLow, vol: q ? q.vol : 1000000, source: 'live', real: true });
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

  connectWS() {
    if (this.stopped || this.config.mode !== 'hybrid' || !this.config.apiKey) return;
    const WS = this.wsClass();
    if (!WS) {
      this.lastError = 'WebSocket client unavailable — REST polling + simulation active';
      return;
    }
    this.closeWS();
    const url = 'wss://ws.finnhub.io?token=' + encodeURIComponent(this.config.apiKey);
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
      TICKERS.forEach((t) => {
        try { ws.send(JSON.stringify({ type: 'subscribe', symbol: t })); } catch (e) {}
      });
      console.log('[market] Finnhub WebSocket connected ·', TICKERS.length, 'subscriptions');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
      if (!msg || msg.type !== 'trade' || !Array.isArray(msg.data)) return;
      const touched = new Set();
      msg.data.forEach((tr) => {
        const t = String(tr.s || '').toUpperCase();
        if (!this.quotes[t] || !(Number(tr.p) > 0)) return;
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

  /* ------------------------- fallback decisions ------------------------- */
  fallbackReason() {
    if (this.config.mode !== 'hybrid' || !this.config.apiKey) return 'simulated';
    if (!usMarketOpen()) return 'closed';
    if (Date.now() < this.rateLimitedUntil) return 'rate-limit';
    const staleWs = !this.wsConnected || (this.lastWsTickAt && Date.now() - this.lastWsTickAt > Math.max(45000, this.config.refreshSec * 3000));
    const anyReal = TICKERS.some((t) => !!this.lastReal[t]);
    if (!anyReal && !this.seeding) return 'no-live-data';
    if (staleWs) return 'no-ws-ticks';
    return '';
  }

  notice() {
    const why = this.fallbackReason();
    if (!why) return 'Live market data via Finnhub';
    if (this.config.mode !== 'hybrid' || !this.config.apiKey) return 'Simulated market data · 24/7 OTC mode';
    return '24/7 OTC market mode active (based on last real close)';
  }

  source() {
    return this.fallbackReason() ? 'simulated' : 'live';
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
      lastTickAt: this.lastTickAt || null,
      lastWsTickAt: this.lastWsTickAt || null,
      rateLimitedUntil: this.rateLimitedUntil > Date.now() ? this.rateLimitedUntil : null,
      lastError: this.lastError || '',
      tickers: TICKERS.length,
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

  /* --------------------------- settlement ------------------------------- */
  settleTrades() {
    if (this.settleLock) return 0;
    const db = this.getDb && this.getDb();
    if (!db || !Array.isArray(db.trades)) return 0;
    this.settleLock = true;
    let changed = 0;
    try {
      const now = Date.now();
      for (const t of db.trades) {
        if (!t || t.type !== 'live' || t.status !== 'Open') continue;
        const q = this.quotes[t.ticker];
        if (!q || !(Number(t.entryPrice) > 0)) continue;
        const lev = Math.max(1, Math.min(20, Number(t.leverage) || 1));
        const direction = t.direction || (t.side === 'short' ? 'FALL' : 'RISE');
        const dir = direction === 'FALL' ? -1 : 1;
        const tpPrice = Number(t.takeProfitPrice) || 0;
        const slPrice = Number(t.stopLossPrice) || 0;
        let reason = '';
        if (direction === 'RISE') {
          if (tpPrice > 0 && q.price >= tpPrice) reason = 'Take Profit Hit';
          else if (slPrice > 0 && q.price <= slPrice) reason = 'Stop Loss Hit';
        } else {
          if (tpPrice > 0 && q.price <= tpPrice) reason = 'Take Profit Hit';
          else if (slPrice > 0 && q.price >= slPrice) reason = 'Stop Loss Hit';
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
        if (reason === 'Take Profit Hit' || reason === 'Stop Loss Hit') {
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
    this.seedBaseQuotes();
    const simMs = Math.max(2000, Math.min(5000, Math.round(this.config.refreshSec * 1000 / 3)));
    this.timers.push(setInterval(() => { try { this.simTick(); } catch (e) { this.lastError = e.message; } }, simMs));
    this.timers.push(setInterval(() => {
      try {
        if (this.config.mode === 'hybrid' && this.config.apiKey && usMarketOpen()) this.pollCycle();
      } catch (e) { this.lastError = e.message; }
    }, Math.max(5000, this.config.refreshSec * 1000)));
    if (this.config.mode === 'hybrid' && this.config.apiKey) {
      await this.seedFromFinnhub();
      this.connectWS();
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

module.exports = { MarketService, TICKERS, usMarketOpen };
