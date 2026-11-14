#!/usr/bin/env node
/* WhaleChat sync server — zero hard dependencies (web-push optional). Node 18+ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
let pool = null;
const BUILD = process.env.APP_BUILD || new Date().toISOString();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const store = { rev: 0, db: null, updatedAt: 0, loadedFrom: 'empty' };
const clients = new Set();

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

/* Compressed HTML cache: the bundle is ~1.4 MB but ~250 KB brotli. The injected
   server marker makes it per-process, so it is cached by file mtime. */
const htmlCache = new Map();
function encodingFor(req) {
  const a = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(a)) return 'br';
  if (/\bgzip\b/.test(a)) return 'gz';
  return '';
}
function compressedHtml(file) {
  const key = file + '|' + PUBLIC_URL;
  let hit = htmlCache.get(key);
  if (hit) return hit;
  const st = fs.statSync(file);
  let html = fs.readFileSync(file, 'utf8');
  if (path.basename(file) === 'whalechat.html') {
    html = html.replace('<head>', '<head>\n<script>window.__WC_SERVER__ = true; window.__WC_PUBLIC_URL__ = ' + JSON.stringify(PUBLIC_URL || '') + ';</script>');
  }
  const raw = Buffer.from(html);
  hit = {
    raw, mtime: st.mtimeMs,
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
    gz: zlib.gzipSync(raw, { level: 6 })
  };
  htmlCache.clear();
  htmlCache.set(key, hit);
  return hit;
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
    const headers = { 'content-type': mime(file), 'content-length': st.size, 'x-content-type-options': 'nosniff', 'vary': 'Accept-Encoding', 'cache-control': isHtml || ext === '.webmanifest' ? 'no-cache' : (rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600') };
    if (isHtml) {
      try {
        const pack = compressedHtml(file);
        const enc = encodingFor(req);
        const body = enc === 'br' ? pack.br : enc === 'gz' ? pack.gz : pack.raw;
        if (enc) headers['content-encoding'] = enc === 'gz' ? 'gzip' : 'br';
        headers['content-length'] = body.length;
        res.writeHead(200, headers);
        return res.end(body);
      } catch (e) {
        return fs.readFile(file, (e2, buf) => {
          if (e2) return notFound(res);
          headers['content-length'] = buf.length;
          res.writeHead(200, headers); res.end(buf);
        });
      }
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const COLLECTIONS = ['users', 'vendors', 'companyProducts', 'products', 'orders', 'deposits', 'withdrawals', 'messages', 'statuses', 'notifications', 'contacts', 'blocks', 'txs', 'referrals', 'purchases', 'refunds', 'vendorApplications', 'reports', 'bonuses', 'bonusClaims', 'emailCampaigns', 'stocks', 'holdings', 'trades', 'watchlist', 'alerts', 'audit', 'portfolioAudit', 'traffic', 'shareInvestments'];

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


/* --------------------------------------------------------------------------
   Auto-generated trade & investment guide. Built from the live database on
   every request, so it always matches the current bot tiers, fees and rules.
   -------------------------------------------------------------------------- */
function buildTradeGuide() {
  const db = store.db || {};
  const bs = db.botSettings || {};
  const tiers = (db.botTiers || []).slice().sort((a, b) => (Number(a.accuracy) || 0) - (Number(b.accuracy) || 0));
  const stocks = db.stocks || [];
  const tradeFee = Number((db.invest && (db.invest.feePct != null ? db.invest.feePct : db.invest.tradeFeePct)) || 0);
  const stamina = (acc) => Math.max(8, Math.min(42, 8 + ((Number(acc) || 0) - 40) * 0.55));
  const cooldown = (acc) => Math.max(15, Math.min(45, Math.round(40 - (Number(acc) || 50) * 0.2)));
  const tierRows = tiers.map((t) => `<tr>
      <td><b>${String(t.name || '').replace(/[<>&]/g, '')}</b><div class="tiny muted">@${String(t.username || 'bot').replace(/[<>&]/g, '')}</div></td>
      <td>${Number(t.accuracy) || 0}%</td>
      <td>$${(Number(t.priceUsd) || 0).toFixed(2)}</td>
      <td>${Math.round(stamina(t.accuracy))} trades</td>
      <td>${cooldown(t.accuracy)} min</td>
    </tr>`).join('');

  const sections = [
    { id: 'overview', title: '1. What WhaleChat is', html: `
      <p>WhaleChat is one app for messaging, a marketplace, a Whale Coin wallet and a simulated investing desk. Everything is priced in <b>Whale Coin (WC)</b>, with a fixed reference rate of <b>1 WC = $0.50 USD</b>. The wallet, marketplace and investing pages all read and write the same balance, so money moves instantly between them.</p>
      <p>Users can chat with contacts, buy from vendors, top up with crypto or bank transfer, and put WC to work in the stock simulator or with automated trading bots.</p>` },
    { id: 'wallet', title: '2. Wallet, deposits and withdrawals', html: `
      <ul>
        <li><b>Deposits</b> — the user picks a crypto or bank method, pays to the company account (QR codes are shown when the admin uploads one) and submits a reference. An admin reviews and approves it; only then is WC credited.</li>
        <li><b>Withdrawals</b> — paid in USDT to the chosen network, protected by the user's withdrawal PIN and reviewed by an admin.</li>
        <li><b>Referrals</b> — a 10 WC bonus is credited after the invited friend's first approved deposit.</li>
        <li><b>Reserved capital</b> — while a trading bot runs, its allocated WC is locked out of the spendable balance and returned when the bot stops.</li>
      </ul>` },
    { id: 'stocks', title: '3. Stock investing flow', html: `
      <p>The Invest tab is a simulated brokerage on top of the wallet.</p>
      <ol>
        <li><b>Explore</b> — the market lists ${stocks.length} instruments with live simulated prices that move every few seconds.</li>
        <li><b>Buy</b> — enter an amount in USD or WC (or a share quantity). The cost, fee and remaining balance are shown before confirming with the transaction PIN.</li>
        <li><b>Hold</b> — shares and average price are stored per user; the portfolio page shows value, daily change, allocation and profit/loss.</li>
        <li><b>Sell</b> — proceeds (minus the same fee) are credited to WC instantly; the trade is recorded with its realised P/L.</li>
        <li><b>Orders</b> — market orders execute immediately; limit orders wait for the target price. History keeps every buy and sell.</li>
      </ol>
      <p>${tradeFee ? 'The current trading fee is <b>' + tradeFee + '%</b> per side, set by the admin.' : 'Trading fees are currently disabled by the admin.'}</p>` },
    { id: 'bots', title: '4. Trading bots and accuracy', html: `
      <p>Bots are subscription products that trade a reserved slice of the user's balance automatically, including while the app is closed. Each bot has an <b>accuracy</b> that is its target win rate.</p>
      <table class="tbl"><thead><tr><th>Bot</th><th>Accuracy</th><th>Price</th><th>Stamina</th><th>Rest</th></tr></thead><tbody>${tierRows}</tbody></table>
      <p><b>How a trade is decided:</b> every interval the bot stakes ${Number(bs.stakePct) || 20}% of its pool. It wins when a random roll is below its <i>effective</i> accuracy and gains ${Number(bs.winPct) || 4}% of the stake; otherwise it loses ${Number(bs.lossPct) || 6}% of the stake. Wins and losses both happen for every bot — accuracy only shifts the odds.</p>
      <p><b>Stamina scales with accuracy.</b> A high-accuracy bot can place far more trades before tiring: roughly <b>${Math.round(stamina(85))}</b> trades at 85% versus <b>${Math.round(stamina(45))}</b> at 45%.</p>` },
    { id: 'health', title: '5. Health, fatigue and cooling down', html: `
      <p>Every trade consumes energy. As energy falls, the bot suffers a <b>fatigue penalty</b>: effective accuracy = accuracy × (0.6 + 0.4 × energy/100). A tired 85% bot behaves like ~51% at zero energy, which is why losses start to outnumber wins when a bot runs too long.</p>
      <p><b>Account health</b> combines energy (70%) with the profit/loss trend (30%) and is charted on the bot profile. Guidance:</p>
      <ul>
        <li><b>65–100%</b> — healthy, let it run.</li>
        <li><b>45–65%</b> — cooling down soon is recommended.</li>
        <li><b>Below 45% or energy below 35%</b> — the <b>Cool down &amp; refresh</b> button appears; stop it before losses grow.</li>
      </ul>
      <p>Cooling down returns the capital, stops trading and enforces a rest of about <b>${cooldown(tiers.length ? tiers[tiers.length - 1].accuracy : 50)}</b> minutes for the strongest bot and longer for weaker ones. After the rest the bot starts again with full energy and normal accuracy. A bot that hits zero energy stops itself to protect the user's balance.</p>` },
    { id: 'admin', title: '6. Admin controls that change this guide', html: `
      <p>This guide is regenerated from the live database, so it updates automatically whenever the admin changes anything:</p>
      <ul>
        <li>Trading bots → accuracy, price, username, picture, HOT flag, interval.</li>
        <li>Bot settings → stake %, win %, loss %, auto-stop threshold, minimum allocation.</li>
        <li>Stocks → listings, prices, paused symbols, trading fee.</li>
        <li>Wallet settings → deposit methods, QR codes, withdrawal networks.</li>
      </ul>
      <p>Current bot defaults: stake <b>${Number(bs.stakePct) || 20}%</b>, win <b>${Number(bs.winPct) || 4}%</b>, loss <b>${Number(bs.lossPct) || 6}%</b>, auto-stop at <b>${Number(bs.minPoolPct) || 10}%</b> of capital, minimum allocation <b>${Number(bs.minCapitalCoins) || 5} WC</b>.</p>` },
    { id: 'risk', title: '7. Risk and compliance notes', html: `
      <p>All stock and bot trading in this build is <b>simulated</b> for demonstration. Accuracy is a target, not a guarantee, and no result is financial advice. Before handling real money, connect a licensed brokerage, add server-side authentication, and review the wallet flow with a compliance advisor.</p>
      <p>Keep the admin password and transaction PINs private; every admin action is written to the audit log.</p>` }
  ];
  return {
    ok: true,
    version: 'guide-' + Date.now(),
    generatedAt: Date.now(),
    stats: { tiers: tiers.length, stocks: stocks.length, feePct: tradeFee },
    sections
  };
}

async function api(req, res, pathname, query) {
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
    broadcast('change', { rev: store.rev, source: body.clientId || null, at: store.updatedAt });
    if (pushes.length) setImmediate(() => dispatchPushes(pushes, store.db).catch(() => {}));
    try { lifecycleEmails(pushes, result.events); } catch (e) { console.error('[email] lifecycle:', e.message); }
    return json(res, 200, { ok: true, rev: store.rev });
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

  // --- auto-updating trading & investment guide -------------------------
  if (pathname === '/api/guide' && req.method === 'GET') {
    try { return json(res, 200, buildTradeGuide()); }
    catch (e) { return json(res, 500, { ok: false, error: e.message }); }
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
  if (pathname === '/api/bots/cool' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    try { return json(res, 200, bots.cool(body)); }
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
