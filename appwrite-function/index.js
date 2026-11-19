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
const MAIL_FILE = 'whalechat-mail';
const MAIL_LOG_FILE = 'whalechat-email-log';
const NOTIF_LOG_LIMIT = 400;
const VERSION = '3.57.5';
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

async function readMailConfig() {
  const saved = await readJsonFile(MAIL_FILE, {}) || {};
  return {
    brevoKey: String(saved.brevoKey || process.env.BREVO_API_KEY || '').trim(),
    resendKey: String(saved.resendKey || process.env.RESEND_API_KEY || '').trim(),
    from: String(saved.from || process.env.MAIL_FROM || 'whalechat1@gmail.com').trim(),
    fromName: String(saved.fromName || process.env.MAIL_FROM_NAME || 'WhaleChat').trim(),
    webhookKey: String(saved.webhookKey || process.env.BREVO_WEBHOOK_KEY || '').trim(),
    webhookId: saved.webhookId || null,
    updatedAt: saved.updatedAt || 0
  };
}

async function appendMailLog(entry) {
  try {
    const cur = await readJsonFile(MAIL_LOG_FILE, { entries: [] });
    const list = Array.isArray(cur.entries) ? cur.entries : [];
    list.unshift(Object.assign({ id: 'em_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), at: Date.now() }, entry || {}));
    if (list.length > NOTIF_LOG_LIMIT) list.length = NOTIF_LOG_LIMIT;
    await writeJsonFile(MAIL_LOG_FILE, 'whalechat-email-log.json', { entries: list, updatedAt: Date.now() });
  } catch (e) { /* logging must never break sending */ }
}

async function sendMail(cfg, to, subject, html, text) {
  const out = { ok: false, provider: cfg.brevoKey ? 'brevo' : cfg.resendKey ? 'resend' : 'none', messageId: '', error: '' };
  if (cfg.brevoKey) {
    const r = await apiRaw('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': cfg.brevoKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { email: cfg.from, name: cfg.fromName || 'WhaleChat' },
        to: [{ email: to }], subject, htmlContent: html, textContent: text || undefined
      })
    });
    out.ok = r.ok;
    if (r.json && r.json.messageId) out.messageId = r.json.messageId;
    if (!r.ok) out.error = (r.json && (r.json.message || r.json.error)) || 'Brevo rejected the message';
    return out;
  }
  if (cfg.resendKey) {
    const r = await apiRaw('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: 'Bearer ' + cfg.resendKey, 'content-type': 'application/json' },
      body: JSON.stringify({ from: cfg.fromName + ' <' + cfg.from + '>', to: [to], subject, html, text })
    });
    out.ok = r.ok;
    if (r.json && r.json.id) out.messageId = r.json.id;
    if (!r.ok) out.error = (r.json && r.json.message) || 'Resend rejected the message';
    return out;
  }
  out.error = 'Email server is not configured';
  return out;
}

async function sendCodeEmail(to, code, purposeLabel) {
  const cfg = await readMailConfig();
  const subject = 'Your WhaleChat verification code: ' + code;
  const html = '<div style="font-family:system-ui,sans-serif;background:#04101a;color:#e9f4f9;padding:28px;border-radius:14px">' +
    '<h2 style="margin:0 0 8px">WhaleChat verification</h2>' +
    '<p style="color:#8ba4b6">Use this code to verify ' + purposeLabel + '. It expires in 15 minutes.</p>' +
    '<div style="font-size:32px;letter-spacing:10px;font-weight:800;color:#2ee6c9;background:#0b1d29;border:1px dashed #2ee6c9;border-radius:12px;padding:16px;text-align:center;margin:18px 0">' + code + '</div>' +
    '<p style="color:#8ba4b6;font-size:12px">If you did not request this, ignore this email and never share the code.</p></div>';
  const text = 'Your WhaleChat verification code is ' + code + ' (valid 15 minutes).';
  const res = await sendMail(cfg, to, subject, html, text);
  await appendMailLog({ type: 'verification', to, subject, code, purpose: purposeLabel, status: res.ok ? 'sent' : 'failed', provider: res.provider, messageId: res.messageId, error: res.error, from: cfg.from });
  return res.ok;
}
async function sendCodeEmail(to, code, purposeLabel) {
  const cfg = await readMailConfig();
  const subject = 'Your WhaleChat verification code: ' + code;
  const html = '<div style="font-family:system-ui,sans-serif;background:#04101a;color:#e9f4f9;padding:28px;border-radius:14px">' +
    '<h2 style="margin:0 0 8px">WhaleChat verification</h2>' +
    '<p style="color:#8ba4b6">Use this code to verify ' + purposeLabel + '. It expires in 15 minutes.</p>' +
    '<div style="font-size:32px;letter-spacing:10px;font-weight:800;color:#2ee6c9;background:#0b1d29;border:1px dashed #2ee6c9;border-radius:12px;padding:16px;text-align:center;margin:18px 0">' + code + '</div>' +
    '<p style="color:#8ba4b6;font-size:12px">If you did not request this, ignore this email and never share the code.</p></div>';
  const text = 'Your WhaleChat verification code is ' + code + ' (valid 15 minutes).';
  return sendMail(cfg, to, subject, html, text);
}
async function apiRaw(url, opts) {
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) { return { ok: false, status: 0, json: null, text: '', error: e.message }; }
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
      let mailOk = false;
      try { const mc = await readMailConfig(); mailOk = !!(mc.brevoKey || mc.resendKey); } catch (e) {}
      return res.json({ ok: true, app: 'whalechat', version: VERSION, provider: 'appwrite-function', stream: false, rev: st.rev || 0, users: (st.db && st.db.users) ? st.db.users.length : 0, storage: 'appwrite', email: mailOk }, 200, CORS);
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

    if (path === '/api/admin/email-log' && method === 'POST') {
      const payload = verifyToken(body.token);
      if (!payload) return res.json({ ok: false, error: 'unauthorised' }, 401, CORS);
      const cur = await readJsonFile(MAIL_LOG_FILE, { entries: [] });
      const entries = Array.isArray(cur.entries) ? cur.entries : [];
      return res.json({ ok: true, entries: entries.slice(0, Math.max(1, Math.min(400, Number(body.limit) || 200))) }, 200, CORS);
    }

    if (path === '/api/admin/senders' && method === 'POST') {
      const payload = verifyToken(body.token);
      if (!payload) return res.json({ ok: false, error: 'unauthorised' }, 401, CORS);
      const cfg = await readMailConfig();
      if (!cfg.brevoKey) return res.json({ ok: true, configured: false, senders: [], provider: '' }, 200, CORS);
      const r = await apiRaw('https://api.brevo.com/v3/senders', { method: 'GET', headers: { 'api-key': cfg.brevoKey, accept: 'application/json' } });
      const senders = (r.json && r.json.senders) || [];
      return res.json({ ok: r.ok, configured: true, provider: 'brevo', senders: senders.map(function (x) { return { id: x.id, name: x.name, email: x.email, active: !!x.active }; }), error: r.ok ? '' : (r.json && r.json.message) || '' }, 200, CORS);
    }

    if (path === '/api/admin/welcome-test' && method === 'POST') {
      const payload = verifyToken(body.token);
      if (!payload) return res.json({ ok: false, error: 'unauthorised' }, 401, CORS);
      const to =String(body.to || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) return res.json({ ok: false, error: 'invalid_email', message: 'Enter a valid recipient' }, 400, CORS);
      const cfg = await readMailConfig();
      if (!cfg.brevoKey && !cfg.resendKey) return res.json({ ok: false, error: 'not_configured', message: 'Connect Brevo first' }, 400, CORS);
      const name = String(body.name || 'there').slice(0, 60);
      const subject = 'Welcome to WhaleChat 🐋';
      const html = '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#04101a;color:#e9f4f9;padding:32px;border-radius:16px;max-width:560px;margin:auto">' +
        '<div style="font-size:28px;font-weight:900;color:#2ee6c9">WhaleChat</div>' +
        '<h2 style="margin:14px 0 8px">Welcome aboard, ' + name + ' 🐋</h2>' +
        '<p style="color:#8ba4b6;line-height:1.7">Your WhaleChat account is ready. Chat, shop, trade and invest — all in one place. This message also confirms that the WhaleChat email server (Brevo) is delivering mail correctly.</p>' +
        '<a href="https://whalechat.appwrite.network/whalechat.html" style="display:inline-block;margin-top:16px;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:800;padding:12px 20px;border-radius:10px">Open WhaleChat</a>' +
        '<p style="color:#63798a;font-size:11px;margin-top:22px">Sent by WhaleChat · whalechat1@gmail.com via Brevo</p></div>';
      const out = await sendMail(cfg, to, subject, html, 'Welcome to WhaleChat, ' + name + '! Your account is ready.');
      await appendMailLog({ type: 'welcome', to, subject, status: out.ok ? 'sent' : 'failed', provider: out.provider, messageId: out.messageId, error: out.error, from: cfg.from });
      return res.json(out.ok ? { ok: true, messageId: out.messageId, to, provider: out.provider } : { ok: false, error: 'send_failed', message: out.error || 'Brevo refused the message' }, out.ok ? 200 : 502, CORS);
    }

    /* ---------------- Brevo delivery webhook (public, header key) ---------- */
    if (path === '/api/release' && method === 'GET') {
      const st = await readState();
      return res.json({ ok: true, version: VERSION, build: 'appwrite-function-' + VERSION, uptimeSec: Math.round(process.uptime ? process.uptime() : 0), clients: 0, rev: st.rev || 0, devices: 0, publicUrl: 'https://whalechat.appwrite.network', storage: 'appwrite' }, 200, CORS);
    }

    if (path === '/api/backup' && (method === 'GET' || method === 'POST')) {
      const st = await readState();
      if (method === 'POST') {
        st.at = Date.now();
        const ok = await writeJsonFile(STATE_FILE, 'whalechat-state.json', st);
        if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
      }
      const users = (st.db && st.db.users) ? st.db.users.length : 0;
      return res.json({ ok: true, users, count: 1, last: st.at || Date.now(), persistent: true, recoverable: true, storage: 'appwrite' }, 200, CORS);
    }

    if (path === '/api/backup/latest' && method === 'GET') {
      const st = await readState();
      return res.send(JSON.stringify({ at: st.at || Date.now(), rev: st.rev || 0, db: st.db }), 200, Object.assign({ 'content-type': 'application/json', 'content-disposition': 'attachment; filename="whalechat-backup.json"' }, CORS));
    }

    if (path === '/api/state/restore' && method === 'POST') {
      if (!body.db || !Array.isArray(body.db.users) || !body.db.users.length) return res.json({ ok: false, error: 'invalid_db', message: 'Backup contains no accounts' }, 400, CORS);
      const st = await readState();
      const prev = { at: Date.now(), rev: st.rev || 0, db: st.db };
      /* keep the previous snapshot as a separate rollback file */
      if (st.db) await writeJsonFile('whalechat-state-prev', 'whalechat-state-prev.json', prev);
      const next = { at: Date.now(), rev: Math.max(1, Number(st.rev) || 0) + 1, db: body.db };
      const ok = await writeJsonFile(STATE_FILE, 'whalechat-state.json', next);
      return res.json(ok ? { ok: true, rev: next.rev, users: body.db.users.length } : { ok: false, error: 'storage_write_failed' }, ok ? 200 : 502, CORS);
    }

    if (path === '/api/webhook/brevo' && (method === 'POST' || method === 'GET')) {
      const cfg = await readMailConfig();
      const given = String((req.headers && (req.headers['x-whalechat-key'] || req.headers['X-Whalechat-Key'])) || body.key || '').trim();
      if (!cfg.webhookKey) return res.json({ ok: false, error: 'webhook_not_configured' }, 503, CORS);
      if (given !== cfg.webhookKey) return res.json({ ok: false, error: 'forbidden' }, 401, CORS);
      const events = Array.isArray(body) ? body : (Array.isArray(body.events) ? body.events : [body]);
      const cur = await readJsonFile(MAIL_LOG_FILE, { entries: [] });
      const entries = Array.isArray(cur.entries) ? cur.entries : [];
      const norm = (v) => String(v || '').replace(/[<>]/g, '').trim().toLowerCase();
      let updated = 0;
      for (const ev of events) {
        if (!ev || !ev.event) continue;
        const raw = String(ev.event).toLowerCase();
        const eventAt = Number(ev.ts_epoch) || (Number(ev.ts) ? Number(ev.ts) * 1000 : Date.now());
        const msgId = norm(ev['message-id'] || ev.messageId || ev.message_id || '');
        let entry = null;
        if (msgId) entry = entries.find((e) => norm(e.messageId) === msgId);
        if (!entry && ev.email && ev.subject) {
          entry = entries.find((e) => String(e.to || '').toLowerCase() === String(ev.email).toLowerCase() && String(e.subject || '') === String(ev.subject) && Math.abs(Number(e.at) - eventAt) < 7 * 864e5);
        }
        if (!entry) continue;
        entry.events = Array.isArray(entry.events) ? entry.events : [];
        entry.events.push({ event: raw, at: eventAt, reason: String(ev.reason || ev.reason_message || '').slice(0, 200) });
        if (entry.events.length > 40) entry.events = entry.events.slice(-40);
        entry.lastEvent = raw;
        entry.lastEventAt = eventAt;
        entry.eventCount = (entry.eventCount || 0) + 1;
        const map = {
          request: 'sent', sent: 'sent', delivered: 'delivered',
          opened: 'opened', unique_opened: 'opened', proxy_open: 'opened', unique_proxy_open: 'opened',
          click: 'clicked', hard_bounce: 'bounced', soft_bounce: 'deferred', deferred: 'deferred',
          blocked: 'blocked', spam: 'spam', invalid_email: 'invalid', invalid: 'invalid', error: 'failed', unsubscribed: 'unsubscribed'
        };
        const status = map[raw] || raw;
        /* never downgrade an opened message back to delivered when a second
           (proxy) open event arrives */
        const rank = { sent: 1, delivered: 2, opened: 3, clicked: 4, deferred: 2, bounced: 5, blocked: 5, spam: 5, invalid: 5, failed: 5, unsubscribed: 5 };
        const prev = rank[entry.status] || 0;
        entry.status = (rank[status] || 0) >= prev || ['bounced', 'blocked', 'spam', 'invalid', 'failed'].includes(status) ? status : entry.status;
        if (status === 'delivered') entry.deliveredAt = eventAt;
        if (status === 'opened') entry.openedAt = entry.openedAt || eventAt;
        if (status === 'clicked') entry.clickedAt = entry.clickedAt || eventAt;
        if (status === 'bounced') entry.bouncedAt = eventAt;
        updated++;
      }
      if (updated) await writeJsonFile(MAIL_LOG_FILE, 'whalechat-email-log.json', { entries, updatedAt: Date.now() });
      return res.json({ ok: true, updated }, 200, CORS);
    }

    if (path === '/api/admin/webhook-setup' && method === 'POST') {
      const payload = verifyToken(body.token);
      if (!payload) return res.json({ ok: false, error: 'unauthorised' }, 401, CORS);
      const cfg = await readMailConfig();
      if (!cfg.brevoKey) return res.json({ ok: false, error: 'brevo_required', message: 'Connect Brevo first' }, 400, CORS);
      if (!cfg.webhookKey) cfg.webhookKey = crypto.randomBytes(24).toString('hex');
      const webhookUrl = 'https://whalechat-api.appwrite.network/api/webhook/brevo';
      const events = ['request', 'delivered', 'opened', 'uniqueOpened', 'click', 'hardBounce', 'softBounce', 'blocked', 'spam', 'invalid', 'deferred', 'unsubscribed'];
      const list = await apiRaw('https://api.brevo.com/v3/webhooks?type=transactional', { method: 'GET', headers: { 'api-key': cfg.brevoKey, accept: 'application/json' } });
      const hooks = (list.json && list.json.webhooks) || [];
      const existing = hooks.find((h) => String(h.url || '').indexOf('/api/webhook/brevo') >= 0);
      let result = null;
      if (existing) {
        cfg.webhookId = existing.id;
        result = { id: existing.id, url: existing.url, events: existing.events || events, reused: true };
      } else {
        const made = await apiRaw('https://api.brevo.com/v3/webhooks', {
          method: 'POST', headers: { 'api-key': cfg.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ url: webhookUrl, description: 'WhaleChat delivery audit', type: 'transactional', events, headers: [{ key: 'x-whalechat-key', value: cfg.webhookKey }] })
        });
        if (!made.ok) return res.json({ ok: false, error: 'brevo_error', message: (made.json && made.json.message) || 'Could not create webhook' }, 502, CORS);
        cfg.webhookId = made.json && made.json.id;
        result = { id: cfg.webhookId, url: webhookUrl, events, reused: false };
      }
      cfg.updatedAt = Date.now();
      await writeJsonFile(MAIL_FILE, 'whalechat-mail.json', cfg);
      return res.json({ ok: true, webhook: result, active: true }, 200, CORS);
    }

    if (path === '/api/admin/webhook-status' && method === 'POST') {
      const payload = verifyToken(body.token);
      if (!payload) return res.json({ ok: false, error: 'unauthorised' }, 401, CORS);
      const cfg = await readMailConfig();
      return res.json({ ok: true, configured: !!cfg.webhookKey, id: cfg.webhookId || null, url: 'https://whalechat-api.appwrite.network/api/webhook/brevo' }, 200, CORS);
    }

    if (path === '/api/email/status' && method === 'GET') {
      const cfg = await readMailConfig();
      return res.json({ ok: true, configured: !!(cfg.brevoKey || cfg.resendKey), provider: cfg.brevoKey ? 'brevo' : cfg.resendKey ? 'resend' : '', from: cfg.from, fromName: cfg.fromName, queued: 0, sent: 0, host: '', port: '' }, 200, CORS);
    }

    if (path === '/api/admin/mail' && method === 'POST') {
      const st = await readState();
      const adminId = String(body.adminId || '');
      const isAdmin = (st.db && st.db.users || []).some((u) => u && u.role === 'admin' && u.id === adminId);
      if (!isAdmin) return res.json({ ok: false, error: 'admin_required' }, 403, CORS);
      const cfg = await readMailConfig();
      if (body.brevoKey) {
        const key = String(body.brevoKey).trim();
        if (!/^(xkeysib-|xsmtpsib-)/i.test(key)) return res.json({ ok: false, error: 'invalid_key', message: 'That does not look like a Brevo API key' }, 400, CORS);
        cfg.brevoKey = key;
      }
      if (body.from) {
        const from = String(body.from).trim();
        if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(from)) return res.json({ ok: false, error: 'invalid_from', message: 'Enter a valid sender email' }, 400, CORS);
        cfg.from = from;
      }
      if (body.fromName) cfg.fromName = String(body.fromName).trim().slice(0, 80) || 'WhaleChat';
      cfg.updatedAt = Date.now();
      const ok = await writeJsonFile(MAIL_FILE, 'whalechat-mail.json', cfg);
      return res.json(ok ? { ok: true, configured: !!(cfg.brevoKey || cfg.resendKey), provider: cfg.brevoKey ? 'brevo' : 'resend', from: cfg.from } : { ok: false, error: 'storage_write_failed' }, ok ? 200 : 502, CORS);
    }

    if (path === '/api/email/test' && method === 'POST') {
      const to = String(body.to || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) return res.json({ ok: false, error: 'invalid_email' }, 400, CORS);
      const cfg = await readMailConfig();
      if (!cfg.brevoKey && !cfg.resendKey) return res.json({ ok: false, error: 'not_configured', message: 'Connect Brevo first' }, 400, CORS);
      const out = await sendMail(cfg, to, 'WhaleChat email server is working',
        '<div style="font-family:system-ui,sans-serif"><h2>WhaleChat email is connected</h2><p>This test confirms mail delivery from <b>' + cfg.from + '</b> via ' + (cfg.brevoKey ? 'Brevo' : 'Resend') + '.</p></div>',
        'WhaleChat email is connected.');
      await appendMailLog({ type: 'test', to, subject: 'WhaleChat email server is working', status: out.ok ? 'sent' : 'failed', provider: out.provider, messageId: out.messageId, error: out.error, from: cfg.from });
      return res.json(out.ok ? { ok: true, messageId: out.messageId } : { ok: false, error: 'send_failed', message: out.error || 'Brevo refused the message' }, out.ok ? 200 : 502, CORS);
    }

    if (path === '/api/email/broadcast' && method === 'POST') {
      const st = await readState();
      const adminId = String(body.adminId || '');
      const isAdmin = (st.db && st.db.users || []).some((u) => u && u.role === 'admin' && u.id === adminId);
      if (!isAdmin) return res.json({ ok: false, error: 'admin_required' }, 403, CORS);
      const cfg = await readMailConfig();
      if (!cfg.brevoKey && !cfg.resendKey) return res.json({ ok: false, error: 'not_configured' }, 400, CORS);
      const subject = String(body.subject || 'WhaleChat').slice(0, 160);
      const html = String(body.html || '');
      const users = (st.db && st.db.users || []).filter((u) => u && u.email && !u.banned).slice(0, 20);
      let sent = 0;
      for (const u of users) {
        const res = await sendMail(cfg, u.email, subject, html, String(body.text || ''));
        await appendMailLog({ type: 'broadcast', to: u.email, subject, status: res.ok ? 'sent' : 'failed', provider: res.provider, messageId: res.messageId, error: res.error, from: cfg.from, userId: u.id });
        if (res.ok) sent++;
      }
      return res.json({ ok: true, sent, queued: users.length - sent }, 200, CORS);
    }

    if (path === '/api/reload' && method === 'POST') return res.json({ ok: true, clients: 0 }, 200, CORS);

    if (path === '/api/push/status') return res.json({ ok: true, configured: false, devices: 0 }, 200, CORS);
    if (path === '/api/push/key') return res.json({ ok: false, error: 'push_unavailable' }, 200, CORS);
    if (path === '/api/appwrite/status') return res.json({ ok: true, configured: true, provider: 'appwrite-function', bucket: BUCKET, version: VERSION }, 200, CORS);

    return res.json({ ok: false, error: 'not_found', path }, 404, CORS);
  } catch (e) {
    if (error) error(e.message);
    return res.json({ ok: false, error: 'server_error', message: e.message }, 500, CORS);
  }
};
