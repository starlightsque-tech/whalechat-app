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

const COLLECTIONS = ['users', 'vendors', 'companyProducts', 'products', 'orders', 'deposits', 'withdrawals', 'messages', 'statuses', 'notifications', 'contacts', 'blocks', 'txs', 'referrals', 'purchases', 'refunds', 'vendorApplications', 'reports', 'bonuses', 'bonusClaims'];
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

async function api(req, res, pathname, query) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, app: 'whalechat', version: readJSON(path.join(PUBLIC_DIR, 'version.json'), {}).version || null, build: (readJSON(path.join(PUBLIC_DIR, 'version.json'), {}).build) || BUILD, uptimeSec: Math.floor((Date.now() - STARTED) / 1000), rev: store.rev, users: (store.db && store.db.users) ? store.db.users.length : 0, clients: clients.size, push: !!webpush, publicUrl: PUBLIC_URL || null, storage: pool ? 'postgres' : 'file', email: !!(email && email.configured()) });
  }
  if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, { rev: store.rev, db: store.db, updatedAt: store.updatedAt });
  if (pathname === '/api/state/init' && req.method === 'POST') {
    if (store.db) return json(res, 409, { ok: false, error: 'already_initialised', rev: store.rev });
    const body = await readBody(req);
    if (!body || !body.db || !Array.isArray(body.db.users)) return json(res, 400, { ok: false, error: 'invalid_db' });
    store.db = body.db; store.rev = Math.max(1, Number(body.rev) || 1); store.updatedAt = Date.now();
    persistNow(); console.log('[db] initialised · users:', store.db.users.length);
    return json(res, 200, { ok: true, rev: store.rev });
  }
  if (pathname === '/api/ops' && req.method === 'POST') {
    if (!store.db) return json(res, 409, { ok: false, error: 'not_initialised' });
    const body = await readBody(req);
    const result = applyOps(store.db, Array.isArray(body.ops) ? body.ops : []);
    const pushes = result.pushes;
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
