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
const { SpotService } = require('./spot');
const { BotService } = require('./bots');
const { ShareService } = require('./shares');
let createConnections = null;
try { createConnections = require('./connections').createConnections; } catch (e) { console.error('[connections] module unavailable:', e.message); }
let createBinanceFeed = null;
try { createBinanceFeed = require('./binance').createBinanceFeed; } catch (e) { console.error('[binance] module unavailable:', e.message); }
let createB2BAlertWatcher = null;
try { createB2BAlertWatcher = require('./b2b-alerts').createB2BAlertWatcher; } catch (e) { console.error('[b2b-alerts] module unavailable:', e.message); }
let createTwelveFeed = null;
try { createTwelveFeed = require('./twelvedata').createTwelveFeed; } catch (e) { console.error('[twelvedata] module unavailable:', e.message); }
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
/* Binance live crypto prices alongside Finnhub (charts stay on Finnhub). */
const binance = createBinanceFeed ? createBinanceFeed({ getDb: () => store.db, everyMs: Number(process.env.BINANCE_MS || 15000), onTick: (sym, price) => { try { market.ingestExternal(sym, price); } catch (e) {} } }) : null;

/* Twelve Data: one REST key for US + global equities, forex and crypto pairs.
   Same contract as the Binance/Alpaca feeds — every quote lands in the shared
   market cache so trades and portfolios use it automatically. */
const twelvedata = createTwelveFeed ? createTwelveFeed({
  getDb: () => store.db,
  everyMs: Number(process.env.TWELVEDATA_MS || 60000),
  maxSymbols: Number(process.env.TWELVEDATA_MAX_SYMBOLS || 40),
  getTickers: () => {
    try {
      return market.assetList()
        .filter((a) => !a.hidden && !a.synthetic)
        .map((a) => String(a.displayTicker || a.ticker || '').toUpperCase())
        .filter(Boolean);
    } catch (e) { return []; }
  },
  onTick: (sym, price) => { try { market.ingestExternal(sym, price); } catch (e) {} }
}) : null;

/* Durable third-party connection settings (Finnhub, Binance, Brevo, SMTP).
   Applied on every boot so a new release never comes up disconnected. */
const connections = createConnections ? createConnections({
  getDb: () => store.db,
  persist: () => persist(),
  dataDir: DATA_DIR,
  market, email, binance, twelvedata,
  log: (m) => console.log(m),
  storageBackend: () => (pool ? 'postgres' : 'file')
}) : null;

/* B2B price alerts: evaluate on the server so email + in-app notification are
   delivered even when the user's app is closed. */
const b2bAlerts = createB2BAlertWatcher ? createB2BAlertWatcher({
  getDb: () => store.db,
  persist: () => persist(),
  broadcast: (event, data) => { try { broadcast(event, data); } catch (e) {} },
  quotes: () => market.quotes || {},
  email,
  appUrl: () => PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT),
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
const clients = new Map();   // res -> { user: <userId|null>, at: <connectedAt> }
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
}
/* Durable storage: optional Postgres (DATABASE_URL) so a redeploy can never
   wipe accounts. The file stays as a fast cache and local backup. */
function pgPersist() {
  if (!pool || !store.db) return;
  const payload = JSON.stringify(store.db);
  pool.query('insert into whalechat_state (id, rev, updated_at, db) values (1,$1,now(),$2::jsonb) on conflict (id) do update set rev=excluded.rev, updated_at=now(), db=excluded.db', [store.rev, payload])
    .catch(e => console.error('[db] postgres write failed:', e.message));
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

async function initStorage() {
  if (!DATABASE_URL) return;
  try {
    const { Pool } = require('pg');
    const needsSsl = /sslmode=require/i.test(DATABASE_URL) || /\.render\.com/i.test(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
    await pool.query('create table if not exists whalechat_state (id int primary key, rev int not null default 0, updated_at timestamptz not null default now(), db jsonb)');
    const r = await pool.query('select rev, db, updated_at from whalechat_state where id = 1');
    if (r.rows[0] && r.rows[0].db) {
      store.rev = r.rows[0].rev || 0;
      store.db = r.rows[0].db;
      store.updatedAt = new Date(r.rows[0].updated_at).getTime() || Date.now();
      store.loadedFrom = 'postgres';
      try { writeJSONAtomic(STATE_FILE, { rev: store.rev, updatedAt: store.updatedAt, db: store.db }); } catch (e) {}
      console.log('[db] loaded from Postgres · rev', store.rev);
    } else if (store.db) {
      pgPersist();
      console.log('[db] seeded Postgres from local state · rev', store.rev);
    }
  } catch (e) {
    console.error('[db] postgres unavailable:', e.message);
    pool = null;
  }
}
loadState();
setInterval(() => snapshot('hourly'), 3600000).unref();

let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }
let vapid = readJSON(VAPID_FILE, null);
let subscriptions = readJSON(SUBS_FILE, []);
if (webpush) {
  if (!vapid || !vapid.publicKey || !vapid.privateKey) { vapid = webpush.generateVAPIDKeys(); writeJSONAtomic(VAPID_FILE, vapid); console.log('[push] generated VAPID keys'); }
  webpush.setVapidDetails('mailto:' + VAPID_EMAIL, vapid.publicKey, vapid.privateKey);
} else { console.log('[push] web-push not installed — push disabled'); }
const saveSubs = () => { try { writeJSONAtomic(SUBS_FILE, subscriptions); } catch (e) {} };

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
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
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
/* signup email verification: email -> {hash, sentAt, exp, tries, sends} */
const SIGNUP_CODES = new Map();
function signupCodeHash(emailAddr, code) {
  return require('crypto').createHash('sha256').update('signup::v1::' + String(emailAddr).toLowerCase() + '::' + String(code)).digest('hex');
}
function maskEmail(e) {
  return String(e || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
}
function frameOf(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
}
function broadcast(event, data) {
  const frame = frameOf(event, data);
  for (const res of clients.keys()) { try { res.write(frame); } catch (e) {} }
}
/* Deliver only to the devices of the listed users — chat traffic must never be
   fanned out to every connected client. */
function broadcastTo(userIds, event, data) {
  const want = new Set((userIds || []).filter(Boolean));
  if (!want.size) return 0;
  const frame = frameOf(event, data);
  let sent = 0;
  for (const [res, meta] of clients) {
    if (!meta || !want.has(meta.user)) continue;
    try { res.write(frame); sent++; } catch (e) {}
  }
  return sent;
}
function isOnline(userId) {
  for (const meta of clients.values()) if (meta && meta.user === userId) return true;
  return false;
}

/* ============================ presence engine ============================ */
const PRESENCE = new Map();              // userId -> { ts, lastSeen, currentChatWith, device, visible }
const PRESENCE_STALE_MS = 35000;         // no heartbeat for 35 s -> offline
let presencePersistAt = 0;

function presenceView(userId) {
  const id = String(userId || '');
  const p = PRESENCE.get(id);
  const fresh = !!(p && Date.now() - Number(p.ts) < PRESENCE_STALE_MS);
  const online = fresh && p.visible !== false && (p.sockets > 0 || Date.now() - Number(p.ts) < PRESENCE_STALE_MS) && isOnline(id);
  const stored = (store.db && store.db.presence && store.db.presence[id]) || null;
  return {
    userId: id,
    online,
    lastSeen: online ? Date.now() : Math.max(Number(p && p.lastSeen) || 0, Number(stored && stored.lastSeen) || 0),
    currentChatWith: (p && p.currentChatWith) || (stored && stored.currentChatWith) || ''
  };
}
/* who cares about this user's presence: their chat partners + themselves */
function presenceAudience(userId) {
  const ids = new Set([String(userId)]);
  const db = store.db || {};
  (db.messages || []).forEach((m) => {
    if (!m) return;
    if (m.from === userId && m.to) ids.add(String(m.to));
    else if (m.to === userId && m.from) ids.add(String(m.from));
  });
  ((db.contacts) || []).forEach((c) => {
    if (!c) return;
    if (c.ownerId === userId && c.userId) ids.add(String(c.userId));
    else if (c.userId === userId && c.ownerId) ids.add(String(c.ownerId));
  });
  return [...ids];
}
function persistPresence(userId, view) {
  try {
    if (!store.db) return;
    if (!store.db.presence || typeof store.db.presence !== 'object') store.db.presence = {};
    store.db.presence[userId] = { lastSeen: view.lastSeen, currentChatWith: view.currentChatWith };
    const t = Date.now();
    if (t - presencePersistAt > 5000) { presencePersistAt = t; persist(); }
  } catch (e) {}
}
function broadcastPresence(userId) {
  const view = presenceView(userId);
  try { broadcastTo(presenceAudience(userId), 'presence', { presence: view, at: Date.now() }); } catch (e) {}
  persistPresence(userId, view);
  return view;
}
function touchPresence(userId, patch) {
  const id = String(userId || '');
  if (!id) return null;
  const prev = PRESENCE.get(id) || { ts: 0, lastSeen: 0, currentChatWith: '', device: '', visible: true, sockets: 0 };
  const next = Object.assign({}, prev, patch || {}, { ts: Date.now() });
  next.sockets = countSockets(id);
  PRESENCE.set(id, next);
  return broadcastPresence(id);
}
function markPresenceOffline(userId) {
  const id = String(userId || '');
  const prev = PRESENCE.get(id);
  if (!prev) { PRESENCE.set(id, { ts: 0, lastSeen: Date.now(), currentChatWith: '', device: '', visible: false, sockets: 0 }); return broadcastPresence(id); }
  prev.ts = 0; prev.visible = false; prev.lastSeen = Date.now(); prev.currentChatWith = '';
  PRESENCE.set(id, prev);
  return broadcastPresence(id);
}
function countSockets(userId) {
  let n = 0;
  for (const meta of clients.values()) if (meta && meta.user === userId) n++;
  return n;
}
/* silence sweeper: a phone that lost its network without closing the tab */
setInterval(() => {
  const now = Date.now();
  PRESENCE.forEach((p, id) => {
    if (!p) return;
    const live = now - Number(p.ts) < PRESENCE_STALE_MS;
    if (!live && (p.visible !== false || p.sockets)) {
      p.visible = false; p.sockets = 0; p.lastSeen = now; p.currentChatWith = '';
      PRESENCE.set(id, p);
      try { broadcastPresence(id); } catch (e) {}
    }
  });
}, 10000).unref();
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

function isAdmin(db, adminId) {
  return !!(db && Array.isArray(db.users) && db.users.some((u) => u && u.id === adminId && u.role === 'admin'));
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
      if (i >= 0) {
        /* verification is monotonic: a stale device must never clear it */
        if (op.col === 'users' && arr[i] && arr[i].verified === true) {
          op.item.verified = true;
          op.item.emailVerified = true;
          if (!op.item.verifiedAt) op.item.verifiedAt = arr[i].verifiedAt || Date.now();
        }
        arr[i] = op.item;
      } else arr.push(op.item);
      pushes.push({ col: op.col, item: op.item, isNew: i < 0 });
    } else if (op.op === 'update' && op.id) {
      const i = arr.findIndex(x => x && x.id === op.id);
      if (i >= 0) {
        const before = arr[i] ? arr[i].status : null;
        if (op.col === 'users' && arr[i] && arr[i].verified === true) {
          op.patch = Object.assign({}, op.patch, { verified: true, emailVerified: true });
          if (!op.patch.verifiedAt) op.patch.verifiedAt = arr[i].verifiedAt || Date.now();
        }
        arr[i] = Object.assign({}, arr[i], op.patch || {});
        if (op.patch && op.patch.status && op.patch.status !== before) events.push({ col: op.col, item: arr[i], from: before, to: op.patch.status });
      } else if (op.patch && op.patch.id) arr.push(op.patch);
    } else if (op.op === 'remove' && op.id) {
      const i = arr.findIndex(x => x && x.id === op.id); if (i >= 0) arr.splice(i, 1);
    }
  }
  return { pushes, events };
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

/* everything addressed to `userId` that was still 'sent' is now on their device */
function markMessagesDelivered(userId) {
  if (!store.db || !Array.isArray(store.db.messages)) return 0;
  const changed = [];
  store.db.messages.forEach((m) => {
    if (!m || m.to !== userId || m.status === 'seen' || m.status === 'delivered') return;
    m.status = 'delivered';
    m.deliveredAt = m.deliveredAt || Date.now();
    changed.push(m);
  });
  if (!changed.length) return 0;
  store.rev += 1; store.updatedAt = Date.now(); persist();
  const senders = new Set(changed.map((m) => m.from).filter(Boolean));
  changed.forEach((m) => {
    try { broadcastTo([m.from], 'delivered', { chatId: m.chatId, userId, ids: [m.id], at: Date.now(), rev: store.rev }); } catch (e) {}
  });
  return changed.length;
}

async function api(req, res, pathname, query) {
  /* --- durable connection settings (admin only) -------------------------- */
  if (pathname === '/api/connections' && req.method === 'GET') {
    const adminId = query.get('adminId') || '';
    const admin = (store.db && Array.isArray(store.db.users)) ? store.db.users.find(u => u.id === adminId && u.role === 'admin') : null;
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, connections ? connections.status() : { ok: false, error: 'connections_disabled' });
  }
  if (pathname === '/api/connections' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = (store.db && Array.isArray(store.db.users)) ? store.db.users.find(u => u.id === body.adminId && u.role === 'admin') : null;
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    if (!connections) return json(res, 503, { ok: false, error: 'connections_disabled' });
    try { return json(res, 200, connections.saveFrom(body)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/connections/test' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = (store.db && Array.isArray(store.db.users)) ? store.db.users.find(u => u.id === body.adminId && u.role === 'admin') : null;
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
      try {
        out.results.twelvedata = twelvedata ? await twelvedata.poll() : { error: 'twelvedata_disabled' };
      } catch (e) { out.results.twelvedata = { error: e.message }; }
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
    const admin = (store.db.users || []).find(u => u.id === body.adminId && u.role === 'admin');
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
    return json(res, 200, { ok: true, app: 'whalechat', version: readJSON(path.join(PUBLIC_DIR, 'version.json'), {}).version || null, build: (readJSON(path.join(PUBLIC_DIR, 'version.json'), {}).build) || BUILD, uptimeSec: Math.floor((Date.now() - STARTED) / 1000), rev: store.rev, users: (store.db && store.db.users) ? store.db.users.length : 0, clients: clients.size, push: !!webpush, publicUrl: PUBLIC_URL || null, storage: pool ? 'postgres' : 'file', email: !!(email && email.configured()), market: market.status() });
  }
  if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, { rev: store.rev, db: store.db, updatedAt: store.updatedAt });
  if (pathname === '/api/state/init' && req.method === 'POST') {
    if (store.db) return json(res, 409, { ok: false, error: 'already_initialised', rev: store.rev });
    const body = await readBody(req);
    if (!body || !body.db || !Array.isArray(body.db.users)) return json(res, 400, { ok: false, error: 'invalid_db' });
    store.db = body.db; store.rev = Math.max(1, Number(body.rev) || 1); store.updatedAt = Date.now();
    ensureTradingAssets();
    ensureServices(store.db);
    persistNow(); console.log('[db] initialised · users:', store.db.users.length);
    return json(res, 200, { ok: true, rev: store.rev });
  }
  if (pathname === '/api/ops' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const result = applyOps(store.db, Array.isArray(body.ops) ? body.ops : []);
    const pushes = result.pushes;
    if (Array.isArray(body.ops) && body.ops.some((o) => o && o.col === 'stocks')) {
      setImmediate(() => { try { market.onAssetsChanged(); } catch (e) { console.error('[market] asset refresh:', e.message); } });
    }
    store.rev += 1; store.updatedAt = Date.now(); persist();
    const onlyMessages = Array.isArray(body.ops) && body.ops.length > 0 && body.ops.every((o) => o && o.col === 'messages');
    broadcast('change', { rev: store.rev, source: body.clientId || null, at: store.updatedAt, messagesOnly: onlyMessages });
    /* a message written through the generic state path still has to land on the
       other participant instantly — otherwise the chat would wait for a full
       state download (the old 3-5s behaviour). */
    if (onlyMessages) {
      const users = new Set();
      const items = result.pushes.map((p) => p.item).filter((m) => m && m.id && m.chatId && m.from);
      items.forEach((m) => { users.add(m.from); if (m.to) users.add(m.to); });
      items.forEach((m) => {
        broadcastTo([m.from, m.to].filter(Boolean), 'message', { message: m, rev: store.rev, at: Date.now() });
      });
      if (items.length) broadcastTo([...users], 'messages-committed', { ids: items.map((m) => m.id), rev: store.rev });
    }
    if (pushes.length) setImmediate(() => dispatchPushes(pushes, store.db).catch(() => {}));
    try { lifecycleEmails(pushes, result.events); } catch (e) { console.error('[email] lifecycle:', e.message); }
    return json(res, 200, { ok: true, rev: store.rev });
  }
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*' });
    res.write('retry: 1500\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ rev: store.rev, at: Date.now() })}\n\n`);
    const userId = String(query.get('user') || '') || null;
    clients.set(res, { user: userId, at: Date.now() });
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    if (userId) {
      /* the socket itself is the online signal: announce it straight away and
         hand the newcomer the presence of everyone they talk to */
      const snap = {};
      const ids = new Set(presenceAudience(userId));
      ids.forEach((id) => { snap[id] = presenceView(id); });
      try { res.write('event: presence-snapshot\ndata: ' + JSON.stringify({ at: Date.now(), presence: snap }) + '\n\n'); } catch (e) {}
      try { touchPresence(userId, { visible: true }); } catch (e) {}
      /* everything the recipient received while this user was away is now delivered */
      try { markMessagesDelivered(userId); } catch (e) {}
    }
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      if (userId && countSockets(userId) === 0) { try { markPresenceOffline(userId); } catch (e) {} }
    });
    return;
  }

  /* ---------------- presence + typing (realtime, no polling) ----------------
     Online state used to be a localStorage guess, so another user could never
     appear online and typing only worked between tabs of the same browser.
     It now lives on the server and is pushed over the same SSE stream:
       - heartbeat every 15 s from the client (POST /api/presence)
       - the open SSE socket is the source of truth; closing it marks the user
         offline immediately, and a 35 s silence marks them offline as well
       - typing is a short-lived flag pushed straight to the other participant
     Nothing here needs polling, and both events reach the other device in a
     few milliseconds because they share the message fan-out. */
  if (pathname === '/api/presence' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = String(body.userId || '');
    if (!userId) return json(res, 400, { ok: false, error: 'userId_required' });
    touchPresence(userId, {
      currentChatWith: body.currentChatWith == null ? undefined : String(body.currentChatWith || ''),
      device: body.device == null ? undefined : String(body.device || '').slice(0, 120),
      visible: body.visible === undefined ? undefined : !!body.visible
    });
    return json(res, 200, { ok: true, presence: presenceView(userId), online: isOnline(userId) });
  }
  if (pathname === '/api/presence/offline' && req.method === 'POST') {
    const body = await readBody(req);
    if (body && body.userId) markPresenceOffline(String(body.userId));
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/typing' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = String(body.userId || '');
    const to = String(body.to || '');
    const chatId = String(body.chatId || '');
    if (!userId || !chatId) return json(res, 400, { ok: false, error: 'invalid_typing' });
    /* typing is ephemeral: never stored, never persisted */
    const payload = { chatId, from: userId, to, isTyping: !!body.isTyping, at: Date.now() };
    const targets = [to, userId].filter(Boolean);
    broadcastTo(targets, 'typing', payload);
    return json(res, 200, { ok: true, at: payload.at });
  }
  if (pathname === '/api/presence/state' && req.method === 'GET') {
    const ids = String(query.get('users') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200);
    const out = {};
    ids.forEach((id) => { out[id] = presenceView(id); });
    return json(res, 200, { ok: true, at: Date.now(), presence: out });
  }

  /* ---------------- instant chat: message-level realtime API ----------------
     The chat client never waits for a full state download. A message is written
     with the id the sender already generated (idempotent retries), then pushed to
     exactly the two participants over SSE. */
  if (pathname === '/api/messages/send' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const msg = body && body.message;
    if (!msg || !msg.id || !msg.chatId || !msg.from) return json(res, 400, { ok: false, error: 'invalid_message' });
    if (!Array.isArray(store.db.messages)) store.db.messages = [];
    const existing = store.db.messages.find((m) => m && m.id === msg.id);
    if (existing) {
      return json(res, 200, { ok: true, duplicate: true, id: msg.id, rev: store.rev, status: existing.status || 'sent' });
    }
    const sender = (store.db.users || []).find((u) => u.id === msg.from);
    if (!sender) return json(res, 403, { ok: false, error: 'unknown_sender' });
    const clean = Object.assign({}, msg, {
      id: String(msg.id).slice(0, 120),
      chatId: String(msg.chatId).slice(0, 200),
      status: 'sent',
      serverAt: Date.now(),
      deleted: false,
      readBy: Array.isArray(msg.readBy) ? msg.readBy : []
    });
    delete clean.tempId;
    delete clean.queuedAt;
    delete clean.attempts;
    store.db.messages.push(clean);
    store.rev += 1; store.updatedAt = Date.now(); persist();
    const recipients = [clean.from, clean.to].filter(Boolean);
    /* if the other device is connected right now the message is delivered the
       instant it lands, so the sender sees double grey ticks without waiting
       for the recipient to open the app */
    if (clean.to && clean.from !== clean.to && isOnline(clean.to)) {
      clean.status = 'delivered';
      clean.deliveredAt = Date.now();
    }
    const delivered = broadcastTo(recipients, 'message', { message: clean, rev: store.rev, at: Date.now() });
    if (clean.status === 'delivered') {
      try { broadcastTo([clean.from], 'delivered', { chatId: clean.chatId, userId: clean.to, ids: [clean.id], at: Date.now(), rev: store.rev }); } catch (e) {}
    }
    return json(res, 200, { ok: true, id: clean.id, rev: store.rev, status: clean.status, online: recipients.map((u) => ({ user: u, online: isOnline(u) })), fanout: delivered });
  }
  if (pathname === '/api/messages/list' && req.method === 'GET') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const chatId = String(query.get('chatId') || '');
    const userId = String(query.get('user') || '');
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
    const since = Number(query.get('since')) || 0;
    let rows = (store.db.messages || []).filter((m) => m && (!chatId || m.chatId === chatId) && (Number(m.createdAt) || 0) > since);
    if (userId) rows = rows.filter((m) => m.from === userId || m.to === userId);
    rows = rows.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    return json(res, 200, { ok: true, at: Date.now(), rev: store.rev, messages: rows.slice(-limit) });
  }
  if (pathname === '/api/messages/ack' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const chatId = String(body.chatId || '');
    const userId = String(body.userId || '');
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
    const kind = body.kind === 'read' ? 'read' : 'delivered';
    if (!chatId || !userId) return json(res, 400, { ok: false, error: 'invalid_ack' });
    const changed = [];
    (store.db.messages || []).forEach((m) => {
      if (!m || m.chatId !== chatId || !ids.includes(m.id)) return;
      if (kind === 'read') {
        m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
        if (!m.readBy.includes(userId)) m.readBy.push(userId);
        if (m.to === userId) m.status = 'seen';
        m.seenAt = m.seenAt || Date.now();
      } else if (m.status !== 'seen') {
        m.status = 'delivered';
        m.deliveredAt = m.deliveredAt || Date.now();
      }
      changed.push(m);
    });
    if (!changed.length) return json(res, 200, { ok: true, changed: 0 });
    store.rev += 1; store.updatedAt = Date.now(); persist();
    const targets = new Set();
    changed.forEach((m) => { if (m.from !== userId) targets.add(m.from); });
    broadcastTo([...targets], kind === 'read' ? 'read' : 'delivered', { chatId, userId, ids: changed.map((m) => m.id), at: Date.now(), rev: store.rev });
    return json(res, 200, { ok: true, changed: changed.length, rev: store.rev });
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
    const tickers = raw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 120);
    const limit = Number(query.get('limit')) || 600;
    return json(res, 200, {
      ok: true, at: Date.now(), source: market.source(), notice: market.notice(),
      status: market.status(), history: market.historyFor(tickers, limit)
    });
  }
  if (pathname === '/api/market/status' && req.method === 'GET') {
    return json(res, 200, Object.assign({ ok: true }, market.status()));
  }
  if (pathname === '/api/market/config' && req.method === 'GET') {
    const adminId = query.get('adminId') || '';
    const admin = (store.db && Array.isArray(store.db.users)) ? store.db.users.find(u => u.id === adminId && u.role === 'admin') : null;
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, market.publicConfig());
  }
  if (pathname === '/api/market/config' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = (store.db && Array.isArray(store.db.users)) ? store.db.users.find(u => u.id === body.adminId && u.role === 'admin') : null;
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
    const admin = (store.db && Array.isArray(store.db.users)) ? store.db.users.find(u => u.id === adminId && u.role === 'admin') : null;
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    try {
      const results = await market.searchAssets(query.get('q') || '', query.get('class') || 'us');
      return json(res, 200, { ok: true, results });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/market/assets/add' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = (store.db && Array.isArray(store.db.users)) ? store.db.users.find(u => u.id === body.adminId && u.role === 'admin') : null;
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    try {
      const out = await market.addAsset(body.class || body.assetClass, body.symbol);
      return json(res, 200, Object.assign({ ok: true }, out));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/market/dividends/sync' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = (store.db && Array.isArray(store.db.users)) ? store.db.users.find(u => u.id === body.adminId && u.role === 'admin') : null;
    if (!admin) return json(res, 403, { ok: false, error: 'admin_only' });
    const status = await market.syncDividends(true);
    return json(res, 200, { ok: true, status });
  }
  if (pathname === '/api/market/test' && req.method === 'POST') {
    const body = await readBody(req);
    const admin = (store.db && Array.isArray(store.db.users)) ? store.db.users.find(u => u.id === body.adminId && u.role === 'admin') : null;
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
  /* --- signup email verification (6-digit code, full-screen page) --------
     Flow: signup -> code emailed -> full-screen verify page -> account marked
     verified. The account is not treated as usable until the code matches.
     Codes are stored hashed, never returned to a browser, and are limited by
     a 60s resend cooldown, 5 sends per hour and 6 wrong guesses. */
  if (pathname === '/api/verify/signup/send' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const emailAddr = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailAddr)) return json(res, 400, { ok: false, error: 'bad_email', message: 'Enter a valid email address' });
    const user = (store.db.users || []).find((u) => String(u.email || '').trim().toLowerCase() === emailAddr);
    if (!user) return json(res, 404, { ok: false, error: 'user_missing', message: 'Account not found yet — please try again in a moment' });
    if (user.emailVerified === true || user.verified === true) return json(res, 409, { ok: false, error: 'already_verified', message: 'This account is already verified' });
    const now = Date.now();
    const prev = SIGNUP_CODES.get(emailAddr);
    if (prev && now - prev.sentAt < 60000) {
      return json(res, 429, { ok: false, error: 'too_soon', message: 'Please wait before requesting another code', retryIn: Math.ceil((60000 - (now - prev.sentAt)) / 1000) });
    }
    const sends = (prev && now - prev.windowStart < 3600000) ? (prev.sends || 0) : 0;
    if (sends >= 5) return json(res, 429, { ok: false, error: 'too_many', message: 'Too many codes requested. Try again in an hour.' });
    const code = String(require('crypto').randomInt(100000, 1000000));
    SIGNUP_CODES.set(emailAddr, {
      hash: signupCodeHash(emailAddr, code),
      sentAt: now,
      windowStart: (prev && now - prev.windowStart < 3600000) ? prev.windowStart : now,
      sends: sends + 1,
      exp: now + 15 * 60000,
      tries: 0,
      userId: user.id
    });
    const appUrl = PUBLIC_URL || ('http://localhost:' + PORT);
    const mailReady = !!(email && email.configured && email.configured());
    let queued = false;
    if (mailReady) {
      queued = !!email.enqueue({ key: null, to: user.email, template: 'verifyCode', data: { code, name: user.fullName || user.username, purposeLabel: 'your WhaleChat account', purposeRoute: 'signup' }, appUrl });
    }
    /* never leak the code to the browser; the admin sees delivery status */
    console.log('[verify] signup code for ' + emailAddr.slice(0, 2) + '*** queued=' + queued + ' mailReady=' + mailReady);
    if (!mailReady) {
      return json(res, 503, { ok: false, error: 'email_not_configured', message: 'Email sending is not configured yet. An admin must connect Brevo or SMTP in Admin → Servers.', to: maskEmail(emailAddr) });
    }
    return json(res, 200, { ok: true, queued, to: maskEmail(emailAddr), expiresIn: 900, attemptsLeft: 6 });
  }
  if (pathname === '/api/verify/signup/confirm' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const emailAddr = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').replace(/\D/g, '');
    const rec = SIGNUP_CODES.get(emailAddr);
    if (!rec) return json(res, 400, { ok: false, error: 'no_code', message: 'Request a verification code first' });
    if (Date.now() > rec.exp) { SIGNUP_CODES.delete(emailAddr); return json(res, 400, { ok: false, error: 'expired', message: 'That code has expired — send a new one' }); }
    if (rec.tries >= 6) { SIGNUP_CODES.delete(emailAddr); return json(res, 429, { ok: false, error: 'locked', message: 'Too many attempts — send a new code' }); }
    if (code.length !== 6 || signupCodeHash(emailAddr, code) !== rec.hash) {
      rec.tries += 1;
      const left = Math.max(0, 6 - rec.tries);
      return json(res, 400, { ok: false, error: 'invalid', message: 'That code is not correct', attemptsLeft: left });
    }
    const user = (store.db.users || []).find((u) => String(u.email || '').trim().toLowerCase() === emailAddr) || (rec.userId ? (store.db.users || []).find((u) => u.id === rec.userId) : null);
    if (!user) return json(res, 404, { ok: false, error: 'user_missing' });
    const now = Date.now();
    user.verified = true;
    user.emailVerified = true;
    user.verifiedAt = now;
    user.verificationMethod = 'email_code';
    delete user.emailVerifyRequired;
    SIGNUP_CODES.delete(emailAddr);
    store.rev += 1; store.updatedAt = now; persistNow();
    broadcast('change', { rev: store.rev, source: 'signup-verified', at: now });
    (store.db.notifications = store.db.notifications || []).unshift({ id: 'nt_' + now.toString(36) + Math.random().toString(36).slice(2, 7), userId: user.id, title: 'Email verified ✅', body: 'Your account is verified. Welcome to WhaleChat.', link: '#/account', icon: 'shield', read: false, createdAt: now });
    persistNow();
    console.log('[verify] signup verified @' + (user.username || user.id));
    /* The welcome mail goes out now that the address is proven — separate key
       from the signup notice so it is never deduped away. */
    try {
      if (email && email.enqueue) {
        const appUrl = PUBLIC_URL || ('http://localhost:' + PORT);
        email.enqueue({ key: 'welcome-verified:' + user.id, to: user.email, template: 'welcome', data: user, appUrl });
      }
    } catch (e) { console.error('[email] welcome-after-verify:', e.message); }
    return json(res, 200, { ok: true, verifiedAt: now, userId: user.id, username: user.username || '', role: user.role || 'user' });
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
  // --- email -----------------------------------------------------------
  if (pathname === '/api/email/status' && req.method === 'GET') {
    return json(res, 200, email ? email.status() : { ok: true, configured: false, queued: 0 });
  }
  if (pathname === '/api/email/broadcast' && req.method === 'POST') {
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
    const admin = (db.users || []).find(u => u.id === body.adminId && u.role === 'admin');
    if (!admin) return json(res, 403, { ok: false, error: 'admin only' });
    try {
      const file = path.join(DATA_DIR, 'mail.json');
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
      if (body.brevoKey) cur.brevoKey = String(body.brevoKey).trim();
      if (body.from) cur.from = String(body.from).trim();
      if (body.fromName) cur.fromName = String(body.fromName).trim();
      if (body.resendKey) cur.resendKey = String(body.resendKey).trim();
      cur.updatedAt = new Date().toISOString();
      writeJSONAtomic(file, cur);
      if (cur.brevoKey) process.env.BREVO_API_KEY = cur.brevoKey;
      if (cur.from) process.env.MAIL_FROM = cur.from;
      return json(res, 200, { ok: true, configured: email.configured(), from: cur.from || null });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/reload' && req.method === 'POST') {
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
    try {
      const out = spot.buy(body);
      return json(res, 200, Object.assign({ ok: true }, out));
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (pathname === '/api/market/spot/sell' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
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
    try { return json(res, 200, shares.savePlans(body)); }
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
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-max-age': '86400' });
    return res.end();
  }
  if (pathname.startsWith('/api/')) {
    try { return await api(req, res, pathname, u.searchParams); }
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
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
(async () => {
  await initStorage();
  ensureTradingAssets();
  const durableMarket = await loadMarketConfig();
  if (durableMarket) {
    market.hydrateConfig(durableMarket);
    console.log('[market] restored durable config · mode', durableMarket.mode || 'simulated', '· key', durableMarket.apiKey ? 'set' : 'not set');
  }
  market.start();
  if (binance) { binance.start(); console.log('[binance] live crypto price feed started'); }
  if (twelvedata) { twelvedata.start(); console.log('[twelvedata] price feed started'); }
  if (connections) { try { connections.boot(); } catch (e) { console.error('[connections] boot:', e.message); } }
  if (b2bAlerts) { b2bAlerts.start(); console.log('[b2b-alerts] watcher started (email + in-app)'); }
  ensureServices(store.db);
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
function shutdown(signal) {
  if (stopping) return; stopping = true;
  try { market.stop(); } catch (e) {}
  try { if (binance) binance.stop(); } catch (e) {}
  try { if (twelvedata) twelvedata.stop(); } catch (e) {}
  try { if (b2bAlerts) b2bAlerts.stop(); } catch (e) {}
  try { spot.stopTimers(); } catch (e) {}
  try { bots.stopTimers(); } catch (e) {}
  try { shares.stopTimers(); } catch (e) {}
  console.log(`[whalechat] ${signal} — saving and exiting`);
  try { if (store.db) snapshot('shutdown'); } catch (e) {}
  try { persistNow(); } catch (e) {}
  try { if (pool) pool.end().catch(() => {}); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
