'use strict';
/* =========================================================================
   WhaleChat admin sessions (server side)
   Admin endpoints used to trust an `adminId` sent by the browser. Now an
   admin must prove their password to the server once and receives a signed,
   short-lived token. Every admin endpoint checks that token; the adminId in
   the request body is ignored unless it matches the token.
   - token = base64url(payload).HMAC-SHA256(payload, ADMIN_SESSION_SECRET)
   - payload binds the admin id and the current password hash, so changing
     the admin password invalidates every open admin session
   - the request context (token admin, ip, user agent) is kept in
     AsyncLocalStorage so existing isAdmin(db, id) checks stay one-liners
   ========================================================================= */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const TTL_MS = 12 * 3600 * 1000;               // 12 hours
const PW_SALT = 'whalechat::v1::';             // same salt the web app uses for u.pass
const als = new AsyncLocalStorage();

let SECRET = process.env.ADMIN_SESSION_SECRET || '';
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[admin-auth] ADMIN_SESSION_SECRET not set: admin sessions reset on every restart');
}

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sign = (data) => b64u(crypto.createHmac('sha256', SECRET).update(data).digest());
const pwHash = (pw) => crypto.createHash('sha256').update(PW_SALT + String(pw == null ? '' : pw)).digest('hex');
const passFp = (u) => crypto.createHash('sha256').update('fp::' + String((u && u.pass) || '')).digest('hex').slice(0, 16);
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* brute-force guard: 5 failures per id/ip per 15 minutes */
const FAILS = new Map();
function tooMany(key) {
  const f = FAILS.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60000) { FAILS.delete(key); return false; }
  return f.n >= 5;
}
function fail(key) {
  const f = FAILS.get(key);
  if (!f || Date.now() - f.first > 15 * 60000) FAILS.set(key, { n: 1, first: Date.now() });
  else f.n += 1;
}

function findAdmin(db, id) {
  const users = (db && Array.isArray(db.users)) ? db.users : [];
  const key = String(id || '').trim().toLowerCase();
  if (!key) return null;
  return users.find((u) => u && u.role === 'admin' && !u.banned &&
    (String(u.id).toLowerCase() === key || String(u.username || '').toLowerCase() === key || String(u.email || '').toLowerCase() === key)) || null;
}

/* POST /api/admin/session { login | userId, password } */
function login(db, body, ip) {
  const id = String((body && (body.login || body.userId || body.username || body.email)) || '');
  const key = id.toLowerCase() + '|' + String(ip || '');
  if (tooMany(key)) { const e = new Error('Too many attempts. Wait 15 minutes.'); e.status = 429; throw e; }
  const u = findAdmin(db, id);
  /* settings.allowAnyPassword is deliberately ignored here */
  if (!u || !u.pass || !safeEq(pwHash(body && body.password), u.pass)) {
    fail(key);
    const e = new Error('Admin login failed'); e.status = 401; throw e;
  }
  FAILS.delete(key);
  const payload = { sub: u.id, fp: passFp(u), exp: Date.now() + TTL_MS, n: crypto.randomBytes(6).toString('hex') };
  const data = b64u(JSON.stringify(payload));
  return { token: data + '.' + sign(data), adminId: u.id, email: u.email || '', expiresAt: payload.exp };
}

/* returns the admin user for a valid token, else null */
function verify(db, token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [data, sig] = token.split('.');
  if (!safeEq(sign(data), sig || '')) return null;
  let p; try { p = JSON.parse(unb64u(data).toString('utf8')); } catch (e) { return null; }
  if (!p || !p.sub || !(p.exp > Date.now())) return null;
  const u = findAdmin(db, p.sub);
  if (!u || u.id !== p.sub || passFp(u) !== p.fp) return null;
  return u;
}

function clientIp(req) {
  const xf = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  const ip = xf || (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '');
}

/* wrap each HTTP request */
function run(req, getDb, fn) {
  const token = String((req.headers && (req.headers['x-admin-token'] || '')) || '');
  let admin = null;
  try { admin = token ? verify(getDb(), token) : null; } catch (e) { admin = null; }
  const ctx = { admin, ip: clientIp(req), userAgent: String((req.headers && req.headers['user-agent']) || '').slice(0, 500), hadToken: !!token };
  return als.run(ctx, fn);
}
function ctx() { return als.getStore() || { admin: null, ip: '', userAgent: '', hadToken: false }; }

/* true only when the request carries a valid admin token (and, if an adminId
   was sent, it is the same admin) */
function isAdminRequest(claimedId) {
  const c = ctx();
  if (!c.admin) return false;
  if (claimedId && String(claimedId) !== String(c.admin.id)) return false;
  return true;
}
function currentAdmin() { return ctx().admin; }

module.exports = { run, ctx, login, verify, isAdminRequest, currentAdmin, pwHash, clientIp };
