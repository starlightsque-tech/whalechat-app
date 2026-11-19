/* =========================================================================
   WhaleChat sync function — Appwrite Function edition of server.js
   -------------------------------------------------------------------------
   Implements the endpoints the WhaleChat client needs for cross-device sync
   and email verification, with the whole database stored in Appwrite Storage:

     GET  /api/health
     GET  /api/state
     POST /api/state/init
     POST /api/ops
     POST /api/verify/email-code
     POST /api/verify/email-check
     GET  /api/push/status | /api/push/key
     GET  /api/events        (no SSE in Functions; the client polls)

   The function is public (role: any) and only touches the whalechat bucket.
   ========================================================================= */
'use strict';

const ENDPOINT = (process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1').replace(/\/+$/, '');
const PROJECT = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID || '';
const KEY = process.env.WC_APPWRITE_KEY || process.env.APPWRITE_FUNCTION_API_KEY || '';
const BUCKET = process.env.WC_BUCKET || 'whalechat';
const STATE_FILE = 'whalechat-state';
const CODES_FILE = 'whalechat-codes';
const VERSION = '3.57.3';
const crypto = require('crypto');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store'
};

function headers(extra) {
  return Object.assign({ 'X-Appwrite-Project': PROJECT, 'X-Appwrite-Key': KEY }, extra || {});
}
async function api(pathname, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(ENDPOINT + pathname, Object.assign({ signal: ctl.signal }, opts || {}));
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
  finally { clearTimeout(timer); }
}

async function readJsonFile(id, fallback) {
  /* Appwrite's update-file endpoint only changes metadata, so the state file is
     deleted and recreated on every write. Burst the read a few times so the
     tiny recreate window can never look like an empty database. */
  for (let i = 0; i < 3; i++) {
    const r = await api('/storage/buckets/' + encodeURIComponent(BUCKET) + '/files/' + id + '/view?t=' + Date.now(), { method: 'GET', headers: headers() });
    if (r.ok && r.text) { try { return JSON.parse(r.text); } catch (e) {} }
    if (r.status !== 404 && r.status !== 0) break;
    await new Promise((res) => setTimeout(res, 120));
  }
  return fallback;
}
async function writeJsonFile(id, name, obj) {
  /* delete + recreate: Appwrite PUT /files/{id} only updates name/permissions */
  await api('/storage/buckets/' + encodeURIComponent(BUCKET) + '/files/' + id, { method: 'DELETE', headers: headers() });
  const form = new FormData();
  form.append('fileId', id);
  form.append('file', new Blob([JSON.stringify(obj)], { type: 'application/json' }), name);
  const r = await api('/storage/buckets/' + encodeURIComponent(BUCKET) + '/files', { method: 'POST', headers: headers(), body: form });
  return r.ok;
}

/* simple cross-instance lock using the state file's rev */
let localBusy = false;

async function readState() {
  const s = await readJsonFile(STATE_FILE, null);
  if (s && s.db) return s;
  return { rev: 0, at: 0, db: null };
}

function applyOps(db, ops) {
  const out = db || { users: [], stocks: [], products: [], orders: [], messages: [], txs: [], vendors: [], deposits: [], withdrawals: [], contacts: [], notifications: [], statuses: [], chatsMeta: {}, alerts: [], blocks: [], settings: {}, trades: [], holdings: [], watchlist: [], meta: {} };
  const arrCols = ['users','vendors','companyProducts','products','orders','deposits','withdrawals','messages','statuses','notifications','contacts','blocks','txs','referrals','purchases','refunds','vendorApplications','audit','portfolioAudit','botAccounts','botEvents','stocks','holdings','trades','watchlist','alerts','traffic'];
  arrCols.forEach((c) => { if (!Array.isArray(out[c])) out[c] = []; });
  (ops || []).forEach((o) => {
    if (!o || !o.op) return;
    if (o.op === 'set') { out[o.key] = o.value; return; }
    const col = o.col;
    if (!col) return;
    if (!Array.isArray(out[col])) out[col] = [];
    if (o.op === 'push') { if (o.item && o.item.id && !out[col].some((x) => x && x.id === o.item.id)) out[col].push(o.item); }
    else if (o.op === 'update') {
      const i = out[col].findIndex((x) => x && x.id === o.id);
      if (i >= 0) out[col][i] = Object.assign({}, out[col][i], o.patch || {});
      else if (o.patch) out[col].push(o.patch);
    } else if (o.op === 'remove') { out[col] = out[col].filter((x) => !x || x.id !== o.id); }
  });
  return out;
}

/* ------------------------------- admin panel ----------------------------- */
const ADMIN_SECRET = process.env.ADMIN_PANEL_SECRET || KEY || 'whalechat-admin';
const ADMIN_TTL = 8 * 3600 * 1000;
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signToken(payload) {
  const data = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', ADMIN_SECRET).update(data).digest());
  return data + '.' + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [data, sig] = token.split('.');
  const good = b64u(crypto.createHmac('sha256', ADMIN_SECRET).update(data).digest());
  if (good.length !== sig.length) return null;
  try { if (!crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null; } catch (e) { return null; }
  let payload = null;
  try { payload = JSON.parse(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) { return null; }
  if (!payload || !payload.sub || Date.now() > Number(payload.exp || 0)) return null;
  return payload;
}
const ADMIN_FAILS = new Map();
function adminFail(key) {
  const f = ADMIN_FAILS.get(key);
  if (!f || Date.now() - f.at > 15 * 60000) ADMIN_FAILS.set(key, { n: 1, at: Date.now() });
  else f.n++;
}
function adminBlocked(key) {
  const f = ADMIN_FAILS.get(key);
  return !!(f && Date.now() - f.at < 15 * 60000 && f.n >= 6);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendCodeEmail(to, code, purposeLabel) {
  const subject = 'Your WhaleChat verification code: ' + code;
  const html = '<div style="font-family:system-ui,sans-serif"><p>Your WhaleChat verification code for ' + purposeLabel + ' is:</p>' +
    '<p style="font-size:30px;letter-spacing:8px;font-weight:800">' + code + '</p><p>It expires in 15 minutes.</p></div>';
  if (process.env.RESEND_API_KEY) {
    const r = await apiRaw('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM || 'WhaleChat <onboarding@resend.dev>', to: [to], subject, html })
    });
    return r.ok;
  }
  if (process.env.BREVO_API_KEY) {
    const r = await apiRaw('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ sender: { email: process.env.MAIL_FROM || 'whalechat1@gmail.com', name: 'WhaleChat' }, to: [{ email: to }], subject, htmlContent: html })
    });
    return r.ok;
  }
  return false;
}
async function apiRaw(url, opts) {
  try { const r = await fetch(url, opts); return { ok: r.ok, status: r.status }; } catch (e) { return { ok: false, status: 0 }; }
}

module.exports = async ({ req, res, log, error }) => {
  const method = (req.method || 'GET').toUpperCase();
  const path = String(req.path || '/').replace(/\/+$/, '') || '/';
  if (method === 'OPTIONS') return res.send('', 204, CORS);
  let body = {};
  try { body = req.body ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) : {}; } catch (e) { body = {}; }

  try {
    if (path === '/api/admin/login' && method === 'POST') {
      const login = String(body.login || '').trim().toLowerCase();
      const given = String(body.password || '');
      const ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'client');
      const key = login + '|' + ip;
      if (adminBlocked(key)) return res.json({ ok: false, error: 'too_many', message: 'Too many attempts. Wait 15 minutes.' }, 429, CORS);
      const st = await readState();
      const users = (st.db && st.db.users) || [];
      const u = users.find((x) => x && x.role === 'admin' && !x.banned &&
        (String(x.email || '').toLowerCase() === login || String(x.username || '').toLowerCase() === login || String(x.id || '').toLowerCase() === login));
      const hash = await sha256('whalechat::v1::' + given);
      if (!u || !u.pass || hash !== u.pass) {
        adminFail(key);
        return res.json({ ok: false, error: 'invalid', message: 'Incorrect admin email or password' }, 401, CORS);
      }
      ADMIN_FAILS.delete(key);
      const token = signToken({ sub: u.id, email: u.email || '', role: 'admin', exp: Date.now() + ADMIN_TTL });
      return res.json({ ok: true, token, admin: { id: u.id, email: u.email || '', username: u.username || '', fullName: u.fullName || 'WhaleChat Admin', hasRecovery: !!u.adminRecoveryHash }, expiresAt: Date.now() + ADMIN_TTL }, 200, CORS);
    }

    if (path === '/api/admin/me' && method === 'POST') {
      const payload = verifyToken(body.token);
      if (!payload) return res.json({ ok: false, error: 'unauthorised' }, 401, CORS);
      const st = await readState();
      const u = (st.db && st.db.users || []).find((x) => x && x.id === payload.sub && x.role === 'admin');
      if (!u) return res.json({ ok: false, error: 'admin_missing' }, 404, CORS);
      return res.json({ ok: true, admin: { id: u.id, email: u.email || '', username: u.username || '', fullName: u.fullName || '', hasRecovery: !!u.adminRecoveryHash } }, 200, CORS);
    }

    if (path === '/api/admin/update' && method === 'POST') {
      const payload = verifyToken(body.token);
      if (!payload) return res.json({ ok: false, error: 'unauthorised', message: 'Sign in again' }, 401, CORS);
      const st = await readState();
      if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
      const u = (st.db.users || []).find((x) => x && x.id === payload.sub && x.role === 'admin');
      if (!u) return res.json({ ok: false, error: 'admin_missing' }, 404, CORS);
      const current = String(body.currentPassword || '');
      if (body.newPassword || body.email || body.username) {
        const okPw = (await sha256('whalechat::v1::' + current)) === u.pass;
        if (!okPw) return res.json({ ok: false, error: 'bad_password', message: 'Current password is incorrect' }, 403, CORS);
      }
      if (body.email) {
        const email = String(body.email).trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return res.json({ ok: false, error: 'invalid_email', message: 'Enter a valid email' }, 400, CORS);
        if ((st.db.users || []).some((x) => x && x.id !== u.id && String(x.email || '').toLowerCase() === email)) return res.json({ ok: false, error: 'email_taken', message: 'That email is used by another account' }, 409, CORS);
        u.email = email;
      }
      if (body.username) {
        const username = String(body.username).trim();
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.json({ ok: false, error: 'invalid_username', message: '3–20 letters, numbers or underscores' }, 400, CORS);
        if ((st.db.users || []).some((x) => x && x.id !== u.id && String(x.username || '').toLowerCase() === username.toLowerCase())) return res.json({ ok: false, error: 'username_taken', message: 'That username is taken' }, 409, CORS);
        u.username = username;
      }
      if (body.newPassword) {
        const np = String(body.newPassword);
        if (np.length < 8) return res.json({ ok: false, error: 'weak_password', message: 'Use at least 8 characters' }, 400, CORS);
        u.pass = await sha256('whalechat::v1::' + np);
        u.passChangedAt = Date.now();
      }
      u.updatedAt = Date.now();
      st.rev = Math.max(1, Number(st.rev) || 0) + 1; st.at = Date.now();
      const ok = await writeJsonFile(STATE_FILE, 'whalechat-state.json', st);
      if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
      const token = signToken({ sub: u.id, email: u.email || '', role: 'admin', exp: Date.now() + ADMIN_TTL });
      return res.json({ ok: true, token, rev: st.rev, admin: { id: u.id, email: u.email || '', username: u.username || '', fullName: u.fullName || '' }, hasRecovery: !!u.adminRecoveryHash }, 200, CORS);
    }

    if (path === '/api/admin/user-flag' && method === 'POST') {
      const payload = verifyToken(body.token);
      if (!payload) return res.json({ ok: false, error: 'unauthorised' }, 401, CORS);
      const st = await readState();
      const u = (st.db && st.db.users || []).find((x) => x && x.id === String(body.userId || ''));
      if (!u) return res.json({ ok: false, error: 'user_missing' }, 404, CORS);
      if (u.role === 'admin' && (body.banned === true)) return res.json({ ok: false, error: 'cannot_ban_admin', message: 'Admin accounts cannot be banned' }, 400, CORS);
      if (typeof body.verified === 'boolean') u.verified = body.verified;
      if (typeof body.banned === 'boolean') u.banned = body.banned;
      u.updatedAt = Date.now();
      st.rev = Math.max(1, Number(st.rev) || 0) + 1; st.at = Date.now();
      const ok = await writeJsonFile(STATE_FILE, 'whalechat-state.json', st);
      return res.json(ok ? { ok: true, rev: st.rev } : { ok: false, error: 'storage_write_failed' }, ok ? 200 : 502, CORS);
    }

    if (path === '/api/admin/set-recovery' && method === 'POST') {
      const payload = verifyToken(body.token);
      if (!payload) return res.json({ ok: false, error: 'unauthorised' }, 401, CORS);
      const key = String(body.recoveryKey || '');
      if (key.length < 12) return res.json({ ok: false, error: 'weak', message: 'Use at least 12 characters' }, 400, CORS);
      const st = await readState();
      const u = (st.db && st.db.users || []).find((x) => x && x.id === payload.sub && x.role === 'admin');
      if (!u) return res.json({ ok: false, error: 'admin_missing' }, 404, CORS);
      u.adminRecoveryHash = await sha256('recovery::' + key);
      u.updatedAt = Date.now();
      st.rev = Math.max(1, Number(st.rev) || 0) + 1; st.at = Date.now();
      const ok = await writeJsonFile(STATE_FILE, 'whalechat-state.json', st);
      return res.json(ok ? { ok: true } : { ok: false, error: 'storage_write_failed' }, ok ? 200 : 502, CORS);
    }

    if (path === '/api/admin/recovery' && method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      const key = String(body.recoveryKey || '');
      const np = String(body.newPassword || '');
      if (np.length < 8) return res.json({ ok: false, error: 'weak_password', message: 'Use at least 8 characters' }, 400, CORS);
      const st = await readState();
      const u = (st.db && st.db.users || []).find((x) => x && x.role === 'admin' && String(x.email || '').toLowerCase() === email);
      if (!u) return res.json({ ok: false, error: 'not_found', message: 'No admin account with that email' }, 404, CORS);
      if (!u.adminRecoveryHash) return res.json({ ok: false, error: 'no_recovery', message: 'No recovery key is set. Sign in with your password and create one in Security.' }, 400, CORS);
      if ((await sha256('recovery::' + key)) !== u.adminRecoveryHash) return res.json({ ok: false, error: 'invalid_key', message: 'Recovery key is incorrect' }, 403, CORS);
      u.pass = await sha256('whalechat::v1::' + np);
      u.passChangedAt = Date.now();
      u.updatedAt = Date.now();
      st.rev = Math.max(1, Number(st.rev) || 0) + 1; st.at = Date.now();
      const ok = await writeJsonFile(STATE_FILE, 'whalechat-state.json', st);
      return res.json(ok ? { ok: true, message: 'Password reset — sign in with the new password' } : { ok: false, error: 'storage_write_failed' }, ok ? 200 : 502, CORS);
    }

    if (path === '/api/health' || path === '/') {
      const st = await readState();
      return res.json({ ok: true, app: 'whalechat', version: VERSION, provider: 'appwrite-function', stream: false, rev: st.rev || 0, users: (st.db && st.db.users) ? st.db.users.length : 0, storage: 'appwrite', email: !!(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY) }, 200, CORS);
    }

    if (path === '/api/state' && method === 'GET') {
      const st = await readState();
      return res.json({ rev: st.rev || 0, db: st.db, updatedAt: st.at || 0 }, 200, CORS);
    }

    if (path === '/api/state/init' && method === 'POST') {
      const st = await readState();
      const users = st.db && Array.isArray(st.db.users) ? st.db.users.length : 0;
      if (users > 0) return res.json({ ok: false, error: 'already_initialised', rev: st.rev || 0 }, 409, CORS);
      if (!body.db) return res.json({ ok: false, error: 'invalid_db' }, 400, CORS);
      const next = { at: Date.now(), rev: Math.max(1, Number(body.rev) || 1), db: body.db };
      const ok = await writeJsonFile(STATE_FILE, 'whalechat-state.json', next);
      if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
      return res.json({ ok: true, rev: next.rev }, 200, CORS);
    }

    if (path === '/api/ops' && method === 'POST') {
      if (localBusy) return res.json({ ok: false, error: 'busy' }, 429, CORS);
      localBusy = true;
      try {
        const st = await readState();
        if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
        st.db = applyOps(st.db, body.ops || []);
        st.rev = Math.max(1, Number(st.rev) || 0) + 1;
        st.at = Date.now();
        const ok = await writeJsonFile(STATE_FILE, 'whalechat-state.json', st);
        if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
        return res.json({ ok: true, rev: st.rev }, 200, CORS);
      } finally { localBusy = false; }
    }

    if (path === '/api/events') {
      /* Functions cannot hold an SSE connection open: tell the client to poll */
      return res.json({ ok: true, mode: 'poll' }, 200, CORS);
    }

    if (path === '/api/verify/email-code' && method === 'POST') {
      const address = String(body.email || '').trim().toLowerCase();
      const purpose = String(body.purpose || 'signup').replace(/[^a-z_-]/gi, '').slice(0, 16) || 'signup';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(address)) return res.json({ ok: false, error: 'invalid_email', message: 'Enter a valid email address' }, 400, CORS);
      const key = address + ':' + purpose;
      const codes = await readJsonFile(CODES_FILE, {});
      const prev = codes[key];
      if (prev && Date.now() - prev.sentAt < 45000) {
        return res.json({ ok: false, error: 'too_soon', retryIn: Math.ceil((45000 - (Date.now() - prev.sentAt)) / 1000), message: 'Please wait a few seconds before requesting another code' }, 429, CORS);
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      codes[key] = { hash: await sha256('email-code::' + key + '::' + code), sentAt: Date.now(), exp: Date.now() + 15 * 60000, tries: 0 };
      const labels = { signup: 'your WhaleChat account', reset: 'your password reset', pin: 'your transaction PIN reset' };
      let emailed = false;
      try { emailed = await sendCodeEmail(address, code, labels[purpose] || 'your request'); } catch (e) { emailed = false; }
      await writeJsonFile(CODES_FILE, 'whalechat-codes.json', codes);
      return res.json({ ok: true, emailed, purpose, to: address.replace(/^(.{2}).*(@.*)$/, '$1***$2'), code: emailed ? undefined : code }, 200, CORS);
    }

    if (path === '/api/verify/email-check' && method === 'POST') {
      const address = String(body.email || '').trim().toLowerCase();
      const purpose = String(body.purpose || 'signup').replace(/[^a-z_-]/gi, '').slice(0, 16) || 'signup';
      const key = address + ':' + purpose;
      const codes = await readJsonFile(CODES_FILE, {});
      const rec = codes[key];
      if (!rec || Date.now() > rec.exp) return res.json({ ok: false, error: 'expired', message: 'Code expired — request a new one' }, 400, CORS);
      if (rec.tries >= 6) { delete codes[key]; await writeJsonFile(CODES_FILE, 'whalechat-codes.json', codes); return res.json({ ok: false, error: 'locked', message: 'Too many attempts — request a new code' }, 429, CORS); }
      const hash = await sha256('email-code::' + key + '::' + String(body.code || '').trim());
      if (hash !== rec.hash) { rec.tries += 1; await writeJsonFile(CODES_FILE, 'whalechat-codes.json', codes); return res.json({ ok: false, error: 'invalid', message: 'Incorrect code' }, 400, CORS); }
      delete codes[key];
      await writeJsonFile(CODES_FILE, 'whalechat-codes.json', codes);
      return res.json({ ok: true, verifiedAt: Date.now() }, 200, CORS);
    }

    if (path === '/api/push/status') return res.json({ ok: true, configured: false, devices: 0 }, 200, CORS);
    if (path === '/api/push/key') return res.json({ ok: false, error: 'push_unavailable' }, 200, CORS);
    if (path === '/api/appwrite/status') return res.json({ ok: true, configured: true, provider: 'appwrite-function', bucket: BUCKET, version: VERSION }, 200, CORS);

    return res.json({ ok: false, error: 'not_found', path }, 404, CORS);
  } catch (e) {
    if (error) error(e.message);
    return res.json({ ok: false, error: 'server_error', message: e.message }, 500, CORS);
  }
};
