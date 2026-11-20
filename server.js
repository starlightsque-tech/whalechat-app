#!/usr/bin/env node
/* WhaleChat sync server — zero hard dependencies (web-push optional). Node 18+ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 48);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'support@whalechat.app';
const MAX_BODY = 30 * 1024 * 1024;
const STARTED = Date.now();
const DATABASE_URL = process.env.DATABASE_URL || '';
let email = null;
try { email = require('./email'); } catch (e) { console.error('[email] module unavailable:', e.message); }
const { MarketService, DEFAULT_ASSETS, assetKey, displayTickerFor } = require('./market');
const marketCatalog = require('./market-catalog');
const { SpotService } = require('./spot');
const { BotService } = require('./bots');
const { ShareService } = require('./shares');
const adminAuth = require('./admin-auth');
/* 3.57: durable Appwrite mirror for the database + uploaded app files */
let appwrite = null;
try { appwrite = require('./appwrite'); } catch (e) { console.error('[appwrite] module unavailable:', e.message); }
const { createMarketAdmin } = require('./market-admin');
let createConnections = null;
try { createConnections = require('./connections').createConnections; } catch (e) { console.error('[connections] module unavailable:', e.message); }
let createBinanceFeed = null;
try { createBinanceFeed = require('./binance').createBinanceFeed; } catch (e) { console.error('[binance] module unavailable:', e.message); }
let createTwelveDataFeed = null;
try { createTwelveDataFeed = require('./twelvedata').createTwelveDataFeed; } catch (e) { console.error('[twelvedata] module unavailable:', e.message); }
let createB2BAlertWatcher = null;
try { createB2BAlertWatcher = require('./b2b-alerts').createB2BAlertWatcher; } catch (e) { console.error('[b2b-alerts] module unavailable:', e.message); }
const market = new MarketService({
  dataDir: DATA_DIR,
  getDb: () => store.db,
  persist: () => persistNow(),
  broadcast: (event, data) => { try { broadcast(event, data); } catch (e) {} }
});
const spot = new SpotService({
  getDb: () => store.db,
  persist: () => persist(),
  broadcast: (event, data) => { try { broadcast(event, data); } catch (e) {} },
  getQuote: (ticker) => market.quotes[String(ticker || '').toUpperCase()] || null
});
const bots = new BotService({
  getDb: () => store.db,
  persist: () => persist(),
  broadcast: (event, data) => { try { broadcast(event, data); } catch (e) {} },
  getQuote: (ticker) => market.quotes[String(ticker || '').toUpperCase()] || null,
  market
});
const shares = new ShareService({
  getDb: () => store.db,
  persist: () => persist(),
  broadcast: (event, data) => { try { broadcast(event, data); } catch (e) {} }
});

/* 3.64: configured servers (Appwrite nyc, Telesign, Brevo, market feeds).
   Secrets stay in the environment; only public ids reach the browser. */
const serverConfig = require('./server-config');
/* 3.71: hosted WebSocket provider (Pusher Channels / Ably) for chat delivery.
   Unconfigured here means the lane stays on this server's SSE stream. */
const realtime = require('./realtime');
/* 3.77 · unified SMS/OTP: Brevo transactional SMS, Telesign as fallback */
let telesign = null;
try { telesign = require('./sms'); } catch (e) { console.error('[sms] module unavailable:', e.message); }
let appwriteOrders = null;
try { appwriteOrders = require('./appwrite-orders'); } catch (e) { console.error('[appwrite-orders] module unavailable:', e.message); }
const { createReconciler } = require('./offline-orders');
function notifyUser(userId, title, body, icon, link) {
  try {
    if (!store.db) return;
    const now = Date.now();
    const id = 'nt_' + now.toString(36) + Math.random().toString(36).slice(2, 7);
    (store.db.notifications = store.db.notifications || []).unshift({ id, userId, title, body, link: link || '#/investment', icon: icon || 'trend', read: false, createdAt: now });
    store.rev += 1; store.updatedAt = now; persist();
    broadcast('change', { rev: store.rev, source: 'offline-sync', at: now });
  } catch (e) {}
}
const reconciler = createReconciler({
  getDb: () => store.db,
  persist: () => persistNow(),
  quoteFor: (ticker) => market.quotes[String(ticker || '').toUpperCase()] || null,
  appwrite: appwriteOrders,
  mail: email,
  notify: notifyUser,
  appUrl: PUBLIC_URL || 'https://whalechat.appwrite.network',
  tolerancePct: serverConfig.DEFAULTS.reconciliation.tolerancePct
});
/* Binance live crypto prices alongside Finnhub (charts stay on Finnhub). */
const binance = createBinanceFeed ? createBinanceFeed({
  getDb: () => store.db,
  everyMs: Number(process.env.BINANCE_MS || 15000),
  /* every crypto row owned by the Binance catalogue is streamed (30 pairs) */
  getSymbols: () => {
    try {
      return market.assetList()
        .filter((a) => !a.hidden && a.provider === 'binance')
        .map((a) => String(a.ticker).toUpperCase());
    } catch (e) { return []; }
  },
  onTick: (sym, price, meta) => { try { market.ingestExternal(sym, price, meta); } catch (e) {} }
}) : null;

/* Twelve Data runs next to Finnhub (stocks/forex) and Binance (crypto), so the
   app always shows the freshest real price from any of the three feeds. */
const twelvedata = createTwelveDataFeed ? createTwelveDataFeed({
  getDb: () => store.db,
  /* a key saved in Admin > Market Controls (encrypted in Postgres) is read here
     too, so either admin card works */
  getApiKey: () => { try { return marketAdmin.keyFor('twelvedata').apiKey; } catch (e) { return ''; } },
  everyMs: Number(process.env.TWELVEDATA_MS || 65000),
  /* 6 symbols per 65 s keeps a free key (8 credits/min) clear of 429s even
     when the admin presses Test Twelve Data in the same minute */
  batch: Number(process.env.TWELVEDATA_BATCH || 6),
  /* Real listed stocks from BOTH stock catalogues. Finnhub keeps its websocket
     and Twelve Data polls the same symbols as a second real source, so a stock
     still has a live price when only one of the two providers answers. The B2B
     marketplace symbols are flagged `hot` and refreshed on every cycle. */
  getTargets: () => {
    try {
      const HOT = ['TSLA', 'MSFT', 'GOOGL', 'AMZN', 'AAPL', 'SHOP', 'SSNLF', 'NVDA', 'META', 'AMD'];
      return market.assetList()
        .filter((a) => !a.hidden && !a.synthetic && a.assetClass === 'us' && (a.provider === 'twelvedata' || a.provider === 'finnhub'))
        .map((a) => ({
          ticker: a.ticker,
          symbol: a.finnhubSymbol || a.ticker,
          kind: a.assetClass,
          hot: HOT.indexOf(String(a.ticker).toUpperCase()) >= 0
        }))
        .sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0));
    } catch (e) { return []; }
  },
  onTick: (ticker, price, row) => {
    try {
      market.ingestExternal(ticker, price, row ? {
        prevClose: Number(row.previous_close) || Number(row.close) || price,
        open: Number(row.open) || price,
        dayHigh: Number(row.high) || price,
        dayLow: Number(row.low) || price,
        vol: Number(row.volume) || 0
      } : null);
    } catch (e) {}
  }
}) : null;

/* Durable third-party connection settings (Finnhub, Binance, Brevo, SMTP).
   Applied on every boot so a new release never comes up disconnected. */
let createMarketData = null;
try { createMarketData = require('./market-data').createMarketData; } catch (e) { console.error('[market-data] module unavailable:', e.message); }
const connections = createConnections ? createConnections({
  getDb: () => store.db,
  persist: () => persist(),
  dataDir: DATA_DIR,
  market, email, binance, twelvedata,
  log: (m) => console.log(m),
  storageBackend: () => (pool ? 'postgres' : 'file')
}) : null;
const marketData = (createMarketData && connections) ? createMarketData({ connections, log: (m) => console.log(m) }) : null;

/* B2B price alerts: evaluate on the server so email + in-app notification are
   delivered even when the user's app is closed. */
const b2bAlerts = createB2BAlertWatcher ? createB2BAlertWatcher({
  getDb: () => store.db,
  persist: () => persist(),
  broadcast: (event, data) => { try { broadcast(event, data); } catch (e) {} },
  quotes: () => market.quotes || {},
  email,
  appUrl: () => PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT),
  /* home-screen push for buy/sell targets and every Auto Buy/Sell fill */
  push: (userId, payload) => { try { sendPush(userId, payload).catch(() => {}); } catch (e) {} },
  everyMs: Number(process.env.B2B_ALERT_MS || 15000),
  /* Auto Buy/Sell checks every live price tick so a buy/sell target is never skipped */
  onQuote: (fn) => { try { if (market && typeof market.onQuote === 'function') market.onQuote(fn); } catch (e) {} }
}) : null;

let pool = null;
const BUILD = process.env.APP_BUILD || new Date().toISOString();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const store = { rev: 0, db: null, updatedAt: 0, loadedFrom: 'empty' };
/* provider config, tradable symbols, trading controls, admin_logs and the
   provider-only price cache (market-admin.js, db/migrations/001_market_admin.sql) */
const marketAdmin = createMarketAdmin({
  log: (m) => console.log(m),
  legacyKeys: () => {
    try {
      const s = (connections && connections.stored && connections.stored()) || {};
      const m = s.marketData || {};
      return {
        binance: { apiKey: (s.binance || {}).apiKey || '', secret: (m.binance || {}).secret || '' },
        finnhub: { apiKey: (s.finnhub || {}).apiKey || '' },
        twelvedata: { apiKey: (s.twelvedata || {}).apiKey || (m.twelvedata || {}).apiKey || '' }
      };
    } catch (e) { return {}; }
  }
});
const clients = new Set();
/* live price stream: every 400 ms push only the quotes that changed */
const marketClients = new Set();
let marketStreamSince = Date.now();
let marketStatusAt = 0;
setInterval(() => {
  const now = Date.now();
  const since = marketStreamSince;
  marketStreamSince = now;
  if (!marketClients.size) return;
  try {
    const qs = market.quotes || {};
    const delta = {};
    let n = 0;
    for (const k in qs) { const q = qs[k]; if (q && Number(q.updatedAt) >= since) { delta[k] = q; n++; } }
    let frame = '';
    if (n) frame += `event: quotes\ndata: ${JSON.stringify({ at: now, quotes: delta })}\n\n`;
    if (now - marketStatusAt > 5000) {
      marketStatusAt = now;
      frame += `event: status\ndata: ${JSON.stringify({ at: now, source: market.source(), notice: market.notice(), status: market.status() })}\n\n`;
    }
    if (frame) for (const r of marketClients) { try { r.write(frame); } catch (e) {} }
  } catch (e) {}
}, 100).unref();

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
function writeJSONAtomic(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
function snapshotList() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter(f => /^state-\d+\.json$/.test(f)).sort()
      .map(f => ({ file: f, path: path.join(BACKUP_DIR, f), at: Number(f.match(/\d+/)[0]) }));
  } catch (e) { return []; }
}
function snapshot(tag) {
  if (!store.db) return null;
  const at = Date.now();
  const file = path.join(BACKUP_DIR, `state-${at}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ at, tag: tag || 'auto', rev: store.rev, db: store.db }));
    const list = snapshotList();
    for (const old of list.slice(0, Math.max(0, list.length - BACKUP_KEEP))) { try { fs.unlinkSync(old.path); } catch (e) {} }
    return { file: path.basename(file), at };
  } catch (e) { console.error('[backup] failed:', e.message); return null; }
}
function loadState() {
  const direct = readJSON(STATE_FILE, null);
  if (direct && direct.db) {
    store.rev = direct.rev || 0; store.db = direct.db; store.updatedAt = direct.updatedAt || 0; store.loadedFrom = 'state.json'; return;
  }
  const list = snapshotList();
  if (list.length) {
    const newest = readJSON(list[list.length - 1].path, null);
    if (newest && newest.db) {
      store.rev = newest.rev || 0; store.db = newest.db; store.updatedAt = newest.at || 0;
      store.loadedFrom = 'backup:' + list[list.length - 1].file;
      console.log('[db] state.json missing — restored newest snapshot'); persistNow(); return;
    }
  }
}
let persistTimer = null;
function persist() { if (persistTimer) return; persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 250); }
function persistNow() {
  if (!store.db) return;
  try { writeJSONAtomic(STATE_FILE, { rev: store.rev, updatedAt: store.updatedAt, db: store.db }); }
  catch (e) { console.error('[db] write failed:', e.message); }
  pgPersist();
  /* mirror to Appwrite without blocking the request path */
  try { if (appwrite) appwrite.schedule(store); } catch (e) {}
}
/* Durable storage: optional Postgres (DATABASE_URL) so a redeploy can never
   wipe accounts. The file stays as a fast cache and local backup. */
function pgPersist() {
  if (!pool || !store.db) return;
  const payload = JSON.stringify(store.db);
  const rev = store.rev;
  pool.query('insert into whalechat_state (id, rev, updated_at, db) values (1,$1,now(),$2::jsonb) on conflict (id) do update set rev=excluded.rev, updated_at=now(), db=excluded.db', [rev, payload])
    .then(() => { pgState.lastWriteAt = Date.now(); })
    .catch(e => {
      console.error('[db] postgres write failed:', e.message);
      pgState.lastError = e.message;
      /* a dead connection must not silently swallow every later write */
      if (isConnError(e)) { dropPool(); schedulePgRetry(); }
    });
}
function ensureTradingAssets() {
  const db = store.db;
  if (!db) return false;
  if (!Array.isArray(db.stocks)) db.stocks = [];
  let changed = false;
  db.stocks.forEach((s) => {
    if (!s || !s.ticker) return;
    if (!s.assetClass) { s.assetClass = 'us'; changed = true; }
    if (!s.finnhubSymbol) { s.finnhubSymbol = String(s.ticker).toUpperCase(); changed = true; }
    if (!s.displayTicker) { s.displayTicker = String(s.ticker).toUpperCase(); changed = true; }
    if (!s.exchange) { s.exchange = s.assetClass === 'forex' ? 'OANDA' : s.assetClass === 'crypto' ? 'Binance' : 'US'; changed = true; }
    if (!s.currency) { s.currency = s.assetClass === 'crypto' ? 'USDT' : 'USD'; changed = true; }
  });
  /* Provider-owned catalogues: every listed row carries a `provider` so the
     Binance, Finnhub and Twelve Data feeds only serve their own, disjoint set. */
  const catBy = marketCatalog.byTicker;
  db.stocks.forEach((s) => {
    if (!s || !s.ticker) return;
    const t = String(s.ticker).toUpperCase();
    const row = catBy.get(t);
    if (row) {
      if (s.provider !== row.provider) { s.provider = row.provider; changed = true; }
      if (s.synthetic) { s.synthetic = false; changed = true; }
      if (!s.sector) { s.sector = row.sector; changed = true; }
      if (!s.exchange) { s.exchange = row.exchange; changed = true; }
      if (!s.currency) { s.currency = row.currency; changed = true; }
      if (!s.color) { s.color = row.color; changed = true; }
      if (!s.displayTicker) { s.displayTicker = row.displayTicker; changed = true; }
      /* repair a fallback/hash price left far away from the real level */
      const base = Number(row.price) || 0;
      const cur = Number(s.price) || 0;
      if (base > 0 && (!(cur > 0) || cur / base > 5 || cur / base < 0.2)) {
        s.price = base; s.prevClose = base; changed = true;
      }
    } else if (!s.provider) {
      s.provider = (s.assetClass === 'crypto' || /^BINANCE:/.test(String(s.finnhubSymbol || ''))) ? 'binance' : 'finnhub';
      changed = true;
    }
  });
  marketCatalog.rows.forEach((row) => {
    if (db.stocks.some((s) => String(s.ticker).toUpperCase() === row.ticker)) return;
    db.stocks.push(Object.assign({
      id: 'st_' + row.ticker.toLowerCase().replace(/[^a-z0-9]/g, ''),
      price: 0, prevClose: 0, div: 0, paused: false, custom: false, createdAt: Date.now()
    }, row));
    changed = true;
  });

  /* The WhaleChat company stock is a real, continuously counting symbol.
     Its price is driven by the whale-share market (see bridgeCompanyStock). */
  if (!db.stocks.some((s) => String(s.ticker).toUpperCase() === 'WC')) {
    db.stocks.push({
      id: 'st_wc', ticker: 'WC', displayTicker: 'WC', finnhubSymbol: 'WC',
      assetClass: 'us', name: 'WhaleChat (WC)', exchange: 'WhaleChat', currency: 'USD',
      color: '#2ee6c9', sector: 'Company', price: 12.5, prevClose: 12.5, div: 0,
      paused: false, custom: false, synthetic: true, twentyFourSeven: true, createdAt: Date.now()
    });
    changed = true;
  }
  DEFAULT_ASSETS.forEach((a) => {
    if (!db.stocks.some((s) => String(s.ticker).toUpperCase() === String(a.ticker).toUpperCase())) {
      db.stocks.push(Object.assign({ id: 'st_' + String(a.ticker).toLowerCase().replace(/[^a-z0-9]/g, ''), price: 0, prevClose: 0, div: 0, paused: false, custom: false, createdAt: Date.now() }, a));
      changed = true;
    }
  });
  if (changed) {
    store.rev += 1; store.updatedAt = Date.now(); persistNow();
    try { broadcast('change', { rev: store.rev, source: 'asset-migration', at: store.updatedAt }); } catch (e) {}
    console.log('[market] asset catalogue migrated ·', db.stocks.length, 'assets');
  }
  return changed;
}

/* Durable market-feed config: the Finnhub key lives in Postgres (not in the
   synced app state), so a redeploy cannot silently drop Hybrid mode. */
async function ensureMarketConfigTable() {
  if (!pool) return;
  await pool.query('create table if not exists whalechat_market_config (id int primary key, config jsonb not null, updated_at timestamptz not null default now())');
}
async function loadMarketConfig() {
  if (!pool) return null;
  try {
    await ensureMarketConfigTable();
    const r = await pool.query('select config from whalechat_market_config where id = 1');
    return r.rows[0] ? r.rows[0].config : null;
  } catch (e) { console.error('[market] durable config read failed:', e.message); return null; }
}
async function saveMarketConfig(cfg) {
  if (!pool) return false;
  try {
    await ensureMarketConfigTable();
    await pool.query('insert into whalechat_market_config (id, config, updated_at) values (1,$1::jsonb,now()) on conflict (id) do update set config=excluded.config, updated_at=now()', [JSON.stringify(cfg)]);
    return true;
  } catch (e) { console.error('[market] durable config write failed:', e.message); return false; }
}

/* -------------------------------------------------------------------------
   Durable storage: Postgres (DATABASE_URL) is the source of truth, the file is
   a fast cache and an offline copy.

   Supabase free projects are paused after 7 days without activity, and a cold
   (or just-resumed) project can refuse or time out the first connections. The
   rules below keep chat sync and price alerts alive through that:

     · connect failures never disable durability permanently — we retry with
       backoff (5s → 60s) for as long as the process lives
     · a failed WRITE drops the dead pool and reconnects instead of silently
       losing writes
     · on every (re)connect the rev numbers are compared: the newer side wins,
       so resuming a paused project adopts its state instead of clobbering it,
       and a reconnect pushes the state built while the database was away
     · a 5-minute heartbeat write keeps the project from going idle
   ------------------------------------------------------------------------- */
let pgRetryTimer = null;
let pgRetryDelay = 5000;
const pgState = {
  connected: false,
  lastError: '',
  lastConnectAt: 0,
  attempts: 0,
  lastWriteAt: 0,
  lastAdopt: null
};

function isConnError(e) {
  const code = String((e && e.code) || '');
  if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|57P01|57P02|57P03|08000|08001|08003|08004|08006|53300|3D000)$/.test(code)) return true;
  return /terminat|timeout|timed out|closed|socket|connect|not available/i.test(String((e && e.message) || ''));
}

function schedulePgRetry() {
  if (!DATABASE_URL || pgRetryTimer) return;
  const wait = pgRetryDelay;
  pgRetryTimer = setTimeout(() => { pgRetryTimer = null; connectPostgres().catch(() => {}); }, wait);
  if (pgRetryTimer.unref) pgRetryTimer.unref();
  pgRetryDelay = Math.min(Math.round(pgRetryDelay * 1.8), 60000);
}

function dropPool() {
  const p = pool;
  pool = null;
  pgState.connected = false;
  try { if (p) p.end().catch(() => {}); } catch (e) {}
}

async function reconcileState() {
  const r = await pool.query('select rev, db, updated_at from whalechat_state where id = 1');
  const row = r.rows[0];
  if (!row || !row.db) {
    if (store.db) { pgState.lastAdopt = 'local-seed'; pgPersist(); console.log('[db] seeded Postgres from device state · rev', store.rev); }
    return;
  }
  const remoteRev = Number(row.rev) || 0;
  const localRev = Number(store.rev) || 0;
  if (remoteRev > localRev) {
    store.rev = remoteRev;
    store.db = row.db;
    store.updatedAt = new Date(row.updated_at).getTime() || Date.now();
    store.loadedFrom = 'postgres';
    pgState.lastAdopt = 'remote';
    try { writeJSONAtomic(STATE_FILE, { rev: store.rev, updatedAt: store.updatedAt, db: store.db }); } catch (e) {}
    try { ensureTradingAssets(); } catch (e) {}
    try { broadcast('change', { rev: store.rev, source: 'postgres-reconnect', at: store.updatedAt }); } catch (e) {}
    console.log('[db] adopted newer Postgres state · rev', store.rev);
    return;
  }
  if (store.db && localRev >= remoteRev) {
    pgState.lastAdopt = 'local';
    pgPersist();
    console.log('[db] pushed device state to Postgres · rev', store.rev);
    return;
  }
  if (store.db === null) {
    store.rev = remoteRev;
    store.db = row.db;
    store.loadedFrom = 'postgres';
    pgState.lastAdopt = 'remote';
    console.log('[db] loaded from Postgres · rev', store.rev);
  }
}

async function connectPostgres() {
  if (!DATABASE_URL) return false;
  pgState.attempts++;
  try {
    const { Pool } = require('pg');
    /* Managed Postgres (Supabase, Neon, Render) requires TLS. node-postgres lets
       an `sslmode=` in the URL win over the ssl options we pass here, which
       re-enables certificate verification and fails on their CA chain
       ("self-signed certificate in certificate chain"). Strip the parameter and
       set the policy explicitly instead. */
    const needsSsl = /sslmode=require|sslmode=no-verify/i.test(DATABASE_URL)
      || /\.render\.com/i.test(DATABASE_URL)
      || /supabase\.(co|com)/i.test(DATABASE_URL);
    const connStr = needsSsl
      ? DATABASE_URL.replace(/([?&])sslmode=[^&]*/i, '$1').replace(/[?&]$/, '')
      : DATABASE_URL;
    if (!pool) {
      pool = new Pool({
        connectionString: connStr,
        max: 4,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: 15000,
        idleTimeoutMillis: 30000,
        keepAlive: true
      });
      pool.on('error', (e) => {
        console.error('[db] idle client error:', e.message);
        if (isConnError(e)) { dropPool(); schedulePgRetry(); }
      });
    }
    await pool.query('create table if not exists whalechat_state (id int primary key, rev int not null default 0, updated_at timestamptz not null default now(), db jsonb)');
    await pool.query('create table if not exists whalechat_heartbeat (id int primary key, at timestamptz not null default now(), note text)');
    await pool.query("insert into whalechat_heartbeat (id, at, note) values (1, now(), 'connect') on conflict (id) do update set at = now(), note = 'connect'");
    pgState.connected = true;
    pgState.lastError = '';
    pgState.lastConnectAt = Date.now();
    pgRetryDelay = 5000;
    console.log('[db] postgres connected · durable storage active');
    await reconcileState();
    return true;
  } catch (e) {
    pgState.connected = false;
    pgState.lastError = e.message;
    console.error('[db] postgres unavailable (attempt ' + pgState.attempts + '): ' + e.message + ' — retrying in ' + Math.round(pgRetryDelay / 1000) + 's; chat sync and alerts continue on the device state');
    dropPool();
    schedulePgRetry();
    return false;
  }
}

/* -------------------------------------------------------------------------
   Durable market tick ring-buffer (Postgres)

   The in-memory history is a 3000-point ring buffer per symbol. Without this
   table a redeploy started with an empty ring buffer and the candle chart had
   to rebuild itself from the first ticks of the new process. Every recorded
   point is now inserted into whalechat_market_ticks and the ring buffer is
   hydrated from it before the feeds start, so /api/market/history always has
   the full series after a restart.
   ------------------------------------------------------------------------- */
const TICK_RETENTION_MS = Number(process.env.MARKET_TICK_RETENTION_MS || 14 * 24 * 60 * 60 * 1000);
const TICK_KEEP_PER_SYMBOL = 3000;
let tickQueue = [];
let tickTableReady = false;
let tickFlushAt = 0;

async function ensureMarketTicksTable() {
  if (!pool) return false;
  if (tickTableReady) return true;
  await pool.query('create table if not exists whalechat_market_ticks (ticker text not null, t bigint not null, p numeric not null, is_real boolean not null default false, source text, primary key (ticker, t))');
  await pool.query('create index if not exists whalechat_market_ticks_t_idx on whalechat_market_ticks (t)');
  tickTableReady = true;
  return true;
}

async function loadMarketTicks() {
  if (!pool) return 0;
  try {
    await ensureMarketTicksTable();
    const cutoff = Date.now() - TICK_RETENTION_MS;
    const r = await pool.query(
      'select ticker, t, p, is_real, source from whalechat_market_ticks where t >= $1 order by ticker asc, t asc',
      [cutoff]
    );
    const byTicker = {};
    for (const row of r.rows) {
      const t = String(row.ticker || '').toUpperCase();
      if (!t) continue;
      const arr = byTicker[t] || (byTicker[t] = []);
      arr.push({ t: Number(row.t), p: Number(row.p), real: !!row.is_real, source: row.source || 'restored' });
      if (arr.length > TICK_KEEP_PER_SYMBOL) arr.splice(0, arr.length - TICK_KEEP_PER_SYMBOL);
    }
    const n = market.hydrateHistory(byTicker);
    if (n) console.log('[market] durable tick store · ' + r.rows.length + ' ticks restored across ' + n + ' symbols');
    return n;
  } catch (e) {
    console.error('[market] durable tick read failed:', e.message);
    return 0;
  }
}

const lastDurableTick = new Map();
function queueMarketTick(ticker, rec) {
  if (!pool || !rec) return;
  const tk = String(ticker).toUpperCase();
  const at = Number(rec.t) || Date.now();
  /* the chart only needs one durable point per 5 s; throttling keeps the
     table small on a free Postgres plan while preserving the full series */
  if (at - (lastDurableTick.get(tk) || 0) < 5000) return;
  lastDurableTick.set(tk, at);
  tickQueue.push([tk, at, Number(rec.p) || 0, !!rec.real, rec.source || 'live']);
  if (tickQueue.length > 20000) tickQueue.splice(0, tickQueue.length - 12000);
}

async function flushMarketTicks(force) {
  if (!pool || !tickQueue.length) return 0;
  const now = Date.now();
  if (!force && now - tickFlushAt < 5000) return 0;
  tickFlushAt = now;
  const batch = tickQueue;
  tickQueue = [];
  const seen = new Set();
  const rows = [];
  for (const r of batch) {
    if (!(r[2] > 0)) continue;
    const key = r[0] + '|' + r[1];
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
  if (!rows.length) return 0;
  try {
    await ensureMarketTicksTable();
    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400);
      const values = [];
      const params = [];
      chunk.forEach((r, j) => {
        const b = j * 5;
        values.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ')');
        params.push(r[0], r[1], r[2], r[3], r[4]);
      });
      await pool.query(
        'insert into whalechat_market_ticks (ticker, t, p, is_real, source) values ' + values.join(',') +
        ' on conflict (ticker, t) do update set p = excluded.p, is_real = excluded.is_real, source = excluded.source',
        params
      );
    }
    /* prune outside the retention window at most once a minute */
    if (now - (flushMarketTicks._prunedAt || 0) > 60000) {
      flushMarketTicks._prunedAt = now;
      await pool.query('delete from whalechat_market_ticks where t < $1', [now - TICK_RETENTION_MS]).catch(() => {});
    }
    return rows.length;
  } catch (e) {
    console.error('[market] durable tick write failed:', e.message);
    if (isConnError(e)) { dropPool(); schedulePgRetry(); }
    return 0;
  }
}
market.onTick(queueMarketTick);
setInterval(() => { flushMarketTicks(false).catch(() => {}); }, 10000).unref();

/* The WhaleChat company stock (WC) counts like any other symbol: its price is
   the live whale-share market price, the same number WC-Investing plans use for
   their daily return, and every move is a real tick in the chart/history. */
let companyStockAt = 0;
function bridgeCompanyStock() {
  try {
    const now = Date.now();
    if (now - companyStockAt < 3000) return;
    companyStockAt = now;
    const px = Number(shares.sharePrice());
    if (!(px > 0)) return;
    const q = market.quotes['WC'] || {};
    market.writeQuote('WC', px, {
      prevClose: Number(q.prevClose) > 0 ? Number(q.prevClose) : px,
      open: Number(q.open) > 0 ? Number(q.open) : px,
      vol: Number(q.vol) || 0,
      source: 'whaleshares',
      real: true
    });
  } catch (e) {}
}
setInterval(bridgeCompanyStock, 3000).unref();

async function initStorage() {
  if (!DATABASE_URL) return;
  await connectPostgres();
  /* keep the database warm so a free Supabase project never goes idle */
  setInterval(() => {
    if (!pool) return;
    pool.query("insert into whalechat_heartbeat (id, at, note) values (1, now(), 'beat') on conflict (id) do update set at = now(), note = 'beat'")
      .then(() => { pgState.lastWriteAt = Date.now(); })
      .catch((e) => { if (isConnError(e)) { dropPool(); schedulePgRetry(); } });
  }, 5 * 60 * 1000).unref();
}

loadState();
setInterval(() => snapshot('hourly'), 3600000).unref();

let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }
let vapid = null;
let subscriptions = [];
/* Push identity and device subscriptions are kept in the database (and the
   file cache) so a redeploy that preserves /data or Postgres keeps every
   registered phone working. Env keys win, so an operator can pin them. */
function initPush() {
  if (!webpush) { console.log('[push] web-push not installed — push disabled'); return; }
  const envPub = process.env.VAPID_PUBLIC_KEY || '';
  const envPriv = process.env.VAPID_PRIVATE_KEY || '';
  let stored = (envPub && envPriv) ? { publicKey: envPub, privateKey: envPriv } : null;
  if (!stored) {
    try { if (store.db && store.db.settings && store.db.settings.vapid && store.db.settings.vapid.publicKey) stored = store.db.settings.vapid; } catch (e) {}
  }
  if (!stored) stored = readJSON(VAPID_FILE, null);
  if (!stored || !stored.publicKey || !stored.privateKey) {
    stored = webpush.generateVAPIDKeys();
    console.log('[push] generated VAPID keys');
  }
  vapid = stored;
  try {
    if (store.db) {
      store.db.settings = store.db.settings || {};
      store.db.settings.vapid = { publicKey: vapid.publicKey, privateKey: vapid.privateKey };
    }
  } catch (e) {}
  try { writeJSONAtomic(VAPID_FILE, vapid); } catch (e) {}
  webpush.setVapidDetails('mailto:' + VAPID_EMAIL, vapid.publicKey, vapid.privateKey);
  let list = null;
  try { if (store.db && Array.isArray(store.db.pushSubscriptions)) list = store.db.pushSubscriptions; } catch (e) {}
  if (!list) list = readJSON(SUBS_FILE, []);
  subscriptions = Array.isArray(list) ? list : [];
  try { if (store.db) store.db.pushSubscriptions = subscriptions; } catch (e) {}
  try { persist(); } catch (e) {}
  console.log('[push] ready · devices', subscriptions.length);
}
const saveSubs = () => {
  try { writeJSONAtomic(SUBS_FILE, subscriptions); } catch (e) {}
  try { if (store.db) { store.db.pushSubscriptions = subscriptions; persist(); } } catch (e) {}
};

async function sendPush(userId, payload) {
  if (!webpush || !vapid) return 0;
  const targets = subscriptions.filter(s => s.userId === userId);
  let sent = 0; const dead = [];
  await Promise.all(targets.map(async (rec) => {
    try { await webpush.sendNotification(rec.subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(rec); }
  }));
  if (dead.length) { subscriptions = subscriptions.filter(s => !dead.includes(s)); saveSubs(); }
  if (targets.length) console.log(`[push] -> ${userId} · devices: ${targets.length} · sent: ${sent}`);
  return sent;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-admin-token', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Payload too large'), { code: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(Object.assign(new Error('Invalid JSON'), { code: 400 })); } });
    req.on('error', reject);
  });
}
/* Account + delivery emails (Outlook SMTP, queued & retried). */
function lifecycleEmails(pushes, events) {
  if (!email) return;
  const appUrl = PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
  for (const p of pushes) {
    if (p.col === 'users' && p.isNew && p.item && p.item.email) {
      email.enqueue({ key: 'welcome:' + p.item.id, to: p.item.email, template: 'welcome', data: p.item, appUrl });
    }
  }
  for (const ev of events) {
    if (ev.col === 'orders' && ev.to === 'delivered' && ev.item) {
      const buyer = (store.db.users || []).find(u => u.id === ev.item.buyerId);
      if (buyer && buyer.email) {
        email.enqueue({ key: 'delivered:' + ev.item.id, to: buyer.email, template: 'delivered', data: { order: ev.item, user: buyer }, appUrl });
      }
    }
  }
}
const VERIFY_CODES = new Map();
/* 6-digit codes for sign-up / password reset, keyed by email + purpose */
const EMAIL_CODES = new Map();
function emailCodeKey(email, purpose) { return String(email || '').trim().toLowerCase() + ':' + String(purpose || 'signup'); }
function codeHash(email, purpose, code) {
  return require('crypto').createHash('sha256')
    .update('email-code::' + emailCodeKey(email, purpose) + '::' + String(code || '').trim()).digest('hex');
}
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch (e) {} }
}
function mime(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
function notFound(res) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); }
/* -------------------------------------------------- branded link redirects */
function hostOfUrl(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } }
function brandedDestination(code) {
  const st = (store.db && store.db.settings) || {};
  const raw = String(st.appLinkDestination || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const u = new URL(raw);
    if (code) {
      const c = String(code).toUpperCase();
      if (/\.html?$/i.test(u.pathname)) u.searchParams.set('ref', c);
      else u.pathname = u.pathname.replace(/\/+$/, '') + '/ref/' + encodeURIComponent(c);
    }
    return u.href;
  } catch (e) { return ''; }
}
/* Requests arriving on the admin's branded domain act as a redirector:
   /          -> main app link
   /ref/CODE  -> main app link with the referral code attached */
function handleBrandedRedirect(req, res, pathname) {
  const st = (store.db && store.db.settings) || {};
  const custom = hostOfUrl(st.appLink || '');
  if (!custom) return false;
  const dest = brandedDestination('');
  if (!dest) return false;
  const reqHost = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (reqHost !== custom || hostOfUrl(dest) === reqHost) return false;
  const m = pathname.match(/^\/(?:ref|r)\/([A-Za-z0-9_-]+)\/?$/i);
  let target = '';
  if (m) target = brandedDestination(m[1]);
  else if (pathname === '/' || pathname === '/index.html' || pathname === '/whalechat.html') target = dest;
  if (!target) return false;
  res.writeHead(302, { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end();
  console.log('[redirect] ' + reqHost + pathname + ' -> ' + target);
  return true;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (/^\/(ref|r)\/[A-Za-z0-9_-]+\/?$/.test(rel)) rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { if (!path.extname(rel)) return serveStatic(req, res, '/index.html'); return notFound(res); }
    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === '.html';
    const headers = { 'content-type': mime(file), 'content-length': st.size, 'x-content-type-options': 'nosniff', 'cache-control': isHtml || ext === '.webmanifest' ? 'no-cache' : (rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600') };
    if (isHtml) {
      fs.readFile(file, (e2, buf) => {
        if (e2) return notFound(res);
        let html = buf.toString('utf8');
        if (path.basename(file) === 'whalechat.html') {
          html = html.replace('<head>', '<head>\n<script>window.__WC_SERVER__ = true; window.__WC_PUBLIC_URL__ = ' + JSON.stringify(PUBLIC_URL || '') + ';</script>');
        }
        const out = Buffer.from(html); headers['content-length'] = out.length;
        res.writeHead(200, headers); res.end(out);
      });
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const COLLECTIONS = ['users', 'vendors', 'companyProducts', 'products', 'orders', 'deposits', 'withdrawals', 'messages', 'statuses', 'notifications', 'contacts', 'blocks', 'txs', 'referrals', 'purchases', 'refunds', 'vendorApplications', 'reports', 'bonuses', 'bonusClaims', 'emailCampaigns', 'stocks', 'holdings', 'trades', 'watchlist', 'alerts', 'audit', 'portfolioAudit', 'botAccounts', 'botEvents', 'traffic', 'shareInvestments', 'serviceRequests'];

/* Admin checks need a valid server-issued admin session token (x-admin-token
   header, see admin-auth.js). The adminId sent by the browser alone is not
   trusted any more. */
function isAdmin(db, adminId) {
  return adminAuth.isAdminRequest(adminId);
}
function adminFor(adminId) {
  return adminAuth.isAdminRequest(adminId) ? adminAuth.currentAdmin() : null;
}

/* =========================================================================
   Chat lane (3.69) — a small, fast road for messages
   -------------------------------------------------------------------------
   Messages used to ride on the whole state document. Here they get their own
   tiny log with a monotonic sequence, an SSE stream for devices that can hold
   one open, and a long poll for everything else. Delivery is one round trip.
   ========================================================================= */
const CHAT_KEEP = 4000;
const chatRing = { seq: 0, messages: [], loaded: false, subs: new Set() };
const CHAT_LOG_FILE = path.join(DATA_DIR, 'chat-log.json');

function chatLoadSync() {
  if (chatRing.loaded) return chatRing;
  chatRing.loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(CHAT_LOG_FILE, 'utf8'));
    if (raw && Array.isArray(raw.messages)) {
      chatRing.messages = raw.messages;
      chatRing.seq = Number(raw.seq) || raw.messages.length || 0;
    }
  } catch (e) { /* first boot: empty log */ }
  return chatRing;
}
let chatSaveTimer = null;
function chatSaveSoon() {
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    try { writeJSONAtomic(CHAT_LOG_FILE, { seq: chatRing.seq, messages: chatRing.messages }); } catch (e) {}
  }, 400);
}
function chatNormalize(m, seq) {
  if (!m || !m.id || !m.chatId) return null;
  return {
    id: String(m.id).slice(0, 60),
    chatId: String(m.chatId).slice(0, 120),
    from: String(m.from || '').slice(0, 60),
    to: String(m.to || '').slice(0, 60),
    type: /^(text|image|video|audio)$/.test(String(m.type || '')) ? m.type : 'text',
    text: String(m.text == null ? '' : m.text).slice(0, 4000),
    mediaId: m.mediaId ? String(m.mediaId).slice(0, 80) : null,
    dur: Number(m.dur) || null,
    createdAt: Number(m.createdAt) || Date.now(),
    status: String(m.status || 'sent').slice(0, 20),
    forwarded: !!m.forwarded,
    deleted: !!m.deleted,
    readBy: Array.isArray(m.readBy) ? m.readBy.slice(0, 50) : [],
    seq: Number(seq) || 0
  };
}
function chatAppendMessages(list) {
  chatLoadSync();
  const have = new Map(chatRing.messages.map((m) => [m.id, m]));
  const accepted = [];
  for (const raw of (list || [])) {
    const m = chatNormalize(raw, 0);
    if (!m) continue;
    const cur = have.get(m.id);
    if (cur) {
      if (m.status) cur.status = m.status;
      if (m.readBy && m.readBy.length > (cur.readBy || []).length) cur.readBy = m.readBy;
      if (m.deleted) cur.deleted = true;
      accepted.push({ id: cur.id, status: cur.status, seq: cur.seq, duplicate: true });
      continue;
    }
    chatRing.seq += 1;
    m.seq = chatRing.seq;
    chatRing.messages.push(m);
    have.set(m.id, m);
    accepted.push({ id: m.id, status: m.status, seq: m.seq });
  }
  if (chatRing.messages.length > CHAT_KEEP) chatRing.messages = chatRing.messages.slice(-CHAT_KEEP);
  if (accepted.length) {
    chatSaveSoon();
    for (const sub of chatRing.subs) { try { sub(); } catch (e) {} }
  }
  return { ok: true, seq: chatRing.seq, accepted };
}
function chatMessagesSince(since) {
  chatLoadSync();
  const s = Number(since) || 0;
  return { seq: chatRing.seq, messages: chatRing.messages.filter((m) => Number(m.seq) > s) };
}

/* --- lane events: typing, read receipts and presence ---------------------
   They ride the same subscriber set as messages but their own short ring, so a
   test of "is the other person typing" never has to touch the state document. */
const chatEventRing = { seq: 0, events: [] };
const CHAT_EVENT_KEEP = 600;
const adminSmsSubs = new Set();
function chatEventPush(ev) {
  if (!ev) return;
  chatEventRing.seq += 1;
  ev.seq = chatEventRing.seq;
  ev.at = Number(ev.at) || Date.now();
  chatEventRing.events.push(ev);
  if (chatEventRing.events.length > CHAT_EVENT_KEEP) chatEventRing.events = chatEventRing.events.slice(-CHAT_EVENT_KEEP);
  for (const sub of chatRing.subs) { try { sub(); } catch (e) {} }
}
function chatEventsSince(since, userId, room) {
  const s = Number(since) || 0;
  const events = chatEventRing.events.filter((e) => {
    if (Number(e.seq) <= s) return false;
    if (!userId && !room) return true;
    if (e.type === 'typing') return (userId && (e.to === userId || e.from === userId)) || (room && e.chatId === room);
    if (e.type === 'read') return (userId && (e.to === userId || e.by === userId)) || (room && (e.messages || []).some((m) => m.chatId === room));
    if (e.type === 'presence') return true;
    return true;
  });
  return { seq: chatEventRing.seq, events: events };
}
/* Push accepted lane messages to the hosted provider (no-op when unconfigured). */
function routeRealtime(accepted) {
  try {
    if (!realtime.configured().enabled || !accepted || !accepted.length) return;
    const ids = new Set(accepted.map((a) => a && a.id).filter(Boolean));
    for (const m of chatRing.messages) {
      if (!ids.has(m.id)) continue;
      realtime.publishMessage(m).catch(() => {});
      ids.delete(m.id);
    }
  } catch (e) {}
}
/* An admin SMS also lands in the app chat, so the user can answer it inside
   WhaleChat and the answer reaches the admin desk in real time. */
function adminChatAppend(admin, user, text, body) {
  if (!user || !user.id) return null;
  const adminId = admin.id || (store.db.users || []).filter((u) => u && u.role === 'admin').map((u) => u.id)[0] || 'usr_admin';
  const chatId = [String(user.id), String(adminId)].sort().join('__');
  const msg = {
    id: 'msg_sms_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    chatId: chatId,
    from: adminId,
    to: String(user.id),
    type: 'text',
    text: String(text || '').slice(0, 4000),
    createdAt: Date.now(),
    status: 'sent',
    channel: 'sms',
    readBy: []
  };
  chatAppendMessages([msg]);
  routeRealtime([{ id: msg.id }]);
  for (const sub of adminSmsSubs) { try { sub(JSON.stringify({ kind: 'chat', message: msg, at: Date.now() })); } catch (e) {} }
  try {
    const db = store.db;
    db.notifications = Array.isArray(db.notifications) ? db.notifications : [];
    db.notifications.unshift({ id: 'nt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), userId: user.id, title: 'Message from WhaleChat', body: String(text || '').slice(0, 140), link: '#/chat/' + adminId, icon: 'chat', read: false, createdAt: Date.now() });
    if (db.notifications.length > 400) db.notifications.length = 400;
  } catch (e) {}
  return { chatId: chatId, message: msg };
}

function adminRequired(res) {
  return json(res, 401, { ok: false, error: 'admin_session_required', message: 'Confirm your admin password to continue' });
}
function ensureServices(db) {
  if (!db) return;
  try { spot.ensureDefaults(db); } catch (e) {}
  try { bots.ensureDefaults(db); } catch (e) {}
  try { shares.ensureDefaults(db); } catch (e) {}
}
function applyOps(db, ops) {
  const pushes = [];
  const events = [];
  for (const op of ops || []) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'set') { if (typeof op.key === 'string' && !op.key.startsWith('__')) db[op.key] = op.value; continue; }
    if (!COLLECTIONS.includes(op.col)) continue;
    if (!Array.isArray(db[op.col])) db[op.col] = [];
    const arr = db[op.col];
    if (op.op === 'push' && op.item && op.item.id) {
      const i = arr.findIndex(x => x && x.id === op.item.id);
      if (i >= 0) arr[i] = op.item; else arr.push(op.item);
      pushes.push({ col: op.col, item: op.item, isNew: i < 0 });
    } else if (op.op === 'update' && op.id) {
      const i = arr.findIndex(x => x && x.id === op.id);
      if (i >= 0) {
        const before = arr[i] ? arr[i].status : null;
        arr[i] = Object.assign({}, arr[i], op.patch || {});
        if (op.patch && op.patch.status && op.patch.status !== before) events.push({ col: op.col, item: arr[i], from: before, to: op.patch.status });
      } else if (op.patch && op.patch.id) arr.push(op.patch);
    } else if (op.op === 'remove' && op.id) {
      const i = arr.findIndex(x => x && x.id === op.id); if (i >= 0) arr.splice(i, 1);
    }
  }
  return { pushes, events };
}
/* Sync-channel guard (runs before applyOps).
   /api/ops is not authenticated, so without an admin session it must not be
   able to: change anyone's role, take over an admin account (pass, pin,
   email, username, banned), delete an admin, or replace whole collections.
   It also enforces trading_controls / tradable_symbols on trades that the
   web app opens through the sync channel: a blocked trade and the balance
   change sent with it are dropped, the user gets a notification and every
   client is told to resync. */
const ADMIN_LOCKED_FIELDS = ['role', 'pass', 'pin', 'email', 'username', 'banned'];
function guardOps(db, ops) {
  const admin = adminAuth.currentAdmin();
  const users = Array.isArray(db.users) ? db.users : [];
  const byId = new Map(users.map((u) => [u && u.id, u]));
  const blockedUsers = new Set();
  const blocked = [];
  let modified = false;
  const existingTrades = new Set((db.trades || []).map((t) => t && t.id));
  for (const op of ops) {
    if (op && op.col === 'trades' && op.op === 'push' && op.item && op.item.id && op.item.status === 'Open' && !existingTrades.has(op.item.id)) {
      const reason = marketAdmin.gate('open', { ticker: op.item.ticker, leverage: op.item.leverage });
      if (reason) { op.__drop = true; blockedUsers.add(op.item.userId); blocked.push({ userId: op.item.userId, ticker: op.item.ticker, reason }); }
    }
  }
  const out = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.__drop) { modified = true; continue; }
    if (op.op === 'set' && !admin && (COLLECTIONS.includes(op.key) || /^share|^market/i.test(String(op.key || '')))) { modified = true; continue; }
    if (op.col === 'users') {
      const id = op.op === 'push' ? (op.item && op.item.id) : op.id;
      const cur = byId.get(id);
      if (blockedUsers.has(id) && op.op !== 'remove') { modified = true; continue; }
      if (op.op === 'remove' && cur && cur.role === 'admin' && !admin) { modified = true; continue; }
      const next = op.op === 'push' ? op.item : op.op === 'update' ? op.patch : null;
      if (next && typeof next === 'object' && !admin) {
        if (cur) {
          const locked = cur.role === 'admin' ? ADMIN_LOCKED_FIELDS : ['role'];
          for (const f of locked) {
            if (JSON.stringify(next[f]) === JSON.stringify(cur[f])) continue;
            if (!(f in next) && op.op === 'update') continue;
            if (cur[f] === undefined) delete next[f]; else next[f] = cur[f];
            modified = true;
          }
        } else if (next.role && next.role !== 'user') {
          next.role = 'user';
          modified = true;
        }
      }
    }
    out.push(op);
  }
  if (blocked.length) {
    db.notifications = Array.isArray(db.notifications) ? db.notifications : [];
    blocked.forEach((b) => {
      db.notifications.unshift({ id: 'nt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), userId: b.userId, title: 'Trade not opened', body: (b.ticker ? b.ticker + ': ' : '') + b.reason + '. No funds were taken.', link: '#/markets', icon: 'shield', read: false, createdAt: Date.now() });
    });
    if (db.notifications.length > 400) db.notifications.length = 400;
  }
  return { ops: out, modified, blocked };
}
function previewText(msg) {
  if (!msg) return 'New message';
  if (msg.type === 'image') return '📷 Photo';
  if (msg.type === 'video') return '🎥 Video';
  if (msg.type === 'voice' || msg.type === 'audio') return '🎤 Voice note';
  return String(msg.text || '').slice(0, 140) || 'New message';
}
async function dispatchPushes(pushes, db) {
  if (!webpush) return;
  const seen = new Set();
  for (const p of pushes) {
    if (!p.isNew && p.col !== 'notifications') continue;
    if (p.col === 'messages' && p.item.to && !p.item.deleted) {
      const key = 'msg:' + p.item.id; if (seen.has(key)) continue; seen.add(key);
      const sender = (db.users || []).find(u => u.id === p.item.from);
      await sendPush(p.item.to, { title: sender ? (sender.fullName || sender.username) : 'WhaleChat', body: previewText(p.item), link: '#/chat/' + (p.item.chatId || ''), tag: 'wc-msg-' + (p.item.chatId || p.item.from), requireInteraction: true });
    }
    if (p.col === 'notifications' && p.item.userId) {
      await sendPush(p.item.userId, { title: p.item.title || 'WhaleChat', body: p.item.body || '', link: p.item.link || '#/notifications', tag: 'wc-' + p.item.userId });
    }
  }
}

async function api(req, res, pathname, query) {
  /* --- admin session (server-verified password -> signed token) ---------- */
  if (pathname === '/api/admin/session' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, Object.assign({ ok: true }, adminAuth.login(store.db, body, adminAuth.ctx().ip))); }
    catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
  }
  /* the admin panel opens without a second password step: a signed-in admin gets
     a signed session for their own account id */
  if (pathname === '/api/admin/session/auto' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, Object.assign({ ok: true }, adminAuth.issue(store.db, body.userId || body.adminId || body.login))); }
    catch (e) { return json(res, e.status || 403, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/admin/session' && req.method === 'GET') {
    const a = adminAuth.currentAdmin();
    return json(res, 200, { ok: true, active: !!a, adminId: a ? a.id : null });
  }

  /* the pre-3.46 key form stored provider keys in plain text: retired */
  if (pathname === '/api/market/providers' && req.method === 'POST') {
    return json(res, 410, { ok: false, error: 'moved', message: 'Save provider keys in Admin > Market Controls (stored encrypted).' });
  }

  /* --- market: provider-only price cache (public) ------------------------- */
  if (pathname === '/api/market/quote' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, quote: await marketAdmin.quote(query.get('symbol') || '', { admin: !!adminAuth.currentAdmin() }) }); }
    catch (e) { return json(res, e.status || 400, { ok: false, error: e.message, is_delayed: true }); }
  }
  if (pathname === '/api/market/symbols' && req.method === 'GET') {
    return json(res, 200, { ok: true, symbols: marketAdmin.symbolsPublic(query.get('type') || '') });
  }
  if (pathname === '/api/market/trading-status' && req.method === 'GET') {
    return json(res, 200, Object.assign({ ok: true }, marketAdmin.controls()));
  }

  /* --- market admin (token required, every change -> admin_logs) ---------- */
  if (pathname.startsWith('/api/admin/market/') || pathname === '/api/admin/logs') {
    const admin = adminAuth.currentAdmin();
    if (!admin) return adminRequired(res);
    const rc = adminAuth.ctx();
    try {
      if (pathname === '/api/admin/market/overview' && req.method === 'GET') return json(res, 200, marketAdmin.overview());
      if (pathname === '/api/admin/logs' && req.method === 'GET') {
        return json(res, 200, { ok: true, logs: await marketAdmin.logs({ limit: query.get('limit'), action: query.get('action'), entity_type: query.get('entity_type') }) });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (pathname === '/api/admin/market/provider') {
          const provider = await marketAdmin.updateProvider(admin, rc, body);
          if (String(body.provider || body.provider_name || '') === 'twelvedata' && twelvedata) twelvedata.poll().catch(() => {});
          return json(res, 200, { ok: true, provider });
        }
        if (pathname === '/api/admin/market/provider/test') return json(res, 200, { ok: true, provider: await marketAdmin.testProvider(admin, rc, String(body.provider || '')) });
        if (pathname === '/api/admin/market/controls') {
          const out = await marketAdmin.updateControls(admin, rc, body);
          try { broadcast('change', { rev: store.rev, source: 'trading-controls', at: Date.now() }); } catch (e) {}
          return json(res, 200, { ok: true, controls: out });
        }
        if (pathname === '/api/admin/market/symbol') return json(res, 200, { ok: true, symbol: await marketAdmin.upsertSymbol(admin, rc, body) });
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
  }

  /* --- WhaleChat shares admin extras (token required, logged) ------------- */
  if (pathname === '/api/shares/admin/settings' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const admin = adminAuth.currentAdmin();
    if (!admin) return adminRequired(res);
    const body = await readBody(req);
    try {
      const r = shares.saveSettings(body);
      await marketAdmin.audit(admin, adminAuth.ctx(), 'share_settings_updated', 'share_settings', 'whalechat-shares', r.before, r.after).catch((e) => console.error('[admin_logs]', e.message));
      return json(res, 200, r.state);
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/shares/admin/investments' && req.method === 'GET') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    if (!adminAuth.currentAdmin()) return adminRequired(res);
    try { return json(res, 200, shares.adminInvestments({ status: query.get('status'), q: query.get('q') })); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/shares/admin/investment' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const admin = adminAuth.currentAdmin();
    if (!admin) return adminRequired(res);
    const body = await readBody(req);
    try {
      const r = shares.adminUpdateInvestment(body);
      await marketAdmin.audit(admin, adminAuth.ctx(), body.action === 'cancel' ? 'share_investment_cancelled' : 'share_investment_updated', 'share_investment', String(body.id || ''), r.before, Object.assign({}, r.after, body.action === 'cancel' ? { refund: body.refund !== false } : {})).catch((e) => console.error('[admin_logs]', e.message));
      return json(res, 200, { ok: true, investment: r.view });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  /* --- market data proxy (keys stay server side) ------------------------- */
  if (marketData && pathname === '/api/market/symbols' && req.method === 'GET') {
    return json(res, 200, { ok: true, symbols: marketData.symbols(query.get('type') || 'crypto') });
  }
  if (marketData && pathname === '/api/market/quote' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, quote: await marketData.quote(query.get('symbol')) }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (marketData && pathname === '/api/market/candles' && req.method === 'GET') {
    try { return json(res, 200, Object.assign({ ok: true }, await marketData.candles(query.get('symbol'), query.get('tf') || '1H'))); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (marketData && pathname === '/api/market/symbol-search' && req.method === 'GET') {
    return json(res, 200, { ok: true, results: await marketData.search(query.get('q')) });
  }
  if (marketData && pathname === '/api/market/providers' && req.method === 'GET') {
    if (!isAdmin(store.db, query.get('adminId') || '')) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, { ok: true, providers: marketData.status() });
  }
  if (marketData && pathname === '/api/market/providers' && req.method === 'POST') {
    const body = await readBody(req);
    if (!isAdmin(store.db, body.adminId)) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, { ok: true, providers: marketData.save(body) });
  }
  if (marketData && pathname === '/api/market/providers/test' && req.method === 'POST') {
    const body = await readBody(req);
    if (!isAdmin(store.db, body.adminId)) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, { ok: true, result: await marketData.test(String(body.which || '')) });
  }
  /* --- durable connection settings (admin only) -------------------------- */
  if (pathname === '/api/connections' && req.method === 'GET') {
    const adminId = query.get('adminId') || '';
    const admin = adminFor(adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, connections ? connections.status() : { ok: false, error: 'connections_disabled' });
  }
  if (pathname === '/api/connections' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = adminFor(body.adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    if (!connections) return json(res, 503, { ok: false, error: 'connections_disabled' });
    try { return json(res, 200, connections.saveFrom(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/connections/test' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = adminFor(body.adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    const which = String(body.which || 'all');
    const out = { ok: true, at: Date.now(), results: {} };
    if (which === 'all' || which === 'binance') {
      if (binance) { await binance.poll().catch(() => {}); out.results.binance = binance.status(); }
    }
    if (which === 'all' || which === 'finnhub') {
      try { out.results.finnhub = market.status(); } catch (e) { out.results.finnhub = { error: e.message }; }
    }
    if (which === 'all' || which === 'twelvedata') {
      if (twelvedata) { await twelvedata.poll().catch(() => {}); out.results.twelvedata = twelvedata.status(); }
    }
    if (which === 'all' || which === 'brevo') {
      try {
        out.results.email = email ? email.status() : { configured: false };
        if (email && email.configured && email.configured() && body.to) {
          out.results.emailTestQueued = email.enqueue({ key: 'test:' + Date.now(), to: String(body.to), template: 'test', data: {}, appUrl: PUBLIC_URL || ('http://localhost:' + PORT) });
        }
      } catch (e) { out.results.email = { error: e.message }; }
    }
    return json(res, 200, out);
  }

  /* --- Binance live crypto prices ---------------------------------------- */
  if (pathname === '/api/market/binance' && req.method === 'GET') {
    if (!binance) return json(res, 503, { ok: false, error: 'binance_disabled' });
    return json(res, 200, Object.assign({ ok: true }, binance.status()));
  }
  if (pathname === '/api/market/binance/config' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const admin = adminFor(body.adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    if (!store.db.settings) store.db.settings = {};
    const cur = store.db.settings.binance || {};
    const next = {
      enabled: body.enabled === undefined ? (cur.enabled !== false) : !!body.enabled,
      apiKey: typeof body.apiKey === 'string' && body.apiKey ? body.apiKey : cur.apiKey || '',
      symbols: (body.symbols && typeof body.symbols === 'object') ? body.symbols : (cur.symbols || {}),
      updatedAt: Date.now()
    };
    store.db.settings.binance = next;
    persistNow();
    if (binance) { binance.poll().catch(() => {}); }
    return json(res, 200, { ok: true, enabled: next.enabled, hasKey: !!next.apiKey, symbols: Object.keys(next.symbols || {}).length });
  }

  /* --- B2B price alerts: status, manual evaluation, link verification ---- */
  if (pathname === '/api/b2b/alerts/status' && req.method === 'GET') {
    const appUrl = PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
    return json(res, 200, {
      ok: true,
      watcher: b2bAlerts ? b2bAlerts.status() : { disabled: true },
      email: email ? { configured: email.configured(), provider: email.status().provider } : { configured: false },
      links: {
        buy: b2bAlerts ? b2bAlerts.buyLink(appUrl, 'BTCUSD') : null,
        sell: b2bAlerts ? b2bAlerts.sellLink(appUrl, 'BTCUSD') : null,
        page: appUrl + '/whalechat.html'
      }
    });
  }
  if (pathname === '/api/b2b/alerts/run' && req.method === 'POST') {
    if (!b2bAlerts) return json(res, 503, { ok: false, error: 'watcher_disabled' });
    try { return json(res, 200, { ok: true, status: b2bAlerts.run() }); }
    catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, app: 'whalechat', version: readJSON(path.join(PUBLIC_DIR, 'version.json'), {}).version || null, build: (readJSON(path.join(PUBLIC_DIR, 'version.json'), {}).build) || BUILD, uptimeSec: Math.floor((Date.now() - STARTED) / 1000), rev: store.rev, users: (store.db && store.db.users) ? store.db.users.length : 0, clients: clients.size, push: !!webpush, publicUrl: PUBLIC_URL || null, storage: pool ? 'postgres' : 'file', stream: true, realtime: realtime.configured(), storageDetail: { connected: pgState.connected, attempts: pgState.attempts, lastError: pgState.lastError || null, lastConnectAt: pgState.lastConnectAt || null, lastWriteAt: pgState.lastWriteAt || null, lastAdopt: pgState.lastAdopt, retryInMs: pgRetryTimer ? pgRetryDelay : 0 }, email: !!(email && email.configured()), market: market.status() });
  }
  if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, { rev: store.rev, db: store.db, updatedAt: store.updatedAt });
  if (pathname === '/api/state/init' && req.method === 'POST') {
    /* an empty state (fresh instance) may be re-seeded by a device that still
       has the account locally; a state with users is never overwritten */
    const existingUsers = (store.db && Array.isArray(store.db.users)) ? store.db.users.length : 0;
    if (store.db && existingUsers > 0) return json(res, 409, { ok: false, error: 'already_initialised', rev: store.rev });
    const body = await readBody(req);
    if (!body || !body.db || !Array.isArray(body.db.users)) return json(res, 400, { ok: false, error: 'invalid_db' });
    store.db = body.db; store.rev = Math.max(1, Number(body.rev) || 1); store.updatedAt = Date.now();
    ensureTradingAssets();
    ensureServices(store.db);
    /* keep the push identity and devices that were already loaded */
    try { store.db.pushSubscriptions = subscriptions; } catch (e) {}
    try { if (vapid) { store.db.settings = store.db.settings || {}; store.db.settings.vapid = { publicKey: vapid.publicKey, privateKey: vapid.privateKey }; } } catch (e) {}
    persistNow(); console.log('[db] initialised · users:', store.db.users.length);
    return json(res, 200, { ok: true, rev: store.rev });
  }
  if (pathname === '/api/ops' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const guard = guardOps(store.db, Array.isArray(body.ops) ? body.ops : []);
    const result = applyOps(store.db, guard.ops);
    const pushes = result.pushes;
    if (Array.isArray(body.ops) && body.ops.some((o) => o && o.col === 'stocks')) {
      setImmediate(() => { try { market.onAssetsChanged(); } catch (e) { console.error('[market] asset refresh:', e.message); } });
    }
    store.rev += 1; store.updatedAt = Date.now(); persist();
    /* when the guard changed anything, the sender must resync too */
    broadcast('change', { rev: store.rev, source: guard.modified ? 'server-guard' : (body.clientId || null), at: store.updatedAt });
    if (guard.blocked.length) console.log('[trading] blocked', guard.blocked.length, 'trade(s) from the sync channel:', guard.blocked.map((b) => b.ticker + ' ' + b.reason).join('; '));
    if (pushes.length) setImmediate(() => dispatchPushes(pushes, store.db).catch(() => {}));
    try { lifecycleEmails(pushes, result.events); } catch (e) { console.error('[email] lifecycle:', e.message); }
    return json(res, 200, guard.blocked.length ? { ok: true, rev: store.rev, blocked: guard.blocked } : { ok: true, rev: store.rev });
  }
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*' });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ rev: store.rev })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  // --- market data (Finnhub stays server-side) -------------------------
  if (pathname === '/api/market/stream' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*' });
    res.write('retry: 2000\n\n');
    try { res.write(`event: snapshot\ndata: ${JSON.stringify(market.snapshot())}\n\n`); } catch (e) {}
    marketClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => { clearInterval(ping); marketClients.delete(res); });
    return;
  }
  if (pathname === '/api/market/quotes' && req.method === 'GET') {
    return json(res, 200, market.snapshot());
  }
  if (pathname === '/api/market/history' && req.method === 'GET') {
    const raw = (query.get('tickers') || query.get('ticker') || '').toUpperCase();
    const tickers = raw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 24);
    const limit = Number(query.get('limit')) || 600;
    return json(res, 200, {
      ok: true, at: Date.now(), source: market.source(), notice: market.notice(),
      status: market.status(), history: market.historyFor(tickers, limit)
    });
  }
  if (pathname === '/api/market/status' && req.method === 'GET') {
    const body = Object.assign({ ok: true }, market.status());
    /* key-free feed telemetry, used to verify the live providers after a deploy */
    try { if (twelvedata) body.twelvedata = twelvedata.status(); } catch (e) {}
    try { if (binance) body.binance = binance.status(); } catch (e) {}
    return json(res, 200, body);
  }
  if (pathname === '/api/market/config' && req.method === 'GET') {
    const adminId = query.get('adminId') || '';
    const admin = adminFor(adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, market.publicConfig());
  }
  if (pathname === '/api/market/config' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = adminFor(body.adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    const mode = body.mode === 'hybrid' ? 'hybrid' : 'simulated';
    const refreshSec = Math.min(300, Math.max(5, Math.round(Number(body.refreshSec) || 15)));
    if (mode === 'hybrid' && !body.apiKey && !market.config.apiKey) {
      return json(res, 400, { ok: false, error: 'api_key_required', message: 'Add a Finnhub API key before enabling Hybrid mode' });
    }
    const saved = market.saveConfig({ mode, refreshSec, apiKey: body.apiKey, clearKey: body.clearKey === true });
    saveMarketConfig(market.rawConfig()).then((ok) => { if (ok) console.log('[market] config persisted to Postgres'); });
    console.log('[market] config saved by @' + admin.username + ' · mode', saved.mode, '· refresh', saved.refreshSec + 's', '· key', saved.hasKey ? 'set' : 'cleared');
    return json(res, 200, saved);
  }
  if (pathname === '/api/market/search' && req.method === 'GET') {
    const adminId = query.get('adminId') || '';
    const admin = adminFor(adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    try {
      const results = await market.searchAssets(query.get('q') || '', query.get('class') || 'us');
      return json(res, 200, { ok: true, results });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/market/assets/add' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = adminFor(body.adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    try {
      const out = await market.addAsset(body.class || body.assetClass, body.symbol);
      return json(res, 200, Object.assign({ ok: true }, out));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/market/dividends/sync' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = adminFor(body.adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    const status = await market.syncDividends(true);
    return json(res, 200, { ok: true, status });
  }
  if (pathname === '/api/market/test' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = adminFor(body.adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    if (!market.config.apiKey) return json(res, 400, { ok: false, error: 'no_key', message: 'Save a Finnhub API key first' });
    const q = await market.fetchQuote('AAPL');
    return json(res, 200, { ok: !!q, price: q ? q.price : null, symbol: 'AAPL', status: market.status(), message: q ? 'Finnhub connection OK' : (market.lastError || 'Finnhub did not return a quote') });
  }
  // --- bonus claim (atomic one-time code) -------------------------------
  if (pathname === '/api/bonus/claim' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const code = String(body.code || '').trim().toUpperCase();
    if (!code) return json(res, 400, { ok: false, error: 'invalid_code', message: 'Enter your redeem code' });
    const hash = require('crypto').createHash('sha256').update('bonus::v1::' + code).digest('hex');
    const db = store.db;
    const claim = (db.bonusClaims || []).find(c => c.codeHash === hash);
    if (!claim || claim.status !== 'issued') return json(res, 400, { ok: false, error: 'invalid_code', message: 'Invalid or already used code' });
    if (body.userId && claim.userId !== body.userId) return json(res, 403, { ok: false, error: 'wrong_user', message: 'This code belongs to another account' });
    if (body.bonusId && claim.bonusId !== body.bonusId) return json(res, 400, { ok: false, error: 'wrong_bonus', message: 'This code is for a different bonus' });
    const bonus = (db.bonuses || []).find(b => b.id === claim.bonusId);
    if (!bonus) return json(res, 404, { ok: false, error: 'bonus_missing', message: 'This bonus no longer exists' });
    const user = (db.users || []).find(u => u.id === claim.userId);
    if (!user) return json(res, 404, { ok: false, error: 'user_missing', message: 'Account not found' });
    const coinsAmt = Math.round(((Number(bonus.rewardUsd) || 0) / 0.5) * 100) / 100;
    claim.status = 'claimed'; claim.claimedAt = Date.now();
    user.balance = Math.round((Number(user.balance || 0) + coinsAmt) * 100) / 100;
    user.totalEarnings = Math.round((Number(user.totalEarnings || 0) + coinsAmt) * 100) / 100;
    const now = Date.now();
    const rid = () => now.toString(36) + Math.random().toString(36).slice(2, 7);
    (db.txs = db.txs || []).unshift({ id: 'tx_' + rid(), userId: user.id, type: 'bonus', label: 'Task bonus · ' + bonus.title, coins: coinsAmt, meta: { bonusId: bonus.id, claimId: claim.id }, createdAt: now });
    (db.notifications = db.notifications || []).unshift({ id: 'nt_' + rid(), userId: user.id, title: 'Bonus credited 🎁', body: bonus.title + ' · ' + coinsAmt + ' WC added to your balance.', link: '#/bonuses', icon: 'gift', read: false, createdAt: now });
    store.rev += 1; store.updatedAt = now; persist();
    broadcast('change', { rev: store.rev, source: 'bonus-claim', at: now });
    return json(res, 200, { ok: true, coins: coinsAmt, balance: user.balance, status: claim.status, bonus: bonus.title });
  }
  // --- email verification codes (account deletion etc.) -------------
  if (pathname === '/api/verify/send' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const purpose = String(body.purpose || 'delete').replace(/[^a-z_-]/gi, '').slice(0, 24) || 'delete';
    const user = (store.db.users || []).find(u => u.id === body.userId);
    if (!user) return json(res, 404, { ok: false, error: 'user_missing', message: 'Account not found' });
    const key = user.id + ':' + purpose;
    const prev = VERIFY_CODES.get(key);
    if (prev && Date.now() - prev.sentAt < 45000) return json(res, 429, { ok: false, error: 'too_soon', message: 'Please wait a few seconds before requesting another code', retryIn: Math.ceil((45000 - (Date.now() - prev.sentAt)) / 1000) });
    const code = String(require('crypto').randomInt(100000, 1000000));
    const hash = require('crypto').createHash('sha256').update('verify::' + key + '::' + code).digest('hex');
    VERIFY_CODES.set(key, { hash, sentAt: Date.now(), exp: Date.now() + 15 * 60000, tries: 0 });
    const appUrl = PUBLIC_URL || ('http://localhost:' + PORT);
    const labels = { delete: 'your account deletion request' };
    let emailed = false;
    if (email && email.configured() && user.email) {
      emailed = email.enqueue({ key: null, to: user.email, template: 'verifyCode', data: { code, name: user.fullName || user.username, purposeLabel: labels[purpose] || 'your request', purposeRoute: purpose }, appUrl });
    }
    /* always drop an in-app copy too, so the user is never stuck when mail is slow or not configured */
    const now = Date.now();
    if (!emailed) (store.db.notifications = store.db.notifications || []).unshift({ id: 'nt_' + now.toString(36) + Math.random().toString(36).slice(2, 7), userId: user.id, title: 'Verification code', body: 'Your WhaleChat verification code is ' + code + ' (valid 15 minutes). Never share it with anyone.', link: '#/investment/account/' + purpose + '?code=' + code, icon: 'shield', read: false, createdAt: now });
    store.rev += 1; store.updatedAt = now; persist();
    broadcast('change', { rev: store.rev, source: 'verify-code', at: now });
    const masked = user.email ? String(user.email).replace(/^(.{2}).*(@.*)$/, '$1***$2') : '';
    return json(res, 200, { ok: true, emailed, to: masked });
  }
  if (pathname === '/api/verify/check' && req.method === 'POST') {
    const body = await readBody(req);
    const purpose = String(body.purpose || 'delete').replace(/[^a-z_-]/gi, '').slice(0, 24) || 'delete';
    const key = String(body.userId || '') + ':' + purpose;
    const rec = VERIFY_CODES.get(key);
    if (!rec || Date.now() > rec.exp) return json(res, 400, { ok: false, error: 'expired', message: 'Code expired — request a new one' });
    if (rec.tries >= 6) { VERIFY_CODES.delete(key); return json(res, 429, { ok: false, error: 'locked', message: 'Too many attempts — request a new code' }); }
    const hash = require('crypto').createHash('sha256').update('verify::' + key + '::' + String(body.code || '').trim()).digest('hex');
    if (hash !== rec.hash) { rec.tries += 1; return json(res, 400, { ok: false, error: 'invalid', message: 'Incorrect code' }); }
    VERIFY_CODES.delete(key);
    return json(res, 200, { ok: true, verifiedAt: Date.now() });
  }
  // --- signup / password-reset codes sent to an email address ---------
  if (pathname === '/api/verify/email-code' && req.method === 'POST') {
    const body = await readBody(req);
    const address = String(body.email || '').trim().toLowerCase();
    const purpose = String(body.purpose || 'signup').replace(/[^a-z_-]/gi, '').slice(0, 16) || 'signup';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(address)) {
      return json(res, 400, { ok: false, error: 'invalid_email', message: 'Enter a valid email address' });
    }
    const key = emailCodeKey(address, purpose);
    const prev = EMAIL_CODES.get(key);
    if (prev && Date.now() - prev.sentAt < 45000) {
      return json(res, 429, { ok: false, error: 'too_soon', retryIn: Math.ceil((45000 - (Date.now() - prev.sentAt)) / 1000), message: 'Please wait a few seconds before requesting another code' });
    }
    const code = String(require('crypto').randomInt(100000, 1000000));
    EMAIL_CODES.set(key, { hash: codeHash(address, purpose, code), sentAt: Date.now(), exp: Date.now() + 15 * 60000, tries: 0 });
    const labels = { signup: 'your WhaleChat account', reset: 'your password reset', pin: 'your transaction PIN reset' };
    let emailed = false;
    try {
      if (email && email.configured()) {
        emailed = email.enqueue({
          key: null, to: address, template: 'verifyCode',
          data: { code, name: String(body.name || '').split(' ')[0] || 'there', purposeLabel: labels[purpose] || 'your request', purposeRoute: purpose === 'signup' ? 'verify' : purpose },
          appUrl: PUBLIC_URL || ('http://localhost:' + PORT)
        });
      }
    } catch (e) { console.error('[verify] email failed:', e.message); }
    return json(res, 200, { ok: true, emailed, purpose, to: address.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
      /* when no mail provider is configured the app shows the code on screen so
         account creation / reset can never dead-end */
      code: emailed ? undefined : code });
  }
  if (pathname === '/api/verify/email-check' && req.method === 'POST') {
    const body = await readBody(req);
    const address = String(body.email || '').trim().toLowerCase();
    const purpose = String(body.purpose || 'signup').replace(/[^a-z_-]/gi, '').slice(0, 16) || 'signup';
    const key = emailCodeKey(address, purpose);
    const rec = EMAIL_CODES.get(key);
    if (!rec || Date.now() > rec.exp) return json(res, 400, { ok: false, error: 'expired', message: 'Code expired — request a new one' });
    if (rec.tries >= 6) { EMAIL_CODES.delete(key); return json(res, 429, { ok: false, error: 'locked', message: 'Too many attempts — request a new code' }); }
    if (codeHash(address, purpose, body.code) !== rec.hash) {
      rec.tries += 1;
      return json(res, 400, { ok: false, error: 'invalid', message: 'Incorrect code' });
    }
    EMAIL_CODES.delete(key);
    return json(res, 200, { ok: true, verifiedAt: Date.now() });
  }
  // --- Appwrite backup status / manual sync ----------------------------
  if (pathname === '/api/appwrite/status' && req.method === 'GET') {
    return json(res, 200, appwrite ? appwrite.status() : { ok: true, configured: false });
  }
  if (pathname === '/api/appwrite/sync' && req.method === 'POST') {
    if (!adminAuth.currentAdmin()) return adminRequired(res);
    if (!appwrite || !appwrite.configured()) return json(res, 503, { ok: false, error: 'appwrite_not_configured' });
    const out = await appwrite.backup(store, 'manual');
    return json(res, out.ok ? 200 : 502, out);
  }
  if (pathname === '/api/appwrite/files' && req.method === 'POST') {
    if (!adminAuth.currentAdmin()) return adminRequired(res);
    if (!appwrite || !appwrite.configured()) return json(res, 503, { ok: false, error: 'appwrite_not_configured' });
    const out = await appwrite.uploadFiles(PUBLIC_DIR, { max: 40 });
    return json(res, out.ok ? 200 : 502, out);
  }
  // --- email -----------------------------------------------------------
  /* --- configured servers: public configuration (no secrets) ---------- */
  if (pathname === '/api/config/servers' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      ...serverConfig.publicConfig(),
      configured: serverConfig.configured(),
      realtime: realtime.publicConfig(),
      chat: { stream: true, sse: '/api/chat/stream', poll: '/api/chat/state', send: '/api/chat/send' },
      telesign: telesign ? telesign.status() : { configured: false },
      appwriteOrders: appwriteOrders ? appwriteOrders.configured() : false
    });
  }

  /* --- Telesign: SMS OTP + SMS notifications (server-signed) ---------- */
  if (pathname === '/api/telesign/status' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...(telesign ? telesign.status() : { configured: false }) });
  }
  if (pathname === '/api/telesign/start' && req.method === 'POST') {
    if (!telesign) return json(res, 501, { ok: false, error: 'telesign_unavailable' });
    const body = await readBody(req);
    try {
      const out = await telesign.startVerification({ phone: body.phone, purpose: body.purpose });
      return json(res, 200, out);
    } catch (e) {
      return json(res, e.status || 400, { ok: false, error: e.message, retryAfterMs: e.retryAfterMs });
    }
  }
  if (pathname === '/api/telesign/verify' && req.method === 'POST') {
    if (!telesign) return json(res, 501, { ok: false, error: 'telesign_unavailable' });
    const body = await readBody(req);
    try { return json(res, 200, await telesign.checkVerification({ phone: body.phone, code: body.code, referenceId: body.referenceId })); }
    catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/telesign/sms' && req.method === 'POST') {
    if (!telesign) return json(res, 501, { ok: false, error: 'telesign_unavailable' });
    const body = await readBody(req);
    if (!adminAuth.currentAdmin() && !isAdmin(store.db, body.adminId)) return adminRequired(res);
    try { return json(res, 200, await telesign.sendSms({ phone: body.phone, message: body.message, buttonLabel: body.buttonLabel, buttonUrl: body.buttonUrl })); }
    catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
  }
  /* Admin → users SMS with an embeddable link button. The button is a
     labelled https link on its own line: phones make it tappable. */
  if (pathname === '/api/telesign/broadcast' && req.method === 'POST') {
    if (!telesign) return json(res, 501, { ok: false, error: 'telesign_unavailable' });
    const body = await readBody(req);
    const admin = adminAuth.currentAdmin() || (isAdmin(store.db, body.adminId) ? body.adminId : null);
    if (!admin) return adminRequired(res);
    const audience = String(body.audience || 'all');
    const ids = Array.isArray(body.userIds) ? body.userIds.map(String) : [];
    const users = ((store.db && store.db.users) || []).filter(function (u) {
      if (!u || !u.phone || u.banned) return false;
      return audience === 'all' || ids.indexOf(String(u.id)) >= 0;
    });
    if (!users.length) return json(res, 400, { ok: false, error: 'no_recipients', message: 'No user account has a phone number yet.' });
    try {
      const out = await telesign.sendBulk({
        message: body.message,
        buttonLabel: body.buttonLabel,
        buttonUrl: body.buttonUrl,
        phones: users.map(function (u) { return u.phone; }),
        limit: body.limit
      });
      store.db.smsCampaigns = store.db.smsCampaigns || [];
      store.db.smsCampaigns.unshift({
        id: 'sms_' + Date.now().toString(36),
        message: String(body.message || '').slice(0, 700),
        buttonLabel: out.button ? out.button.label : '',
        buttonUrl: out.button ? out.button.url : '',
        audience,
        recipients: out.recipients,
        sent: out.sent,
        failed: out.failed,
        by: String(admin),
        createdAt: Date.now()
      });
      store.db.smsCampaigns = store.db.smsCampaigns.slice(0, 50);
      store.rev += 1; store.updatedAt = Date.now(); persist();
      broadcast('change', { rev: store.rev, source: 'sms-campaign', at: store.updatedAt });
      return json(res, 200, out);
    } catch (e) {
      return json(res, e.status || 400, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/telesign/log' && req.method === 'GET') {
    if (!adminAuth.currentAdmin()) return adminRequired(res);
    const list = ((store.db && store.db.smsCampaigns) || []).slice(0, 30);
    return json(res, 200, { ok: true, campaigns: list, status: telesign ? telesign.status() : { configured: false } });
  }

  /* --- chat lane: tiny payload, one round trip ----------------------- */
  if (pathname === '/api/chat/send' && req.method === 'POST') {
    const body = await readBody(req);
    const list = Array.isArray(body.messages) ? body.messages : (body.message ? [body.message] : []);
    if (!list.length) return json(res, 400, { ok: false, error: 'no_messages' });
    if (list.length > 60) return json(res, 413, { ok: false, error: 'too_many' });
    const out = chatAppendMessages(list);
    /* Fan the accepted messages out to the hosted WebSocket provider so the
       peer's screen paints in 50-100 ms; the SSE/poll lanes stay authoritative. */
    routeRealtime(out.accepted || []);
    return json(res, 200, out);
  }
  if (pathname === '/api/chat/state' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const since = Number(q.get('since') || 0) || 0;
    const evSince = Number(q.get('evSince') || 0) || 0;
    const userId = String(q.get('userId') || '');
    const room = String(q.get('chatId') || '');
    const got = chatMessagesSince(since);
    const messages = userId ? got.messages.filter((m) => m.from === userId || m.to === userId) : got.messages;
    const evs = chatEventsSince(evSince, userId, room);
    return json(res, 200, { ok: true, seq: got.seq, messages: messages, events: evs.events, evSeq: evs.seq });
  }
  if (pathname === '/api/chat/events' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const since = Number(q.get('since') || 0) || 0;
    return json(res, 200, chatEventsSince(since, q.get('userId') || '', q.get('chatId') || ''));
  }
  if (pathname === '/api/chat/typing' && req.method === 'POST') {
    const body = await readBody(req);
    const ev = { type: 'typing', from: String(body.from || ''), to: String(body.to || ''), chatId: String(body.chatId || ''), typing: body.typing !== false };
    if (!ev.from || (!ev.to && !ev.chatId)) return json(res, 400, { ok: false, error: 'from_required' });
    chatEventPush(ev);
    realtime.publishEvent('typing', ev).catch(() => {});
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/chat/read' && req.method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 200) : [];
    const reader = String(body.userId || '');
    if (!ids.length || !reader) return json(res, 400, { ok: false, error: 'ids_and_user_required' });
    const updates = [];
    for (const m of chatRing.messages) {
      if (ids.indexOf(m.id) < 0) continue;
      m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
      if (m.readBy.indexOf(reader) < 0) m.readBy.push(reader);
      m.status = 'seen';
      updates.push({ id: m.id, status: 'seen', readBy: m.readBy, chatId: m.chatId, from: m.from, to: m.to, seq: m.seq });
    }
    if (updates.length) {
      chatSaveSoon();
      const ev = { type: 'read', by: reader, ids: ids, messages: updates };
      chatEventPush(ev);
      realtime.publishEvent('read', { from: reader, chatId: updates[0].chatId, ids: ids }).catch(() => {});
      for (const sub of chatRing.subs) { try { sub(); } catch (e) {} }
    }
    return json(res, 200, { ok: true, updated: updates.length });
  }
  if (pathname === '/api/chat/presence' && req.method === 'POST') {
    const body = await readBody(req);
    const ev = { type: 'presence', userId: String(body.userId || ''), online: body.online !== false, at: Date.now() };
    if (!ev.userId) return json(res, 400, { ok: false, error: 'userId_required' });
    chatEventPush(ev);
    realtime.publishEvent('presence', { from: ev.userId, online: ev.online }).catch(() => {});
    return json(res, 200, { ok: true });
  }

  /* --- hosted realtime provider (Pusher / Ably) --------------------- */
  if (pathname === '/api/realtime/config' && req.method === 'GET') {
    return json(res, 200, realtime.publicConfig());
  }
  if (pathname === '/api/realtime/auth' && req.method === 'POST') {
    const body = await readBody(req);
    const socketId = String(body.socket_id || body.socketId || '');
    const channel = String(body.channel_name || body.channel || '');
    if (!socketId || !channel) return json(res, 400, { ok: false, error: 'socket_and_channel_required' });
    const auth = realtime.pusherAuth(socketId, channel);
    if (!auth) return json(res, 501, { ok: false, error: 'pusher_not_configured' });
    return json(res, 200, auth);
  }
  if (pathname === '/api/realtime/token' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const channels = String(q.get('channels') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const token = await realtime.ablyToken({ channels: channels, clientId: q.get('clientId') || '' });
    if (!token) return json(res, 501, { ok: false, error: 'ably_not_configured' });
    return json(res, 200, { ok: true, token: token.token, keyName: token.keyName, expires: token.expires, provider: 'ably' });
  }

  /* --- admin SMS desk: send + engage in real time -------------------- */
  if (pathname === '/api/admin/sms/send' && req.method === 'POST') {
    const admin = adminAuth.currentAdmin();
    if (!admin) return adminRequired(res);
    const body = await readBody(req);
    const text = String(body.message || body.text || '').trim();
    if (!text) return json(res, 400, { ok: false, error: 'message_required' });
    const userId = String(body.userId || '');
    const db = store.db || {};
    const user = (db.users || []).find((u) => u && String(u.id) === userId);
    const phone = String(body.phone || (user && user.phone) || '').replace(/[^\d+]/g, '');
    const wantSms = body.sms !== false && !!(telesign && telesign.configured && telesign.configured());
    if (wantSms && !/^\+?\d{8,15}$/.test(phone)) return json(res, 400, { ok: false, error: 'invalid_phone_number' });
    if (!wantSms && !userId) return json(res, 400, { ok: false, error: 'userId_required' });
    const to = phone ? (phone.charAt(0) === '+' ? phone : '+' + phone) : '';
    const out = {};
    if (wantSms) {
      try {
        Object.assign(out, await telesign.sendSms({ phone: to, message: text, buttonLabel: body.buttonLabel, buttonUrl: body.buttonUrl }));
      } catch (e) {
        return json(res, 502, { ok: false, error: 'telesign_send_failed', message: e.message, code: e.telesignCode });
      }
    } else {
      out.status = 'in_app_only';
    }
    (db.smsCampaigns = db.smsCampaigns || []).unshift({ id: 'sms_' + Date.now().toString(36), at: Date.now(), kind: wantSms ? 'single' : 'in-app', to: to || null, userId: userId || null, message: text, by: admin.id, status: out.status || 'queued', referenceId: out.referenceId || null });
    db.smsCampaigns = db.smsCampaigns.slice(0, 100);
    let chat = null;
    if (userId && body.inApp !== false) chat = adminChatAppend(admin, user, text, body);
    persist();
    broadcast('change', { rev: store.rev, source: 'admin-sms', at: Date.now() });
    realtime.publish(realtime.adminChannel(), { kind: 'sms', at: Date.now(), userId: userId || null, phone: to, message: text, status: out.status || 'sent', chatId: chat ? chat.chatId : null, inApp: !!chat }).catch(() => {});
    return json(res, 200, Object.assign({ ok: true, to: to || null, userId: userId || null, chatId: chat ? chat.chatId : null, inApp: !!chat }, out));
  }
  if (pathname === '/api/admin/sms/stream' && req.method === 'GET') {
    const admin = adminAuth.currentAdmin();
    if (!admin) return adminRequired(res);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*', 'x-accel-buffering': 'no' });
    res.write('event: hello\ndata: ' + JSON.stringify({ ok: true, provider: realtime.configured(), at: Date.now() }) + '\n\n');
    const feed = (frame) => { try { res.write(frame); } catch (e) {} };
    const onSms = (payload) => feed('event: sms\ndata: ' + JSON.stringify(payload) + '\n\n');
    adminSmsSubs.add(onSms);
    const ping = setInterval(() => feed(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); adminSmsSubs.delete(onSms); });
    const recent = ((store.db && store.db.smsCampaigns) || []).slice(0, 25);
    feed('event: log\ndata: ' + JSON.stringify({ campaigns: recent }) + '\n\n');
    return;
  }
  if (pathname === '/api/admin/sms/inbox' && req.method === 'GET') {
    const admin = adminAuth.currentAdmin();
    if (!admin) return adminRequired(res);
    const q = new URL(req.url, 'http://x').searchParams;
    const since = Number(q.get('since') || 0) || 0;
    const adminIds = new Set(((store.db && store.db.users) || []).filter((u) => u && u.role === 'admin').map((u) => u.id));
    const rows = chatRing.messages.filter((m) => Number(m.createdAt) > since && (adminIds.has(m.to) || adminIds.has(m.from))).slice(-200);
    const users = ((store.db && store.db.users) || []).filter((u) => u && u.phone).map((u) => ({ id: u.id, fullName: u.fullName || u.username || '', phone: u.phone, banned: !!u.banned }));
    return json(res, 200, { ok: true, messages: rows, users });
  }
  if (pathname === '/api/chat/sync' && (req.method === 'GET' || req.method === 'POST')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const since = Number(q.get('since') || 0) || 0;
    const wait = Math.min(25, Math.max(0, Number(q.get('wait') || 0) || 0));
    const first = chatMessagesSince(since);
    if (first.messages.length || !wait) {
      return json(res, 200, { ok: true, seq: first.seq, messages: first.messages, waited: 0 });
    }
    let done = false;
    const started = Date.now();
    const tick = () => { const got = chatMessagesSince(since); if (got.messages.length) finish(); };
    const finish = () => {
      if (done) return;
      done = true;
      chatRing.subs.delete(tick);
      clearTimeout(timer);
      const got = chatMessagesSince(since);
      try { json(res, 200, { ok: true, seq: got.seq, messages: got.messages, waited: Date.now() - started }); } catch (e) {}
    };
    const timer = setTimeout(finish, wait * 1000);
    chatRing.subs.add(tick);
    req.on('close', () => { done = true; chatRing.subs.delete(tick); clearTimeout(timer); });
    return;
  }
  if (pathname === '/api/chat/stream' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*'
    });
    const userId = String(q.get('userId') || '');
    const room = String(q.get('chatId') || '');
    let since = Number(q.get('since') || 0) || 0;
    let evSince = Number(q.get('evSince') || 0) || 0;
    /* Only events about this person leave the server on a personal stream. */
    const mine = (m) => !userId || m.from === userId || m.to === userId || (room && m.chatId === room);
    const send = () => {
      const got = chatMessagesSince(since);
      const list = got.messages.filter(mine);
      if (!list.length) return;
      since = got.seq;
      try { res.write('event: messages\ndata: ' + JSON.stringify({ seq: got.seq, messages: list, at: Date.now() }) + '\n\n'); } catch (e) {}
    };
    const sendEvents = () => {
      const got = chatEventsSince(evSince, userId, room);
      if (!got.events.length) return;
      evSince = got.seq;
      try { res.write('event: events\ndata: ' + JSON.stringify({ seq: got.seq, events: got.events }) + '\n\n'); } catch (e) {}
    };
    try { res.write('event: hello\ndata: ' + JSON.stringify({ ok: true, seq: since, provider: realtime.configured(), at: Date.now() }) + '\n\n'); } catch (e) {}
    chatRing.subs.add(send);
    chatRing.subs.add(sendEvents);
    send();
    sendEvents();
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(ping); chatRing.subs.delete(send); chatRing.subs.delete(sendEvents); });
    return;
  }

  /* --- offline trade reconciliation ---------------------------------- */
  if (pathname === '/api/orders/offline/push' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    if (!body.userId) return json(res, 400, { ok: false, error: 'user_required' });
    try {
      const out = await reconciler.push({
        userId: String(body.userId),
        email: body.email,
        orders: Array.isArray(body.orders) ? body.orders : []
      });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message, results: [] });
    }
  }
  if (pathname === '/api/orders/offline/state' && req.method === 'GET') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    return json(res, 200, reconciler.state(query.get('userId') || ''));
  }
  if (pathname === '/api/orders/offline/settle' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    try { return json(res, 200, { ok: true, settled: reconciler.settleOpen(store.db) }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/appwrite/orders/health' && req.method === 'GET') {
    return json(res, 200, appwriteOrders ? await appwriteOrders.health() : { configured: false });
  }

  if (pathname === '/api/email/status' && req.method === 'GET') {
    return json(res, 200, email ? email.status() : { ok: true, configured: false, queued: 0 });
  }
  if (pathname === '/api/email/broadcast' && req.method === 'POST') {
    if (!adminAuth.currentAdmin()) return adminRequired(res);
    if (!email || !email.configured()) return json(res, 503, { ok: false, error: 'email_not_configured' });
    const body = await readBody(req);
    const subject = String(body.subject || '').trim().slice(0, 160);
    let html = String(body.html || '').trim();
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    if (!subject || !html) return json(res, 400, { ok: false, error: 'missing_subject_or_body' });
    if (html.length > 200000) return json(res, 400, { ok: false, error: 'body_too_large' });
    const all = body.all === true;
    const ids = Array.isArray(body.userIds) ? body.userIds : [];
    const users = (store.db.users || []).filter(u => u.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email) && (all || ids.includes(u.id)));
    if (!users.length) return json(res, 400, { ok: false, error: 'no_recipients' });
    const campaignId = 'cmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const appUrl = PUBLIC_URL || ('http://localhost:' + PORT);
    let queued = 0;
    for (const u of users) {
      if (email.enqueue({ key: 'custom:' + campaignId + ':' + u.id, to: u.email, template: 'custom', data: { subject, html, text: body.text || '' }, appUrl })) queued++;
    }
    store.db.emailCampaigns = store.db.emailCampaigns || [];
    store.db.emailCampaigns.unshift({ id: campaignId, subject, recipients: users.length, queued, by: body.adminId || null, createdAt: Date.now() });
    store.db.emailCampaigns = store.db.emailCampaigns.slice(0, 50);
    store.rev += 1; store.updatedAt = Date.now(); persist();
    broadcast('change', { rev: store.rev, source: 'email-campaign', at: store.updatedAt });
    return json(res, 200, { ok: true, campaignId, recipients: users.length, queued });
  }
  if (pathname === '/api/email/backfill' && req.method === 'POST') {
    if (!adminAuth.currentAdmin()) return adminRequired(res);
    if (!email || !email.configured()) return json(res, 503, { ok: false, error: 'smtp_not_configured' });
    const body = await readBody(req).catch(() => ({}));
    const type = body.type || 'welcome';
    const appUrl = PUBLIC_URL || ('http://localhost:' + PORT);
    let queued = 0;
    if (type === 'welcome') {
      for (const u of (store.db.users || [])) {
        if (!u.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) continue;
        if (email.enqueue({ key: 'welcome:' + u.id, to: u.email, template: 'welcome', data: u, appUrl })) queued++;
      }
    }
    return json(res, 200, { ok: true, queued, type, users: (store.db.users || []).length, status: email.status() });
  }
  if (pathname === '/api/email/test' && req.method === 'POST') {
    if (!adminAuth.currentAdmin()) return adminRequired(res);
    if (!email) return json(res, 503, { ok: false, error: 'email_unavailable' });
    const body = await readBody(req);
    const admin = (store.db && store.db.users.find(u => u.role === 'admin')) || {};
    const to = String(body.to || admin.email || '');
    if (!to) return json(res, 400, { ok: false, error: 'missing_recipient' });
    if (!email.configured()) return json(res, 503, { ok: false, error: 'smtp_not_configured', to });
    const queued = email.enqueue({ key: 'test:' + Date.now(), to, template: 'test', data: {}, appUrl: PUBLIC_URL || ('http://localhost:' + PORT) });
    return json(res, 200, { ok: true, queued, to, status: email.status() });
  }
  if (pathname === '/api/release' && req.method === 'GET') {
    const v = readJSON(path.join(PUBLIC_DIR, 'version.json'), {});
    return json(res, 200, { ok: true, version: v.version || '3.2.0', build: v.build || BUILD, uptimeSec: Math.floor((Date.now() - STARTED) / 1000), clients: clients.size, rev: store.rev, devices: subscriptions.length, publicUrl: PUBLIC_URL || null, users: (store.db && store.db.users) ? store.db.users.length : 0 });
  }
  if (pathname === '/api/admin/mail' && req.method === 'POST') {
    const body = await readBody(req);
    const db = (store && store.db) || {};
    const admin = adminFor(body.adminId);
    if (!admin) return json(res, 403, { ok: false, error: 'admin only' });
    try {
      const file = path.join(DATA_DIR, 'mail.json');
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
      if (body.brevoKey) cur.brevoKey = String(body.brevoKey).trim();
      if (body.smtpKey) cur.smtpKey = String(body.smtpKey).trim();
      if (body.smtpUser) cur.smtpUser = String(body.smtpUser).trim();
      if (body.smtpHost) cur.smtpHost = String(body.smtpHost).trim();
      if (body.smtpPort) cur.smtpPort = Number(body.smtpPort) || 587;
      if (body.from) cur.from = String(body.from).trim();
      if (body.fromName) cur.fromName = String(body.fromName).trim();
      if (body.resendKey) cur.resendKey = String(body.resendKey).trim();
      cur.updatedAt = new Date().toISOString();
      writeJSONAtomic(file, cur);
      if (cur.smtpKey) process.env.BREVO_SMTP_KEY = cur.smtpKey;
      if (cur.smtpUser) process.env.BREVO_SMTP_USER = cur.smtpUser;
      if (cur.brevoKey) process.env.BREVO_API_KEY = cur.brevoKey;
      if (cur.from) process.env.MAIL_FROM = cur.from;
      return json(res, 200, { ok: true, configured: email.configured(), provider: email.status().provider, from: cur.from || null });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/reload' && req.method === 'POST') {
    if (!adminAuth.currentAdmin()) return adminRequired(res);
    const body = await readBody(req);
    broadcast('reload', { build: body.build || BUILD, version: body.version || null, at: Date.now() });
    return json(res, 200, { ok: true, clients: clients.size });
  }
  if (pathname === '/api/backup' && req.method === 'GET') {
    const list = snapshotList();
    const persistent = !!(process.env.DATA_DIR || process.env.RENDER || process.env.FLY_APP_NAME);
    return json(res, 200, { ok: true, users: (store.db && store.db.users) ? store.db.users.length : 0, count: list.length, last: list.length ? list[list.length - 1].at : null, persistent, recoverable: list.length > 0, rev: store.rev, dir: DATA_DIR });
  }
  if (pathname === '/api/backup' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const snap = snapshot('manual');
    return json(res, 200, { ok: !!snap, file: snap && snap.file, count: snapshotList().length });
  }
  if (pathname === '/api/backup/latest' && req.method === 'GET') {
    const list = snapshotList();
    if (!list.length) return json(res, 404, { ok: false, error: 'no_backups' });
    const data = fs.readFileSync(list[list.length - 1].path);
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="whalechat-backup.json"' });
    return res.end(data);
  }
  if (pathname === '/api/state/restore' && req.method === 'POST') {
    if (!adminAuth.currentAdmin()) return adminRequired(res);
    const body = await readBody(req);
    const db = body && (body.db || body);
    if (!db || !Array.isArray(db.users) || !db.users.length) return json(res, 400, { ok: false, error: 'invalid_backup' });
    snapshot('pre-restore');
    store.db = db; store.rev += 1; store.updatedAt = Date.now(); persistNow();
    broadcast('change', { rev: store.rev, source: 'restore', at: store.updatedAt });
    return json(res, 200, { ok: true, rev: store.rev });
  }
  if (pathname === '/api/push/key' && req.method === 'GET') {
    if (!vapid) return json(res, 503, { ok: false, error: 'push_disabled' });
    return json(res, 200, { ok: true, publicKey: vapid.publicKey });
  }
  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    if (!webpush) return json(res, 503, { ok: false, error: 'push_disabled' });
    const body = await readBody(req);
    if (!body.userId || !body.subscription || !body.subscription.endpoint) return json(res, 400, { ok: false, error: 'invalid_subscription' });
    subscriptions = subscriptions.filter(s => s.subscription.endpoint !== body.subscription.endpoint);
    subscriptions.push({ userId: body.userId, subscription: body.subscription, device: body.device || '', at: Date.now() });
    saveSubs();
    return json(res, 200, { ok: true, devices: subscriptions.filter(s => s.userId === body.userId).length });
  }
  if (pathname === '/api/push/status' && req.method === 'GET') {
    const userId = query.get('userId') || '';
    return json(res, 200, { ok: true, push: !!webpush, devices: subscriptions.filter(s => !userId || s.userId === userId).length });
  }
  if (pathname === '/api/push/test' && req.method === 'POST') {
    if (!webpush) return json(res, 503, { ok: false, error: 'push_disabled' });
    const body = await readBody(req);
    const sent = await sendPush(body.userId, { title: body.title || 'WhaleChat', body: body.body || 'Push notifications are working on this device 🐋', link: body.link || '#/notifications', tag: 'wc-test' });
    return json(res, 200, { ok: true, sent });
  }
  // --- live trades: manual stop / take loss (server-authoritative close) ---
  if (pathname === '/api/market/trade/close' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    { const blocked = marketAdmin.gate('close'); if (blocked) return json(res, 423, { ok: false, error: blocked, code: 'trading_blocked' }); }
    const body = await readBody(req);
    const owner = (store.db.users || []).find((u) => u && u.id === body.userId);
    if (!owner) return json(res, 400, { ok: false, error: 'User not found' });
    const action = String(body.action || 'stop');
    const reason = action === 'sl' ? 'Stop Loss Hit' : 'Stopped by user';
    try {
      return json(res, 200, market.closeTradeManual(String(body.userId), String(body.tradeId || ''), reason));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/market/secure-profit/claim-all' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const owner = (store.db.users || []).find((u) => u && u.id === body.userId);
    if (!owner) return json(res, 400, { ok: false, error: 'User not found' });
    try {
      return json(res, 200, market.claimAllSecuredProfits(String(body.userId)));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  // --- auto-secure profit claims (bot-secured take profit) ---
  if (pathname === '/api/market/secure-profit/claim' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const owner = (store.db.users || []).find((u) => u && u.id === body.userId);
    if (!owner) return json(res, 400, { ok: false, error: 'User not found' });
    try {
      return json(res, 200, market.claimSecuredProfit(String(body.userId), String(body.tradeId || ''), String(body.profitId || '')));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  // --- live trades: manual take profit skims profit and keeps running ---
  if (pathname === '/api/market/trade/take-profit' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    { const blocked = marketAdmin.gate('close'); if (blocked) return json(res, 423, { ok: false, error: blocked, code: 'trading_blocked' }); }
    const body = await readBody(req);
    const owner = (store.db.users || []).find((u) => u && u.id === body.userId);
    if (!owner) return json(res, 400, { ok: false, error: 'User not found' });
    try {
      return json(res, 200, market.takeProfitTrade(String(body.userId), String(body.tradeId || '')));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  // --- spot stock orders (authoritative, wallet + TP/SL in one place) ---
  if (pathname === '/api/market/spot/buy' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    { const blocked = marketAdmin.gate('open', { ticker: body.ticker, amountUsd: Number(body.amountUsd) > 0 ? Number(body.amountUsd) : (Number(body.amountCoins) > 0 ? Number(body.amountCoins) * 0.5 : null) }); if (blocked) return json(res, 423, { ok: false, error: blocked, code: 'trading_blocked' }); }
    try {
      const out = spot.buy(body);
      return json(res, 200, Object.assign({ ok: true }, out));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/market/spot/sell' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    { const blocked = marketAdmin.gate('close'); if (blocked) return json(res, 423, { ok: false, error: blocked, code: 'trading_blocked' }); }
    const body = await readBody(req);
    try {
      const out = spot.sell(Object.assign({ reason: 'Manual sell' }, body));
      return json(res, 200, Object.assign({ ok: true }, out));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/market/spot/tpsl' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try {
      const out = spot.setTargets(body);
      return json(res, 200, Object.assign({ ok: true }, out));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/market/spot/positions' && req.method === 'GET') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const userId = query.get('userId') || '';
    return json(res, 200, { ok: true, positions: spot.positions(store.db, userId), status: spot.status() });
  }
  if (pathname === '/api/market/spot/admin/profit' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    if (!isAdmin(store.db, body.adminId)) return json(res, 403, { ok: false, error: 'admin_only' });
    try {
      const out = spot.setAdminProfitPct(store.db, body.ticker, body.profitPct);
      return json(res, 200, Object.assign({ ok: true }, out));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  // --- trading bots (server-side simulation) ---
  if (pathname === '/api/bots/state' && req.method === 'GET') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    try { return json(res, 200, bots.publicState(query.get('userId') || '')); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/admin' && req.method === 'GET') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    if (!isAdmin(store.db, query.get('adminId') || '')) return json(res, 403, { ok: false, error: 'admin_only' });
    try { return json(res, 200, bots.adminState()); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/auto-secure/subscribe' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, bots.subscribeAutoSecure(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/auto-secure/toggle' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, bots.toggleAutoSecure(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/bots/subscribe' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, bots.subscribe(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/start' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, bots.start(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/stop' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, bots.stop(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/topup' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, bots.topup(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/transfer' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, bots.transfer(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/resume' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, bots.resume(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/history' && req.method === 'GET') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    try { return json(res, 200, bots.history(String(query.get('userId') || ''))); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/api/bots/admin/subscription' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    if (!isAdmin(store.db, body.adminId)) return json(res, 403, { ok: false, error: 'admin_only' });
    try { return json(res, 200, bots.adminEditSub(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/bots/admin/config' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    if (!isAdmin(store.db, body.adminId)) return json(res, 403, { ok: false, error: 'admin_only' });
    try { return json(res, 200, bots.saveAdminConfig(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  // --- WhaleChat share investment plans (portfolio) ---
  if (pathname === '/api/shares/state' && req.method === 'GET') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    try { return json(res, 200, shares.publicState(query.get('userId') || '')); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/shares/invest' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, shares.invest(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/shares/admin' && req.method === 'GET') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    if (!isAdmin(store.db, query.get('adminId') || '')) return json(res, 403, { ok: false, error: 'admin_only' });
    try { return json(res, 200, shares.adminState()); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/shares/admin/plans' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    if (!isAdmin(store.db, body.adminId)) return json(res, 403, { ok: false, error: 'admin_only' });
    try {
      const beforePlans = JSON.parse(JSON.stringify(shares.plans()));
      const out = shares.savePlans(body);
      await marketAdmin.audit(adminAuth.currentAdmin(), adminAuth.ctx(), 'share_plans_updated', 'share_plans', 'whalechat-shares', { plans: beforePlans }, { plans: out.plans }).catch((e) => console.error('[admin_logs]', e.message));
      return json(res, 200, out);
    }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  if (pathname === '/version.json' || pathname === '/release.json') {
    return json(res, 200, Object.assign({}, readJSON(path.join(PUBLIC_DIR, 'version.json'), {}), { server: true }));
  }
  return json(res, 404, { ok: false, error: 'not_found', path: pathname });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-admin-token', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-max-age': '86400' });
    return res.end();
  }
  if (pathname.startsWith('/api/')) {
    try { return await adminAuth.run(req, () => store.db, () => api(req, res, pathname, u.searchParams)); }
    catch (e) {
      const code = e.code === 413 ? 413 : e.code === 400 ? 400 : 500;
      console.error('[api]', pathname, e.message);
      if (!res.headersSent) return json(res, code, { ok: false, error: e.message });
      return;
    }
  }
  try { if (handleBrandedRedirect(req, res, pathname)) return; } catch (e) { console.error('[redirect]', e.message); }
  serveStatic(req, res, pathname);
});
if (marketData) { try { marketData.attachWs(server); } catch (e) { console.error('[market-data] ws:', e.message); } }
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
(async () => {
  await initStorage();
  initPush();
  try { await marketAdmin.init(pool); } catch (e) { console.error('[market-admin] init:', e.message); }
  try { if (typeof marketData !== 'undefined' && marketData && marketData.setQuoteSource) marketData.setQuoteSource((sym) => marketAdmin.quote(sym)); } catch (e) { console.error('[market-admin] quote hook:', e.message); }
  /* 3.57: if this instance woke up with an empty disk, pull the last snapshot
     back from Appwrite before the feeds start writing. Accounts are merged,
     never deleted. */
  try {
    if (appwrite && appwrite.configured()) {
      const r = await appwrite.restore({ db: store.db, rev: store.rev, updatedAt: store.updatedAt, persist: persistNow }, (m) => console.log(m));
      if (r && r.ok) { ensureTradingAssets(); ensureServices(store.db); persistNow(); }
      else console.log('[appwrite] no snapshot restored:', r && r.error);
    }
  } catch (e) { console.error('[appwrite] restore failed:', e.message); }
  ensureTradingAssets();
  /* restore the candle ring buffer before any feed writes a new tick */
  try { await loadMarketTicks(); } catch (e) { console.error('[market] tick restore:', e.message); }
  const durableMarket = await loadMarketConfig();
  if (durableMarket) {
    market.hydrateConfig(durableMarket);
    console.log('[market] restored durable config · mode', durableMarket.mode || 'simulated', '· key', durableMarket.apiKey ? 'set' : 'not set');
  }
  market.start();
  try { bridgeCompanyStock(); } catch (e) {}
  if (binance) { binance.start(); console.log('[binance] live crypto price feed started'); }
  if (twelvedata) { twelvedata.start(); console.log('[twelvedata] stock/forex price feed started'); }
  if (connections) { try { connections.boot(); } catch (e) { console.error('[connections] boot:', e.message); } }
  if (b2bAlerts) { b2bAlerts.start(); console.log('[b2b-alerts] watcher started (email + in-app)'); }
  ensureServices(store.db);
  /* keep a durable Appwrite copy even when nobody is writing */
  if (appwrite && appwrite.configured()) {
    setInterval(() => { try { appwrite.backup(store, 'interval').catch(() => {}); } catch (e) {} }, 5 * 60000).unref();
    appwrite.backup(store, 'boot').catch(() => {});
    /* mirror uploaded product/app images into Appwrite Storage as well */
    setTimeout(() => { try { appwrite.uploadFiles(PUBLIC_DIR, { max: 12 }).catch(() => {}); } catch (e) {} }, 20000);
  }
  spot.startTimers();
  bots.startTimers();
  shares.startTimers();
  server.listen(PORT, HOST, () => {
    console.log(`[whalechat] listening on http://localhost:${PORT}`);
    console.log(`[whalechat] data: ${DATA_DIR}`);
    console.log(`[whalechat] db: ${store.loadedFrom} · rev ${store.rev}`);
    console.log(`[whalechat] storage: ${pool ? 'postgres' : 'file'} · email: ${email && email.configured() ? email.status().provider + ' ' + email.status().from : 'not configured'}`);
  });
})();
let stopping = false;
async function shutdown(signal) {
  if (stopping) return; stopping = true;
  try { market.stop(); } catch (e) {}
  try { if (binance) binance.stop(); } catch (e) {}
  try { if (twelvedata) twelvedata.stop(); } catch (e) {}
  /* let the final batch reach Postgres before the pool closes */
  try { await flushMarketTicks(true); } catch (e) {}
  try { if (b2bAlerts) b2bAlerts.stop(); } catch (e) {}
  try { spot.stopTimers(); } catch (e) {}
  try { bots.stopTimers(); } catch (e) {}
  try { shares.stopTimers(); } catch (e) {}
  console.log(`[whalechat] ${signal} — saving and exiting`);
  try { if (store.db) snapshot('shutdown'); } catch (e) {}
  try { persistNow(); } catch (e) {}
  try { if (appwrite && appwrite.configured() && store.db) await appwrite.backup(store, 'shutdown'); } catch (e) {}
  try { if (pool) pool.end().catch(() => {}); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
