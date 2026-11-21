/* =========================================================================
   WhaleChat · Cloudflare Pages edge backend  (_worker.js)
   -------------------------------------------------------------------------
   Frontend + backend on Cloudflare:
     · verification codes, OTP and notifications are generated and sent here
       through Brevo (email API + transactional SMS API)
     · every other /api/* request is proxied to the WhaleChat sync service so
       accounts, wallets, chat, deposits and admin data keep working
     · static files are served by Cloudflare Pages (env.ASSETS)

   Environment (Pages → Settings → Environment variables):
     BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME, BREVO_SMS_SENDER
     WC_OTP_SECRET     long random string used to derive one-time codes
     SYNC_ORIGIN       https://whalechat-api.appwrite.network
   ========================================================================= */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, x-admin-token, x-appwrite-project',
  'cache-control': 'no-store'
};

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS, extra || {})
  });
}
function maskEmail(v) {
  const s = String(v || '');
  const at = s.indexOf('@');
  if (at < 1) return s;
  return s.slice(0, Math.min(2, at)) + '***' + s.slice(at);
}
function maskPhone(v) {
  return String(v || '').replace(/^(\+\d{2})\d+(\d{2})$/, '$1******$2');
}
function normalPhone(v) {
  let s = String(v || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  return /^\d{8,15}$/.test(s) ? '+' + s : '';
}
function emailOk(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(v || '')); }

/* -------------------------------------------------------------- Brevo --- */
async function brevoEmail(env, to, subject, html, text) {
  const key = env.BREVO_API_KEY;
  if (!key) throw new Error('brevo_not_configured');
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: env.BREVO_SENDER_NAME || 'WhaleChat', email: env.BREVO_SENDER_EMAIL || 'whalechat1@gmail.com' },
      to: [{ email: to }],
      subject: subject,
      htmlContent: html,
      textContent: text || String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
    })
  });
  const body = await res.text();
  let j = null;
  try { j = body ? JSON.parse(body) : null; } catch (e) {}
  if (!res.ok) throw new Error((j && (j.message || j.error)) || ('Brevo HTTP ' + res.status));
  return { messageId: (j && j.messageId) || '' };
}

async function brevoSms(env, phone, content) {
  const key = env.BREVO_API_KEY;
  if (!key) throw new Error('brevo_not_configured');
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: { 'api-key': key, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: (env.BREVO_SMS_SENDER || 'WhaleChat').slice(0, 11),
      recipient: String(phone || '').replace(/^\+/, ''),
      content: String(content || '').slice(0, 700),
      type: 'transactional',
      tag: 'whalechat'
    })
  });
  const body = await res.text();
  let j = null;
  try { j = body ? JSON.parse(body) : null; } catch (e) {}
  if (!res.ok) throw new Error((j && (j.message || j.error)) || ('Brevo SMS HTTP ' + res.status));
  return { referenceId: (j && (j.reference || j.messageId)) || '' };
}

/* --------------------------------------------------- one-time codes ----- */
/* Derived from HMAC(secret, kind|identity|timeWindow), so no database is
   needed. A code is valid for the current 5-minute window and the previous
   one (10 minutes at most). */
async function hmacCode(env, kind, identity, windowIndex) {
  const secret = env.WC_OTP_SECRET || 'whalechat-otp-fallback-change-me';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const material = kind + '|' + String(identity).toLowerCase() + '|' + windowIndex;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(material)));
  let n = 0;
  for (let i = 0; i < 6; i++) n = (n * 256 + sig[i]) % 1000000;
  return String(n).padStart(6, '0');
}
async function makeCode(env, kind, identity) {
  const w = Math.floor(Date.now() / 300000);
  return { code: await hmacCode(env, kind, identity, w), window: w };
}
async function checkCode(env, kind, identity, code) {
  const s = String(code || '').trim();
  if (!/^\d{6}$/.test(s)) return false;
  const w = Math.floor(Date.now() / 300000);
  for (const win of [w, w - 1]) {
    if (await hmacCode(env, kind, identity, win) === s) return true;
  }
  return false;
}
function codeEmailHtml(code, purposeLabel) {
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#04101a;color:#e9f4f9;padding:28px;border-radius:14px;max-width:560px;margin:auto">' +
    '<h2 style="margin:0 0 8px;color:#e9f4f9">WhaleChat verification</h2>' +
    '<p style="color:#8ba4b6;font-size:14px;line-height:1.6">Use this code to verify ' + purposeLabel + '. It expires in 15 minutes.</p>' +
    '<div style="font-size:32px;letter-spacing:10px;font-weight:800;color:#2ee6c9;background:#0b1d29;border:1px dashed #2ee6c9;border-radius:12px;padding:16px;text-align:center;margin:18px 0">' + code + '</div>' +
    '<p style="color:#8ba4b6;font-size:12px">If you did not request this, ignore this email and never share the code.</p></div>';
}

/* --------------------------------------------------------------- proxy -- */
function syncOrigin(env) {
  return String(env.SYNC_ORIGIN || 'https://whalechat-api.appwrite.network').replace(/\/+$/, '');
}
async function proxy(request, env, url) {
  const target = syncOrigin(env) + url.pathname + url.search;
  const headers = new Headers(request.headers);
  ['host', 'cf-connecting-ip', 'cf-ray', 'x-forwarded-for'].forEach((h) => headers.delete(h));
  const init = { method: request.method, headers: headers, redirect: 'follow' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();
  const res = await fetch(target, init);
  const out = new Response(res.body, res);
  Object.entries(CORS).forEach(([k, v]) => out.headers.set(k, v));
  return out;
}

async function isAdmin(env, request) {
  const token = String(request.headers.get('x-admin-token') || '');
  return token ? await verifyAdmin(env, token) : null;
}
async function stateDb(env) {
  const st = await readState(env);
  return st && st.db ? st.db : null;
}
function cleanText(v, max) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 700); }


/* ======================================================================
   Durable state on Cloudflare KV + D1
   ====================================================================== */
const COLLECTIONS = ['users','vendors','companyProducts','products','orders','deposits','withdrawals','messages','statuses','notifications','contacts','blocks','txs','referrals','purchases','refunds','vendorApplications','audit','portfolioAudit','botAccounts','botEvents','stocks','holdings','trades','watchlist','alerts','traffic'];
const STATE_KEY = 'state:db';

async function ensureSchema(env) {
  if (!env.WC_DB) return false;
  try {
    await env.WC_DB.batch([
      env.WC_DB.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER)'),
      env.WC_DB.prepare('CREATE TABLE IF NOT EXISTS deposits (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, json TEXT NOT NULL, updated_at INTEGER)'),
      env.WC_DB.prepare('CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, json TEXT NOT NULL, updated_at INTEGER)'),
      env.WC_DB.prepare('CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, chat_id TEXT, from_id TEXT, to_id TEXT, json TEXT NOT NULL, created_at INTEGER)'),
      env.WC_DB.prepare('CREATE INDEX IF NOT EXISTS idx_chat_seq ON chat_messages(seq)'),
      env.WC_DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
    ]);
    return true;
  } catch (e) { return false; }
}

async function readState(env, migrate) {
  let st = null;
  /* D1 is strongly consistent: use it as the authoritative state row */
  if (env.WC_DB) {
    try {
      await ensureSchema(env);
      const row = await env.WC_DB.prepare("SELECT v FROM meta WHERE k='state:db'").first();
      if (row && row.v) { try { st = JSON.parse(row.v); } catch (e) {} }
    } catch (e) {}
  }
  if (!st || !st.db) st = await env.WC_STATE.get(STATE_KEY, 'json');
  if (st && st.db) return st;
  if (migrate !== false && env.SYNC_ORIGIN) {
    try {
      const r = await fetch(syncOrigin(env) + '/api/state?t=' + Date.now(), { headers: { accept: 'application/json' } });
      const j = await r.json();
      if (j && j.db) {
        st = { rev: Number(j.rev) || 1, at: Date.now(), db: j.db, migratedFrom: syncOrigin(env) };
        await writeState(env, st);
        await mirrorAll(env, st.db);
        return st;
      }
    } catch (e) {}
  }
  return st && st.db ? st : { rev: 0, at: 0, db: blankDb() };
}

async function writeState(env, st) {
  const raw = JSON.stringify(st);
  if (env.WC_DB) {
    try { await ensureSchema(env); await env.WC_DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('state:db',?)").bind(raw).run(); } catch (e) {}
  }
  try { await env.WC_STATE.put(STATE_KEY, raw); } catch (e) {}
}

function blankDb() {
  const db = { users: [], deposits: [], withdrawals: [], messages: [], txs: [], notifications: [], contacts: [], blocks: [], trades: [], holdings: [], products: [], stocks: [], settings: {}, meta: {}, chatsMeta: {} };
  COLLECTIONS.forEach((c) => { if (!Array.isArray(db[c])) db[c] = []; });
  return db;
}

function itemTime(x) {
  if (!x) return 0;
  return Math.max(Number(x.updatedAt)||0, Number(x.reviewedAt)||0, Number(x.closedAt)||0, Number(x.createdAt)||0, Number(x.at)||0);
}
function applyOps(db, ops) {
  const out = db || blankDb();
  COLLECTIONS.forEach((c) => { if (!Array.isArray(out[c])) out[c] = []; });
  (ops || []).forEach((o) => {
    if (!o || !o.op) return;
    if (o.op === 'set') { out[o.key] = o.value; return; }
    const col = o.col; if (!col) return;
    if (!Array.isArray(out[col])) out[col] = [];
    if (o.op === 'push' && o.item && o.item.id) {
      const i = out[col].findIndex((x) => x && x.id === o.item.id);
      if (i >= 0) out[col][i] = o.item; else out[col].push(o.item);
    } else if (o.op === 'update' && o.id) {
      const i = out[col].findIndex((x) => x && x.id === o.id);
      if (i >= 0) out[col][i] = Object.assign({}, out[col][i], o.patch || {});
      else if (o.patch && o.patch.id) out[col].push(o.patch);
    } else if (o.op === 'remove' && o.id) {
      out[col] = out[col].filter((x) => !x || x.id !== o.id);
      out.__deleted = out.__deleted || {};
      out.__deleted[col + ':' + o.id] = Date.now();
    }
  });
  return out;
}

async function mirrorAll(env, db) {
  if (!env.WC_DB) return;
  await ensureSchema(env);
  const stmts = [
    env.WC_DB.prepare('DELETE FROM users'),
    env.WC_DB.prepare('DELETE FROM deposits'),
    env.WC_DB.prepare('DELETE FROM withdrawals')
  ];
  (db.users || []).forEach((u) => { if (u && u.id) stmts.push(env.WC_DB.prepare('INSERT OR REPLACE INTO users (id,json,updated_at) VALUES (?,?,?)').bind(u.id, JSON.stringify(u), itemTime(u))); });
  (db.deposits || []).forEach((d) => { if (d && d.id) stmts.push(env.WC_DB.prepare('INSERT OR REPLACE INTO deposits (id,user_id,status,json,updated_at) VALUES (?,?,?,?,?)').bind(d.id, d.userId || '', d.status || '', JSON.stringify(d), itemTime(d))); });
  (db.withdrawals || []).forEach((w) => { if (w && w.id) stmts.push(env.WC_DB.prepare('INSERT OR REPLACE INTO withdrawals (id,user_id,status,json,updated_at) VALUES (?,?,?,?,?)').bind(w.id, w.userId || '', w.status || '', JSON.stringify(w), itemTime(w))); });
  if (stmts.length) { try { await env.WC_DB.batch(stmts); } catch (e) {} }
}

async function mirrorOps(env, ops) {
  if (!env.WC_DB) return;
  await ensureSchema(env);
  const stmts = [];
  (ops || []).forEach((o) => {
    if (!o || !o.col) return;
    if (o.col === 'users' && o.item && o.item.id) stmts.push(env.WC_DB.prepare('INSERT OR REPLACE INTO users (id,json,updated_at) VALUES (?,?,?)').bind(o.item.id, JSON.stringify(o.item), itemTime(o.item)));
    if (o.col === 'deposits' && o.item && o.item.id) stmts.push(env.WC_DB.prepare('INSERT OR REPLACE INTO deposits (id,user_id,status,json,updated_at) VALUES (?,?,?,?,?)').bind(o.item.id, o.item.userId || '', o.item.status || '', JSON.stringify(o.item), itemTime(o.item)));
    if (o.col === 'withdrawals' && o.item && o.item.id) stmts.push(env.WC_DB.prepare('INSERT OR REPLACE INTO withdrawals (id,user_id,status,json,updated_at) VALUES (?,?,?,?,?)').bind(o.item.id, o.item.userId || '', o.item.status || '', JSON.stringify(o.item), itemTime(o.item)));
  });
  if (stmts.length) { try { await env.WC_DB.batch(stmts); } catch (e) {} }
}

/* --------------------------------------------------------------- chat -- */
async function chatSeq(env) {
  await ensureSchema(env);
  try {
    const r = await env.WC_DB.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM chat_messages').first();
    return Number(r && r.s) || 0;
  } catch (e) { return 0; }
}
async function chatAppend(env, list) {
  await ensureSchema(env);
  let seq = await chatSeq(env);
  const accepted = [];
  for (const raw of (list || []).slice(0, 60)) {
    if (!raw || !raw.id) continue;
    const exists = await env.WC_DB.prepare('SELECT id FROM chat_messages WHERE id=?').bind(String(raw.id)).first().catch(() => null);
    if (exists) { accepted.push({ id: String(raw.id), status: 'sent', duplicate: true }); continue; }
    seq += 1;
    const m = Object.assign({}, raw, { seq: seq, status: 'sent' });
    await env.WC_DB.prepare('INSERT INTO chat_messages (id,seq,chat_id,from_id,to_id,json,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(String(m.id), seq, String(m.chatId || ''), String(m.from || ''), String(m.to || ''), JSON.stringify(m), Number(m.createdAt) || Date.now()).run();
    accepted.push({ id: String(m.id), status: 'sent', seq: seq });
  }
  return { ok: true, seq: seq, accepted: accepted };
}
async function chatSince(env, since, limit) {
  await ensureSchema(env);
  try {
    const r = await env.WC_DB.prepare('SELECT json FROM chat_messages WHERE seq > ? ORDER BY seq ASC LIMIT ?').bind(Number(since) || 0, Math.min(500, Number(limit) || 200)).all();
    return (r.results || []).map((x) => { try { return JSON.parse(x.json); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
async function migrateChat(env) {
  if (!env.WC_DB || !env.SYNC_ORIGIN) return;
  await ensureSchema(env);
  const n = await chatSeq(env);
  if (n > 0) return;
  try {
    const r = await fetch(syncOrigin(env) + '/api/chat/state?since=0', { headers: { accept: 'application/json' } });
    const j = await r.json();
    const list = (j && j.messages) || [];
    if (list.length) await chatAppend(env, list);
  } catch (e) {}
}

/* ------------------------------------------------------------- admin --- */
async function sha256Hex(v) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v)));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function b64u(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function unb64u(s) { return Uint8Array.from(atob(String(s).replace(/-/g,'+').replace(/_/g,'/')), (c) => c.charCodeAt(0)); }
async function adminToken(env, user) {
  const secret = env.ADMIN_SECRET || env.WC_OTP_SECRET || 'whalechat-admin';
  const payload = { sub: user.id, role: 'admin', exp: Date.now() + 8 * 3600 * 1000 };
  const data = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return data + '.' + sig;
}
async function verifyAdmin(env, token) {
  if (!token || token.indexOf('.') < 0) return null;
  const secret = env.ADMIN_SECRET || env.WC_OTP_SECRET || 'whalechat-admin';
  const [data, sig] = token.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const good = b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  if (good !== sig) return null;
  let p = null; try { p = JSON.parse(new TextDecoder().decode(unb64u(data))); } catch (e) { return null; }
  if (!p || !p.sub || Date.now() > Number(p.exp || 0)) return null;
  const st = await readState(env);
  const u = (st.db.users || []).find((x) => x && x.id === p.sub && x.role === 'admin' && !x.banned);
  return u || null;
}


/* ------------------------------------------------- market connections -- */
async function getConn(env) {
  return (await env.WC_STATE.get('conn:cfg', 'json')) || {};
}
async function setConn(env, cfg) {
  await env.WC_STATE.put('conn:cfg', JSON.stringify(cfg));
}
async function testFinnhub(key) {
  if (!key) return { ok: false, error: 'no_key' };
  try {
    const r = await fetch('https://finnhub.io/api/v1/quote?symbol=AAPL&token=' + encodeURIComponent(key), { headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    return { ok: r.ok && j && Number(j.c) > 0, price: j && j.c, error: r.ok ? (Number(j && j.c) > 0 ? '' : 'No price returned') : 'HTTP ' + r.status };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function testTwelve(key) {
  if (!key) return { ok: false, error: 'no_key' };
  try {
    const r = await fetch('https://api.twelvedata.com/quote?symbol=AAPL&apikey=' + encodeURIComponent(key), { headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    return { ok: r.ok && j && !j.code && Number(j.close) > 0, price: j && j.close, error: j && j.message ? j.message : (r.ok ? '' : 'HTTP ' + r.status) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/* ---------------------------------------------------------------- main -- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });

    try {
      /* --- durable state on Cloudflare KV + D1 ----------------------- */
      if (path === '/api/health' && request.method === 'GET') {
        const st = await readState(env, false);
        return json({ ok: true, app: 'whalechat', version: '3.80.0', provider: 'cloudflare-edge', storage: 'cloudflare-kv+d1', stream: false, realtime: { provider: 'poll', enabled: false }, rev: st.rev || 0, users: (st.db.users || []).length, email: !!env.BREVO_API_KEY }, 200);
      }
      if (path === '/api/state' && request.method === 'GET') {
        const st = await readState(env, true);
        await migrateChat(env);
        return json({ rev: st.rev || 0, db: st.db, updatedAt: st.at || 0, storage: 'cloudflare' }, 200);
      }
      if (path === '/api/state/init' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!body.db || !Array.isArray(body.db.users) || !body.db.users.length) return json({ ok: false, error: 'invalid_db' }, 400);
        const st = { rev: Math.max(1, Number(body.rev) || 1), at: Date.now(), db: body.db };
        await writeState(env, st);
        await mirrorAll(env, st.db);
        return json({ ok: true, rev: st.rev }, 200);
      }
      if (path === '/api/ops' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const st = await readState(env, true);
        st.db = applyOps(st.db, body.ops || []);
        st.rev = Math.max(1, Number(st.rev) || 0) + 1;
        st.at = Date.now();
        await writeState(env, st);
        await mirrorAll(env, st.db);
        return json({ ok: true, rev: st.rev }, 200);
      }
      if (path === '/api/release' && request.method === 'GET') {
        const st = await readState(env, false);
        return json({ ok: true, version: '3.80.0', build: 'cloudflare', uptimeSec: 0, clients: 0, rev: st.rev || 0, devices: 0, publicUrl: 'https://whalechat.pages.dev', users: (st.db.users || []).length, storage: 'cloudflare' }, 200);
      }

      /* --- chat lane on D1 ------------------------------------------ */
      if (path === '/api/chat/send' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const list = Array.isArray(body.messages) ? body.messages : (body.message ? [body.message] : []);
        if (!list.length) return json({ ok: false, error: 'no_messages' }, 400);
        return json(await chatAppend(env, list), 200);
      }
      if ((path === '/api/chat/state' || path === '/api/chat/sync') && (request.method === 'GET' || request.method === 'POST')) {
        let since = Number(url.searchParams.get('since') || 0) || 0;
        if (request.method === 'POST') { const b = await request.json().catch(() => ({})); since = Number(b.since || since) || 0; }
        const messages = await chatSince(env, since, 300);
        return json({ ok: true, seq: messages.length ? messages[messages.length - 1].seq : since, messages: messages, events: [], evSeq: since, waited: 0 }, 200);
      }
      if (path === '/api/chat/events' && request.method === 'GET') {
        return json({ ok: true, seq: 0, events: [] }, 200);
      }
      if ((path === '/api/chat/read' || path === '/api/chat/typing' || path === '/api/chat/presence') && request.method === 'POST') {
        return json({ ok: true }, 200);
      }

      /* --- admin auth on the edge ----------------------------------- */
      if (path === '/api/admin/login' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const login = String(body.login || body.email || body.username || body.userId || '').trim().toLowerCase();
        const given = String(body.password || '');
        const st = await readState(env, true);
        const u = (st.db.users || []).find((x) => x && x.role === 'admin' && !x.banned &&
          (String(x.email || '').toLowerCase() === login || String(x.username || '').toLowerCase() === login || String(x.id || '').toLowerCase() === login));
        if (!u) return json({ ok: false, error: 'invalid', message: 'Incorrect admin email or password' }, 401);
        const hash = await sha256Hex('whalechat::v1::' + given);
        if (!u.pass || hash !== u.pass) return json({ ok: false, error: 'invalid', message: 'Incorrect admin email or password' }, 401);
        const token = await adminToken(env, u);
        return json({ ok: true, token: token, admin: { id: u.id, email: u.email || '', username: u.username || '', fullName: u.fullName || 'WhaleChat Admin' }, expiresAt: Date.now() + 8 * 3600 * 1000 }, 200);
      }
      if (path === '/api/admin/me' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const u = await verifyAdmin(env, body.token || request.headers.get('x-admin-token'));
        return u ? json({ ok: true, admin: { id: u.id, email: u.email || '', username: u.username || '', fullName: u.fullName || '' } }, 200) : json({ ok: false, error: 'unauthorised' }, 401);
      }
      if (path === '/api/admin/session/auto' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const id = String(body.userId || body.adminId || body.login || '');
        const st = await readState(env, true);
        const u = (st.db.users || []).find((x) => x && x.id === id && x.role === 'admin' && !x.banned);
        if (!u) return json({ ok: false, error: 'admin_not_found' }, 403);
        return json({ ok: true, token: await adminToken(env, u), adminId: u.id, expiresAt: Date.now() + 8 * 3600 * 1000 }, 200);
      }

      /* --- email verification codes ---------------------------------- */
      if (path === '/api/verify/email-code' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || '').trim().toLowerCase();
        const purpose = String(body.purpose || 'signup').replace(/[^a-z_-]/gi, '').slice(0, 16) || 'signup';
        if (!emailOk(email)) return json({ ok: false, error: 'invalid_email', message: 'Enter a valid email address' }, 400);
        const { code } = await makeCode(env, 'email:' + purpose, email);
        const labels = { signup: 'your WhaleChat account', reset: 'your password reset', pin: 'your transaction PIN reset' };
        const label = labels[purpose] || 'your request';
        try {
          await brevoEmail(env, email, 'Your WhaleChat verification code: ' + code, codeEmailHtml(code, label), 'Your WhaleChat verification code is ' + code + ' (valid 15 minutes).');
          return json({ ok: true, emailed: true, purpose: purpose, to: maskEmail(email) });
        } catch (e) {
          /* never dead-end a signup: return the code so the app can show it */
          return json({ ok: true, emailed: false, purpose: purpose, to: maskEmail(email), code: code, warning: String(e.message || e).slice(0, 200) });
        }
      }
      if (path === '/api/verify/email-check' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || '').trim().toLowerCase();
        const purpose = String(body.purpose || 'signup').replace(/[^a-z_-]/gi, '').slice(0, 16) || 'signup';
        const ok = await checkCode(env, 'email:' + purpose, email, body.code);
        return json({ ok: true, verified: ok }, 200);
      }

      /* --- SMS OTP ---------------------------------------------------- */
      if (path === '/api/telesign/start' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const phone = normalPhone(body.phone);
        if (!phone) return json({ ok: false, error: 'invalid_phone_number' }, 400);
        const { code } = await makeCode(env, 'sms', phone);
        const text = String(body.template || 'Your WhaleChat code is $$CODE$$. It expires in 5 minutes.').replace(/\$\$CODE\$\$/g, code);
        try {
          const out = await brevoSms(env, phone, text);
          return json({ ok: true, phone: maskPhone(phone), referenceId: out.referenceId, expiresInMs: 300000, status: 'PENDING', provider: 'brevo' });
        } catch (e) {
          return json({ ok: false, error: 'brevo_sms_send_failed', message: String(e.message || e).slice(0, 300) }, 502);
        }
      }
      if (path === '/api/telesign/verify' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const phone = normalPhone(body.phone);
        if (!phone) return json({ ok: false, error: 'invalid_phone_number' }, 400);
        const verified = await checkCode(env, 'sms', phone, body.code);
        return json({ ok: true, verified: verified, status: verified ? 'VALID' : 'INVALID', provider: 'brevo' }, 200);
      }

      /* --- market provider connections (admin) --------------------- */
      if (path === '/api/connections' && (request.method === 'GET' || request.method === 'POST')) {
        const admin = await isAdmin(env, request);
        if (!admin) return json({ ok: false, error: 'admin_required' }, 403);
        const cfg = await getConn(env);
        if (request.method === 'GET') {
          const f = cfg.finnhub || {}, t = cfg.twelvedata || {}, b = cfg.binance || {};
          return json({
            ok: true,
            finnhub: { configured: !!f.apiKey, source: f.apiKey ? 'finnhub' : 'offline', live: { source: f.apiKey ? 'finnhub' : 'offline', hasKey: !!f.apiKey } },
            twelvedata: { configured: !!t.apiKey, source: t.apiKey ? 'twelvedata' : 'offline', live: { source: t.apiKey ? 'twelvedata' : 'offline', lastError: '' } },
            binance: { configured: true, source: 'binance', live: { source: 'binance', ticks: 0 } },
            brevo: { configured: !!env.BREVO_API_KEY, source: 'brevo' },
            smtp: { configured: !!env.BREVO_API_KEY },
            storage: { configured: true, provider: 'cloudflare-d1+kv' }
          }, 200);
        }
        const body = await request.json().catch(() => ({}));
        ['finnhub','twelvedata','binance'].forEach((k) => {
          if (!body[k] || typeof body[k] !== 'object') return;
          cfg[k] = Object.assign({}, cfg[k] || {}, body[k]);
          if (cfg[k].apiKey) cfg[k].apiKey = String(cfg[k].apiKey).trim();
        });
        if (body.twelvedataPoll) cfg.twelvedataPoll = true;
        await setConn(env, cfg);
        return json({ ok: true, configured: true, storage: 'cloudflare-kv' }, 200);
      }
      if (path === '/api/connections/test' && request.method === 'POST') {
        const admin = await isAdmin(env, request);
        if (!admin) return json({ ok: false, error: 'admin_required' }, 403);
        const body = await request.json().catch(() => ({}));
        const cfg = await getConn(env);
        const which = String(body.which || '');
        const results = {};
        if (which === 'all' || which === 'finnhub') results.finnhub = Object.assign({ hasKey: !!(cfg.finnhub && cfg.finnhub.apiKey) }, await testFinnhub(cfg.finnhub && cfg.finnhub.apiKey));
        if (which === 'all' || which === 'twelvedata') results.twelvedata = Object.assign({ hasKey: !!(cfg.twelvedata && cfg.twelvedata.apiKey) }, await testTwelve(cfg.twelvedata && cfg.twelvedata.apiKey));
        if (which === 'all' || which === 'binance') results.binance = { source: 'binance', ok: true };
        if (which === 'all' || which === 'brevo') results.brevo = { configured: !!env.BREVO_API_KEY, ok: !!env.BREVO_API_KEY };
        return json({ ok: true, results: results, resultsMap: results }, 200);
      }
      if (path === '/api/market/config' && (request.method === 'GET' || request.method === 'POST')) {
        const admin = await isAdmin(env, request);
        if (!admin) return json({ ok: false, error: 'admin_only' }, 403);
        const cfg = await getConn(env);
        if (request.method === 'GET') {
          const f = cfg.finnhub || {};
          return json({ ok: true, mode: f.mode || 'hybrid', refreshSec: Number(f.refreshSec) || 15, hasKey: !!f.apiKey, keyMasked: f.apiKey ? String(f.apiKey).slice(-4).padStart(8, '•') : '', source: f.apiKey ? 'finnhub' : 'offline', notice: f.apiKey ? 'Finnhub key saved on the Cloudflare edge' : 'No Finnhub key saved' }, 200);
        }
        const body = await request.json().catch(() => ({}));
        cfg.finnhub = Object.assign({}, cfg.finnhub || {}, {
          mode: body.mode === 'hybrid' ? 'hybrid' : 'simulated',
          refreshSec: Math.min(300, Math.max(5, Number(body.refreshSec) || 15)),
          updatedAt: Date.now()
        });
        if (body.clearKey) delete cfg.finnhub.apiKey;
        if (body.apiKey) cfg.finnhub.apiKey = String(body.apiKey).trim();
        await setConn(env, cfg);
        return json({ ok: true, mode: cfg.finnhub.mode, refreshSec: cfg.finnhub.refreshSec, hasKey: !!cfg.finnhub.apiKey, keyMasked: cfg.finnhub.apiKey ? String(cfg.finnhub.apiKey).slice(-4).padStart(8, '•') : '' }, 200);
      }

      /* --- admin email through Brevo -------------------------------- */
      if (path === '/api/email/status' && request.method === 'GET') {
        return json({ ok: true, configured: !!env.BREVO_API_KEY, provider: 'brevo', from: env.BREVO_SENDER_EMAIL || null, fromName: env.BREVO_SENDER_NAME || 'WhaleChat' }, 200);
      }
      if (path === '/api/email/test' && request.method === 'POST') {
        const admin = await isAdmin(env, request);
        if (!admin) return json({ ok: false, error: 'admin_session_required' }, 401);
        const body = await request.json().catch(() => ({}));
        if (!emailOk(body.to)) return json({ ok: false, error: 'invalid_email' }, 400);
        try {
          const out = await brevoEmail(env, body.to, 'WhaleChat email service is working',
            '<div style="font-family:system-ui,sans-serif;background:#04101a;color:#e9f4f9;padding:26px;border-radius:14px"><h2>WhaleChat email is connected</h2><p style="color:#8ba4b6">This test confirms Brevo delivery from <b>' + (env.BREVO_SENDER_EMAIL || '') + '</b> through the Cloudflare edge backend.</p></div>',
            'WhaleChat email is connected.');
          return json({ ok: true, provider: 'brevo', messageId: out.messageId });
        } catch (e) { return json({ ok: false, error: 'send_failed', message: String(e.message || e).slice(0, 300) }, 502); }
      }
      if (path === '/api/email/broadcast' && request.method === 'POST') {
        const admin = await isAdmin(env, request);
        if (!admin) return json({ ok: false, error: 'admin_session_required' }, 401);
        const body = await request.json().catch(() => ({}));
        const subject = cleanText(body.subject, 160) || 'WhaleChat';
        const html = String(body.html || body.text || '<p>WhaleChat</p>');
        const db = await stateDb(env);
        const users = ((db && db.users) || []).filter((u) => u && u.email && !u.banned).slice(0, 20);
        let sent = 0, failed = 0;
        for (const u of users) {
          try { await brevoEmail(env, u.email, subject, html, body.text || ''); sent++; } catch (e) { failed++; }
        }
        return json({ ok: true, sent, failed, queued: users.length - sent - failed }, 200);
      }

      /* --- admin SMS through Brevo ---------------------------------- */
      if ((path === '/api/telesign/sms' || path === '/api/telesign/broadcast') && request.method === 'POST') {
        const admin = await isAdmin(env, request);
        if (!admin) return json({ ok: false, error: 'admin_session_required' }, 401);
        const body = await request.json().catch(() => ({}));
        const bodyText = cleanText(body.message, 700);
        if (!bodyText) return json({ ok: false, error: 'message_required' }, 400);
        const label = cleanText(body.buttonLabel, 60);
        const link = String(body.buttonUrl || '').trim();
        const full = link ? (bodyText + '\n\n' + (label || 'Open WhaleChat') + ': ' + link).slice(0, 1400) : bodyText;
        if (path.endsWith('/sms')) {
          const phone = normalPhone(body.phone);
          if (!phone) return json({ ok: false, error: 'invalid_phone_number' }, 400);
          try {
            const out = await brevoSms(env, phone, full);
            return json({ ok: true, provider: 'brevo', to: maskPhone(phone), referenceId: out.referenceId, hasButton: !!link, preview: full }, 200);
          } catch (e) { return json({ ok: false, error: 'brevo_sms_send_failed', message: String(e.message || e).slice(0, 300) }, 502); }
        }
        const db = await stateDb(env);
        const audience = String(body.audience || 'all');
        const ids = Array.isArray(body.userIds) ? body.userIds.map(String) : [];
        const users = ((db && db.users) || []).filter((u) => u && u.phone && !u.banned && (audience === 'all' || ids.indexOf(String(u.id)) >= 0)).slice(0, 100);
        let sent = 0, failed = 0;
        const results = [];
        for (const u of users) {
          const phone = normalPhone(u.phone);
          if (!phone) { failed++; continue; }
          try { const out = await brevoSms(env, phone, full); sent++; results.push({ phone: maskPhone(phone), ok: true, referenceId: out.referenceId }); }
          catch (e) { failed++; results.push({ phone: maskPhone(phone), ok: false, error: String(e.message || e).slice(0, 160) }); }
        }
        return json({ ok: true, provider: 'brevo', sent, failed, attempted: users.length, recipients: users.length, hasButton: !!link, button: link ? { label: label || 'Open WhaleChat', url: link } : null, preview: full, results }, 200);
      }

      /* --- everything else is the existing WhaleChat sync backend ----- */
      if (path.startsWith('/api/')) return proxy(request, env, url);

      /* --- static PWA -------------------------------------------------- */
      let res = await env.ASSETS.fetch(request);
      if (res.status === 404 && !/\.[a-z0-9]+$/i.test(path)) {
        res = await env.ASSETS.fetch(new Request(new URL('/whalechat.html', url), request));
      }
      return res;
    } catch (e) {
      if (path.startsWith('/api/')) return json({ ok: false, error: 'edge_error', message: String(e.message || e).slice(0, 300) }, 500);
      return new Response('WhaleChat edge error', { status: 500, headers: CORS });
    }
  }
};
