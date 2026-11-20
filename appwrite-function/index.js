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
const BUCKET = process.env.WC_BUCKET || '6aff48620020a44c714f';
const STATE_FILE = 'whalechat-state';
const CODES_FILE = 'whalechat-codes';
const MAIL_FILE = 'whalechat-mail';
const MAIL_LOG_FILE = 'whalechat-email-log';
const NOTIF_LOG_LIMIT = 400;
const VERSION = '3.66.0';
const crypto = require('crypto');
/* project-scoped ids: env wins, but a stale/placeholder value never does */
function isRealId(v) { return typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{19,}$/.test(v); }
const TELSIGN_BASIC = String(process.env.TELESIGN_BASIC || '').trim();
const TELESIGN_ID = String(process.env.TELESIGN_CUSTOMER_ID || (TELSIGN_BASIC.indexOf(':') > 0 ? TELSIGN_BASIC.slice(0, TELSIGN_BASIC.indexOf(':')) : '')).trim();
const TELESIGN_KEY = String(process.env.TELESIGN_API_KEY || (TELSIGN_BASIC.indexOf(':') > 0 ? TELSIGN_BASIC.slice(TELSIGN_BASIC.indexOf(':') + 1) : '')).trim();
const WC_DB_ID = isRealId(process.env.APPWRITE_DATABASE_ID) ? String(process.env.APPWRITE_DATABASE_ID).trim() : '6aff488e0006a3fe39e0';
const offlineSync = require('./offline-sync');
const { ShareService } = require('./shares');
const { BotService } = require('./bots');
const { MarketService } = require('./market');
const { createMarketData } = require('./market-data');
const { SpotService } = require('./spot');
const { createB2BAlertWatcher } = require('./b2b-alerts');

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
    const o = opts || {};
    const r = await fetch(ENDPOINT + pathname, Object.assign({ signal: ctl.signal }, o, { headers: headers(o.headers) }));
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
  if (s && s.db) { ensureMarketCatalogue(s.db); return s; }
  return { rev: 0, at: 0, db: ensureMarketCatalogue(null) };
}

/* -------------------------------------------------------------------------
   Market catalogue seed. A Function instance is stateless, so a first read of
   an empty state used to leave the app with zero assets ("no markets enabled").
   Every state read/write now guarantees the 300+ instrument catalogue plus the
   WhaleCoin company stock. Existing admin edits are never overwritten.
   ------------------------------------------------------------------------- */
const UNIVERSE = (() => { try { return require('./market-universe.json'); } catch (e) { return []; } })();
const UNIVERSE_SEEDED = { done: false };
function ensureMarketCatalogue(db) {
  if (!db) {
    db = { users: [], stocks: [], products: [], orders: [], messages: [], txs: [], vendors: [], deposits: [], withdrawals: [], contacts: [], notifications: [], statuses: [], chatsMeta: {}, alerts: [], blocks: [], settings: {}, trades: [], holdings: [], watchlist: [], meta: {} };
  }
  if (!Array.isArray(db.stocks)) db.stocks = [];
  const have = new Set(db.stocks.filter((s) => s && s.ticker).map((s) => String(s.ticker).toUpperCase()));
  const before = db.stocks.length;
  UNIVERSE.forEach((r) => {
    const t = String(r.ticker || '').toUpperCase();
    if (!t || have.has(t)) return;
    have.add(t);
    const crypto = r.assetClass === 'crypto';
    db.stocks.push({
      id: 'st_' + t.toLowerCase().replace(/[^a-z0-9]/g, ''),
      ticker: t,
      displayTicker: crypto ? t.replace(/USDT$/, '/USDT') : (r.displayTicker || t),
      finnhubSymbol: crypto ? 'BINANCE:' + t : (r.displayTicker || t),
      assetClass: r.assetClass || 'us',
      name: r.name || t,
      exchange: r.exchange || (crypto ? 'Binance' : 'US'),
      currency: crypto ? 'USDT' : 'USD',
      color: '#2ee6c9',
      sector: r.sector || (crypto ? 'Crypto' : 'Stock'),
      provider: r.provider || (crypto ? 'binance' : 'finnhub'),
      price: Number(r.price) || 0,
      prevClose: Number(r.price) || 0,
      pe: 0, mcap: 0, div: 0, vol: 10,
      crypto, synthetic: false, paused: false, custom: false,
      twentyFourSeven: crypto || r.sector === 'Indices',
      createdAt: Date.now()
    });
  });
  if (!have.has('WC')) {
    db.stocks.push({
      id: 'st_wc', ticker: 'WC', displayTicker: 'WC', finnhubSymbol: 'WC',
      assetClass: 'us', name: 'WhaleChat (WC)', exchange: 'WhaleChat', currency: 'USD',
      color: '#2ee6c9', sector: 'Company', price: 12.5, prevClose: 12.5, div: 0, vol: 5,
      pe: 0, mcap: 0, paused: false, custom: false, synthetic: true, twentyFourSeven: true,
      createdAt: Date.now()
    });
  }
  if (!db.invest || typeof db.invest !== 'object') db.invest = { feePct: 0.5, paused: {} };
  if (!db.invest.classes || typeof db.invest.classes !== 'object') {
    db.invest.classes = { us: true, global: true, forex: true, crypto: true };
  } else {
    const keys = ['us', 'global', 'forex', 'crypto'];
    if (keys.every((k) => db.invest.classes[k] === false)) db.invest.classes = { us: true, global: true, forex: true, crypto: true };
  }
  if (db.stocks.length !== before) UNIVERSE_SEEDED.done = true;
  return db;
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
  return ensureMarketCatalogue(out);
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
async function apiRaw(url, opts) {
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) { return { ok: false, status: 0, json: null, text: '', error: e.message }; }
}


/* =========================================================================
   WhaleChat Shares — payout / profit engine (ported from server.js/shares.js)
   -------------------------------------------------------------------------
   The same ShareService class the Render server runs is bundled into this
   Function, so plans, accruals, maturities and payouts are computed here and
   stored in Appwrite Storage. There is no long-running timer in a Function:
   the engine ticks lazily on reads/writes, and because accrual is a pure
   function of elapsed time, a member sees exactly the same numbers as before.
   ========================================================================= */
function shareServiceFor(st) {
  return new ShareService({ getDb: () => st.db, persist: () => {}, broadcast: () => {} });
}
function marketTickDue(st, minAgeMs) {
  const m = st && st.db && st.db.shareMarket;
  const last = m ? Number(m.updatedAt) || 0 : 0;
  return Date.now() - last >= (minAgeMs || 4000);
}
async function saveState(st) {
  st.rev = Math.max(1, Number(st.rev) || 0) + 1;
  st.at = Date.now();
  return writeJsonFile(STATE_FILE, 'whalechat-state.json', st);
}
async function sharesRoute(req, res, mode, fn) {
  const st = await readState();
  if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
  const svc = shareServiceFor(st);
  try { svc.ensureDefaults(st.db); } catch (e) {}
  const ticked = marketTickDue(st, 4000);
  if (ticked) { try { svc.tick(); } catch (e) {} }
  let out;
  try { out = fn(svc, st); }
  catch (e) { return res.json({ ok: false, error: e.message, message: e.message }, 200, CORS); }
  if (mode === 'write' || ticked) {
    const ok = await saveState(st);
    if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
  }
  return res.json(out, 200, CORS);
}
function isAdminRequest(req, body, st, query) {
  const headers = req.headers || {};
  const tok = headers['x-admin-token'] || headers['X-Admin-Token'] || body.token;
  if (tok) {
    const payload = verifyToken(String(tok));
    if (payload && payload.role === 'admin') {
      const u = (st.db && st.db.users || []).find((x) => x && x.id === payload.sub && x.role === 'admin' && !x.banned);
      if (u) return u;
    }
  }
  const id = String((body && body.adminId) || (query && query.adminId) || '');
  if (id) return (st.db && st.db.users || []).find((x) => x && x.role === 'admin' && !x.banned && x.id === id) || null;
  return null;
}

/* =========================================================================
   Market data proxy — provider keys live in Function environment variables
   -------------------------------------------------------------------------
   FINNHUB_API_KEY  (or FINNHUB_KEY)   · US / global / forex quotes
   TWELVE_DATA_API_KEY (or TWELVEDATA_API_KEY) · stocks, forex, indices
   Keys never reach the browser: devices call /api/market/proxy and this
   Function talks to the provider.
   ========================================================================= */
const FINNHUB_KEY = String(process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY || process.env.WC_FINNHUB_KEY || '').trim();
const TWELVE_KEY = String(process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY || process.env.TWELVE_DATA_KEY || process.env.WC_TWELVEDATA_KEY || '').trim();
const PROXY_CACHE = new Map();
const PROXY_CACHE_MS = 8000;
/* 3.66.3 — last known real quote per ticker. The providers cap each call
   (Finnhub 12/min-ish, Yahoo cooling), so a single request can only price a
   slice of the catalogue. Remembering every real quote lets later polls fill
   in the rest of the 100+ stock list instead of showing blanks. */
const LAST_QUOTES = new Map();
const LAST_QUOTE_MS = 15 * 60 * 1000;
function rememberQuotes(quotes) {
  const now = Date.now();
  Object.keys(quotes || {}).forEach((k) => {
    const q = quotes[k];
    if (q && Number(q.price) > 0) LAST_QUOTES.set(String(k).toUpperCase(), { at: now, q });
  });
  if (LAST_QUOTES.size > 2000) {
    for (const [k, v] of LAST_QUOTES) { if (now - v.at > LAST_QUOTE_MS) LAST_QUOTES.delete(k); }
  }
}
function topUpFromMemory(quotes, list) {
  let n = 0;
  const now = Date.now();
  (list || []).forEach((sym) => {
    if (quotes[sym]) return;
    const hit = LAST_QUOTES.get(String(sym).toUpperCase());
    if (hit && now - hit.at < LAST_QUOTE_MS) {
      quotes[sym] = Object.assign({}, hit.q, { cached: true, staleMs: now - hit.at });
      n++;
    }
  });
  return n;
}

function cacheGet(key) {
  const hit = PROXY_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PROXY_CACHE_MS) { PROXY_CACHE.delete(key); return null; }
  return hit.quotes;
}
function cacheSet(key, quotes) {
  if (PROXY_CACHE.size > 200) PROXY_CACHE.clear();
  PROXY_CACHE.set(key, { at: Date.now(), quotes });
}

function normQuote(price, prevClose, extra) {
  const p = Number(price);
  if (!(p > 0)) return null;
  const pc = Number(prevClose) > 0 ? Number(prevClose) : p;
  return {
    price: p, prevClose: pc,
    open: Number(extra && extra.open) || pc,
    dayHigh: Number(extra && extra.high) || p,
    dayLow: Number(extra && extra.low) || p,
    vol: Number(extra && extra.vol) || 0,
    changePct: pc ? ((p - pc) / pc) * 100 : 0,
    changeUsd: p - pc,
    updatedAt: Number(extra && extra.at) || Date.now(),
    source: (extra && extra.source) || 'provider'
  };
}

const FH_CACHE = new Map();
/* Finnhub free plan = 60 calls/min. Keep a per-instance budget so several
   devices polling at once cannot burn the key; callers get cached values. */
let FH_WINDOW = { at: 0, n: 0 };
let LAST_FH = { returned: 0, budget: 0, chunk: 0, todo: 0 };
function fhBudget() {
  const now = Date.now();
  if (now - FH_WINDOW.at > 60000) FH_WINDOW = { at: now, n: 0 };
  return Math.max(0, 45 - FH_WINDOW.n);
}
const GLOBAL_ADR = {
  'VOD.L': 'VOD', 'SHEL.L': 'SHEL', 'AZN.L': 'AZN', 'HSBA.L': 'HSBC', 'ULVR.L': 'UL',
  'BP.L': 'BP', 'GSK.L': 'GSK', 'RIO.L': 'RIO', 'BARC.L': 'BCS', 'LLOY.L': 'LYG',
  'SAP.DE': 'SAP', 'SIE.DE': 'SIEGY', 'ALV.DE': 'ALIZY', 'BMW.DE': 'BMWYY', 'MBG.DE': 'MBGAF',
  'BAS.DE': 'BASFY', 'AIR.DE': 'EADSY', 'MC.PA': 'LVMUY', 'OR.PA': 'LRLCY', 'TTE.PA': 'TTE',
  'SAN.PA': 'SNY', 'NESN.SW': 'NSRGY', 'ROG.SW': 'RHHBY', 'NOVN.SW': 'NVS', '7203.T': 'TM',
  '6758.T': 'SONY', '9984.T': 'SFTBY', '005930.KS': 'SSNLF', '0700.HK': 'TCEHY', '9988.HK': 'BABA',
  'SHOP.TO': 'SHOP', 'RY.TO': 'RY', 'TD.TO': 'TD', 'ENB.TO': 'ENB', 'CNR.TO': 'CNI', 'NIO': 'NIO'
};
/* indices/commodities use CNBC + gold-api below, so Finnhub never proxies them */
function finnhubSymbolFor(sym) {
  const s = String(sym || '').toUpperCase();
  if (GLOBAL_ADR[s]) return GLOBAL_ADR[s];
  if (FX.has(s)) return 'OANDA:' + s.slice(0, 3) + '_' + s.slice(3);
  return s;
}
async function finnhubQuotes(symbols, limit) {
  if (!FINNHUB_KEY) return {};
  const out = {};
  const now = Date.now();
  const todo = [];
  for (const sym of symbols) {
    const hit = FH_CACHE.get(sym);
    if (hit && now - hit.at < 55000) { out[sym] = hit.q; continue; }
    todo.push(sym);
  }
  /* Finnhub's free plan is 60 calls/min — cap fresh lookups per request and
     let the rotating client batches cover the whole list. */
  const budget = fhBudget();
  const chunk = todo.slice(0, Math.min(limit || 10, budget));
  LAST_FH = { returned: 0, budget, chunk: chunk.length, todo: todo.length };
  if (!chunk.length) return out;
  let cursor = 0;
  async function worker() {
    while (cursor < chunk.length) {
      const sym = chunk[cursor++];
      FH_WINDOW.n++;
      const r = await apiRaw('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(finnhubSymbolFor(sym)) + '&token=' + encodeURIComponent(FINNHUB_KEY));
      if (r.ok && r.json && Number(r.json.c) > 0) {
        const q = normQuote(r.json.c, r.json.pc, { open: r.json.o, high: r.json.h, low: r.json.l, at: (Number(r.json.t) || 0) * 1000, source: 'finnhub' });
        if (q) { out[sym] = q; FH_CACHE.set(sym, { at: Date.now(), q }); }
      }
    }
  }
  await Promise.all([worker(), worker(), worker()].map((p) => p.catch(() => {})));
  LAST_FH.returned = Object.keys(out).length;
  if (FH_CACHE.size > 1200) FH_CACHE.clear();
  return out;
}

async function twelvedataQuotes(symbols) {
  if (!TWELVE_KEY) return {};
  const list = symbols.slice(0, 60);
  const out = {};
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    const r = await apiRaw('https://api.twelvedata.com/quote?symbol=' + encodeURIComponent(chunk.join(',')) + '&apikey=' + encodeURIComponent(TWELVE_KEY));
    if (!r.ok || !r.json) continue;
    const data = r.json;
    if (data.status === 'error' || data.code) continue;
    const map = data.symbol ? (function () { const o = {}; o[data.symbol] = data; return o; })() : data;
    Object.keys(map).forEach((k) => {
      const q = map[k];
      if (!q || q.code || !q.symbol) return;
      out[q.symbol] = normQuote(q.close, q.previous_close, { open: q.open, high: q.high, low: q.low, vol: q.volume, source: 'twelvedata' });
    });
  }
  return out;
}


/* Yahoo Finance spark is a key-free breadth source: one request resolves many
   symbols (US, global listings, forex =X pairs, indices) and returns the last
   trade plus the previous close. Used to fill anything the keyed providers
   could not resolve, and as the whole feed when no keys are configured. */
const YAHOO_INDEX = {
  US30: '^DJI', US100: '^NDX', US500: '^GSPC', UK100: '^FTSE', DE40: '^GDAXI',
  JP225: '^N225', HK50: '^HSI', GOLD: 'GC=F', SILVER: 'SI=F', OIL: 'CL=F'
};
const FX = new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'CHFJPY', 'EURCHF', 'EURCAD', 'GBPCAD', 'GBPCHF', 'GBPAUD', 'AUDCAD', 'AUDCHF', 'AUDNZD', 'NZDJPY', 'NZDCAD', 'USDSEK', 'USDNOK', 'USDMXN', 'USDZAR', 'USDTRY', 'USDINR']);
function yahooSymbol(sym) {
  const s = String(sym || '').toUpperCase();
  if (YAHOO_INDEX[s]) return YAHOO_INDEX[s];
  if (FX.has(s)) return s.slice(0, 3) + s.slice(3) + '=X';
  return s;
}
let LAST_YAHOO = { status: 0, fetched: 0, at: 0 };
async function yahooSpark(chunk) {
  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  let last = { ok: false, status: 0 };
  for (const host of hosts) {
    const r = await apiRaw(host + '/v8/finance/spark?symbols=' + encodeURIComponent(chunk.join(',')) + '&range=1d&interval=5m', {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', accept: 'application/json' }
    });
    last = r;
    if (r.ok && r.json) return r;
    if (r.status !== 429 && r.status !== 0) return r;
  }
  return last;
}
async function yahooQuotes(symbols) {
  const list = symbols.slice(0, 60);
  const out = {};
  const map = {};
  list.forEach((s) => { map[yahooSymbol(s)] = s; });
  const wanted = Object.keys(map);
  LAST_YAHOO = { status: 0, fetched: 0, at: Date.now() };
  for (let i = 0; i < wanted.length; i += 30) {
    const chunk = wanted.slice(i, i + 30);
    const r = await yahooSpark(chunk);
    LAST_YAHOO.status = r.status || 0;
    if (!r.ok || !r.json) continue;
    LAST_YAHOO.fetched += 1;
    Object.keys(r.json).forEach((key) => {
      const d = r.json[key];
      if (!d || !Array.isArray(d.close) || !d.close.length) return;
      const closes = d.close.filter((x) => Number(x) > 0);
      if (!closes.length) return;
      const last = Number(closes[closes.length - 1]);
      const prev = Number(d.previousClose) || Number(d.chartPreviousClose) || last;
      const original = map[key] || map[key.toUpperCase()] || d.symbol || key;
      const q = normQuote(last, prev, { open: Number(closes[0]), vol: 0, at: (Number(d.end) || 0) * 1000, source: 'yahoo' });
      if (q) out[original] = q;
    });
  }
  return out;
}


/* Yahoo v8 chart fallback: the spark endpoint is often 401/429 while the
   chart endpoint still answers, and it carries the last two closes we need
   for a real quote. No invented prices. */
async function yahooChartQuotes(symbols) {
  const out = {};
  const list = (symbols || []).slice(0, 12);
  await Promise.all(list.map(async (sym) => {
    try {
      const y = yahooSymbol(sym);
      const r = await apiRaw('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(y) + '?interval=1d&range=5d', {
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', accept: 'application/json' }
      });
      if (!r.ok || !r.json) return;
      const res = r.json.chart && r.json.chart.result && r.json.chart.result[0];
      const q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
      const closes = (q && q.close || []).filter((x) => Number(x) > 0);
      if (!closes.length) return;
      const last = Number(closes[closes.length - 1]);
      const prev = Number(res.meta && res.meta.chartPreviousClose) || Number(closes[closes.length - 2]) || last;
      const nq = normQuote(last, prev, { open: Number(closes[0]), vol: 0, at: Date.now(), source: 'yahoo' });
      if (nq) out[String(sym).toUpperCase()] = nq;
    } catch (e) {}
  }));
  return out;
}

/* Key-free FX breadth: ECB reference rates via Frankfurter. Real rates, cached
   for ten minutes — used only for forex pairs the keyed providers miss. */
let FX_CACHE = { at: 0, rates: null };
async function frankfurterRates() {
  if (FX_CACHE.rates && Date.now() - FX_CACHE.at < 600000) return FX_CACHE.rates;
  const r = await apiRaw('https://api.frankfurter.dev/v1/latest?base=USD');
  if (!r.ok || !r.json || !r.json.rates) return null;
  const rates = Object.assign({ USD: 1 }, r.json.rates);
  FX_CACHE = { at: Date.now(), rates };
  return rates;
}
async function fxQuotes(symbols) {
  const pairs = symbols.filter((s) => FX.has(String(s).toUpperCase()));
  if (!pairs.length) return {};
  const rates = await frankfurterRates();
  if (!rates) return {};
  const out = {};
  pairs.forEach((sym) => {
    const s = String(sym).toUpperCase();
    const base = s.slice(0, 3), quote = s.slice(3);
    const rb = Number(rates[base]), rq = Number(rates[quote]);
    if (!(rb > 0) || !(rq > 0)) return;
    const price = rq / rb;
    const q = normQuote(price, price, { source: 'frankfurter', at: Date.now() });
    if (q) out[s] = q;
  });
  return out;
}


/* Real index levels + spot metals without a key.
   CNBC publishes the official index quote service; gold-api publishes spot
   XAU/XAG. Both are cached so a burst of devices cannot hammer them. */
const CNBC_MAP = { US30: '.DJI', US100: '.NDX', US500: '.SPX', UK100: '.FTSE', DE40: '.DAX', JP225: '.N225', HK50: '.HSI', OIL: '@CL.1' };
const SPOT_MAP = { GOLD: 'XAU', SILVER: 'XAG' };
let INDEX_CACHE = { at: 0, quotes: null };
let LAST_CNBC = { status: 0, count: 0, at: 0 };
let SPOT_CACHE = { at: 0, quotes: null };
function cnbcNum(v) { return Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0; }
async function cnbcIndexQuotes(symbols) {
  const wanted = symbols.filter((s) => CNBC_MAP[s]);
  if (!wanted.length) return {};
  if (INDEX_CACHE.quotes && Date.now() - INDEX_CACHE.at < 15000) {
    const cached = {};
    wanted.forEach((s) => { if (INDEX_CACHE.quotes[s]) cached[s] = INDEX_CACHE.quotes[s]; });
    if (Object.keys(cached).length) return cached;
  }
  const list = Object.values(CNBC_MAP);
  const r = await apiRaw('https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=' + encodeURIComponent(list.join('|')) + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json', {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }
  });
  if (!r.ok || !r.json) return {};
  LAST_CNBC = { status: r.status || 0, count: 0, at: Date.now() };
  const arr = (r.json.ITVQuoteResult && r.json.ITVQuoteResult.ITVQuote) || [];
  LAST_CNBC.count = Array.isArray(arr) ? arr.length : 0;
  if (!Array.isArray(arr)) return {};
  const bySymbol = {};
  arr.forEach((q) => { if (q && q.symbol) bySymbol[String(q.symbol).toUpperCase()] = q; });
  const out = {};
  Object.keys(CNBC_MAP).forEach((s) => {
    const q = bySymbol[CNBC_MAP[s].toUpperCase()];
    if (!q) return;
    const last = cnbcNum(q.last);
    if (!(last > 0)) return;
    const change = cnbcNum(q.change);
    const prev = change ? last - change : last;
    const nq = normQuote(last, prev, { open: cnbcNum(q.open), high: cnbcNum(q.high), low: cnbcNum(q.low), source: 'cnbc' });
    if (nq) out[s] = nq;
  });
  INDEX_CACHE = { at: Date.now(), quotes: out };
  const picked = {};
  wanted.forEach((s) => { if (out[s]) picked[s] = out[s]; });
  return picked;
}
async function spotQuotes(symbols) {
  const wanted = symbols.filter((s) => SPOT_MAP[s]);
  if (!wanted.length) return {};
  const out = {};
  const prevMap = (SPOT_CACHE.quotes || {});
  for (const sym of wanted) {
    const code = SPOT_MAP[sym];
    const r = await apiRaw('https://api.gold-api.com/price/' + code);
    if (!r.ok || !r.json || !(Number(r.json.price) > 0)) continue;
    const price = Number(r.json.price);
    const prev = prevMap[sym] && Number(prevMap[sym].price) > 0 ? Number(prevMap[sym].price) : price;
    const q = normQuote(price, prev, { source: 'gold-api', at: Date.now() });
    if (q) out[sym] = q;
  }
  SPOT_CACHE = { at: Date.now(), quotes: Object.assign({}, prevMap, out) };
  return out;
}

async function coinbaseQuotes(symbols) {
  const list = (symbols || []).map(x => String(x || '').toUpperCase().replace('/', '')).filter(x => /^[A-Z0-9]{2,10}USDT$/.test(x)).slice(0, 20);
  const out = {};
  await Promise.all(list.map(async (sym) => {
    const base = sym.replace(/USDT$/, '');
    const r = await apiRaw('https://api.coinbase.com/v2/prices/' + encodeURIComponent(base) + '-USD/spot');
    if (r.ok && r.json && r.json.data && Number(r.json.data.amount) > 0) {
      const price = Number(r.json.data.amount);
      out[sym] = normQuote(price, price, { source: 'coinbase', at: Date.now() });
    }
  }));
  return out;
}

async function binanceQuotes(symbols) {
  const list = (symbols || []).map(x => String(x || '').toUpperCase().replace('/', '')).filter(x => /^[A-Z0-9]{5,20}USDT$/.test(x)).slice(0, 40);
  if (!list.length) return {};
  const out = {};
  const url = 'https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(list));
  const r = await apiRaw(url);
  if (r.ok && Array.isArray(r.json)) {
    for (const x of r.json) {
      const sym = String(x.symbol || '').toUpperCase();
      const price = Number(x.lastPrice);
      if (!sym || !(price > 0)) continue;
      out[sym] = normQuote(price, Number(x.prevClosePrice) || price, { open: Number(x.openPrice), high: Number(x.highPrice), low: Number(x.lowPrice), vol: Number(x.volume), at: Date.now(), source: 'binance' });
    }
    return out;
  }
  const alt = await apiRaw('https://api.binance.com/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(list)));
  if (alt.ok && Array.isArray(alt.json)) {
    for (const x of alt.json) {
      const sym = String(x.symbol || '').toUpperCase();
      const price = Number(x.lastPrice);
      if (!sym || !(price > 0)) continue;
      out[sym] = normQuote(price, Number(x.prevClosePrice) || price, { open: Number(x.openPrice), high: Number(x.highPrice), low: Number(x.lowPrice), vol: Number(x.volume), at: Date.now(), source: 'binance' });
    }
  }
  return out;
}

async function proxyQuotes(provider, symbols) {
  const list = Array.from(new Set((symbols || []).map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 60);
  if (!list.length) return { ok: false, error: 'symbols_required' };
  const key = provider + '|' + list.join(',');
  const cached = cacheGet(key);
  if (cached) return { ok: true, cached: true, provider, quotes: cached, at: Date.now() };
  let quotes = {};
  let used = provider;
  if (provider === 'binance') {
    quotes = await binanceQuotes(list);
    used = 'binance';
  } else if (provider === 'twelvedata') {
    quotes = await twelvedataQuotes(list);
    used = 'twelvedata';
  } else if (provider === 'finnhub') {
    quotes = await finnhubQuotes(list, 30);
    used = 'finnhub';
  } else if (provider === 'yahoo') {
    quotes = await yahooQuotes(list);
    used = 'yahoo';
  } else {
    /* 0 · Binance public ticker for crypto pairs (no secret required) */
    const cryptoMissing = list.filter((x) => /USDT$/i.test(x));
    if (cryptoMissing.length) {
      const bq = await binanceQuotes(cryptoMissing);
      if (Object.keys(bq).length) { Object.assign(quotes, bq); used = 'binance'; }
      const stillMissing = cryptoMissing.filter((x) => !quotes[x]);
      if (stillMissing.length) {
        const cb = await coinbaseQuotes(stillMissing);
        if (Object.keys(cb).length) { Object.assign(quotes, cb); used = used === 'binance' ? 'hybrid' : 'coinbase'; }
      }
    }
    /* 1 · Finnhub (mapped to OANDA for FX and to index/commodity ETFs), 2 ·
       Twelve Data, 3 · Yahoo only if it is not currently rate-limiting us */
    if (FINNHUB_KEY) {
      /* indices/metals have their own sources — never let a same-named stock
         (e.g. Barrick's GOLD) stand in for spot gold */
      const fhList = list.filter((x) => !CNBC_MAP[x] && !SPOT_MAP[x]);
      /* 3.66.3: 24 per call (the free tier allows ~60 calls/min, and the
         client polls every 25 s) so the 100+ stock list fills ~2x faster. */
      const fresh = await finnhubQuotes(fhList, 24);
      if (Object.keys(fresh).length) { Object.assign(quotes, fresh); used = 'finnhub'; }
    }
    if (TWELVE_KEY) {
      /* Twelve Data's free plan allows 8 credits/min (1 per symbol): spend
         only a couple per call and let the rotation cover the long tail */
      const missing = list.filter((x) => !quotes[x]).slice(0, 2);
      if (missing.length) {
        const more = await twelvedataQuotes(missing);
        if (Object.keys(more).length) { Object.assign(quotes, more); used = 'hybrid'; }
      }
    }
    const fxMissing = list.filter((x) => !quotes[x]);
    if (fxMissing.length) {
      const fx = await fxQuotes(fxMissing);
      if (Object.keys(fx).length) { Object.assign(quotes, fx); used = used === 'finnhub' ? 'hybrid' : used; }
    }
    const idxMissing = list.filter((x) => !quotes[x]);
    if (idxMissing.length) {
      const ix = await cnbcIndexQuotes(idxMissing);
      if (Object.keys(ix).length) { Object.assign(quotes, ix); used = used === 'finnhub' ? 'hybrid' : used; }
      const sp = await spotQuotes(idxMissing.filter((x) => !quotes[x]));
      if (Object.keys(sp).length) { Object.assign(quotes, sp); used = used === 'finnhub' ? 'hybrid' : used; }
    }
    const yahooCooling = LAST_YAHOO.status === 429 && Date.now() - (LAST_YAHOO.at || 0) < 300000;
    if (!yahooCooling) {
      const missing = list.filter((x) => !quotes[x]);
      if (missing.length) {
        const more = await yahooQuotes(missing);
        if (Object.keys(more).length) { Object.assign(quotes, more); used = used === 'finnhub' ? 'hybrid' : 'yahoo'; }
      }
    }
    /* last resort for stocks when Finnhub is rate-limited / Twelve Data is not
       configured: Yahoo's chart endpoint still returns the real close */
    const chartMissing = list.filter((x) => !quotes[x]).slice(0, 24);
    if (chartMissing.length) {
      const cq = await yahooChartQuotes(chartMissing);
      if (Object.keys(cq).length) { Object.assign(quotes, cq); used = used === 'auto' ? 'yahoo' : used; }
    }
  }
  /* fill the rest of the list with real prices seen in the last 15 minutes */
  rememberQuotes(quotes);
  topUpFromMemory(quotes, list);
  cacheSet(key, quotes);
  return { ok: true, provider: used, quotes, at: Date.now(), configured: { finnhub: !!FINNHUB_KEY, twelvedata: !!TWELVE_KEY }, debug: Object.assign({}, LAST_YAHOO, { cnbc: LAST_CNBC, fh: LAST_FH }) };
}


/* =========================================================================
   WhaleChat Bots — engine ported from server-side bots.js
   -------------------------------------------------------------------------
   Bots keep trading while the phone is off: the engine is ticked lazily on
   every state read (and at most once a minute), so elapsed intervals are
   settled server-side. No frontend JS is needed for a bot to trade.
   ========================================================================= */
const BOT_DEFAULT_SETTINGS = {
  intervalMin: 5, minCapitalCoins: 20, minPoolPct: 10, stakePct: 20,
  winPct: 4, lossPct: 6, leverage: 5, tradeFeePct: 0.5,
  autoSecurePriceUsd: 20, autoSecureCycle: 'monthly'
};
function tickerRow(st, ticker) {
  const t = String(ticker || '').toUpperCase();
  return (st.db.stocks || []).find((x) => x && String(x.ticker).toUpperCase() === t) || null;
}
async function hydrateLiveQuotes(st, svc, onlyTickers) {
  let symbols = Array.isArray(onlyTickers) ? onlyTickers.slice() : [];
  if (!symbols.length) {
    const open = new Set((st.db.trades || []).filter(t => t && t.status === 'Open' && t.type === 'live').map(t => t.ticker));
    symbols = Array.from(open);
  }
  const pairs = [];
  for (const ticker of symbols) {
    const row = tickerRow(st, ticker);
    if (!row) continue;
    const providerSym = String(row.finnhubSymbol || row.ticker).replace(/^BINANCE:/i, '').replace(/^OANDA:/i, '').replace('_', '/');
    pairs.push({ ticker: String(ticker).toUpperCase(), sym: providerSym });
  }
  if (!pairs.length) return 0;
  try {
    const out = await proxyQuotes('auto', pairs.map(p => p.sym));
    const quotes = (out && out.quotes) || {};
    let n = 0;
    for (const p of pairs) {
      let q = quotes[p.sym] || quotes[p.sym.toUpperCase()];
      if (!q) {
        const foundKey = Object.keys(quotes).find(k => k.toUpperCase() === p.sym.toUpperCase());
        if (foundKey) q = quotes[foundKey];
      }
      if (q && Number(q.price) > 0) {
        const at = Date.now();
        svc.quotes[p.ticker] = Object.assign({}, q, { price: Number(q.price), prevClose: Number(q.prevClose) || Number(q.price), updatedAt: at, real: true });
        /* 3.66.1: a hydrated real quote must also be recorded as a real tick,
           otherwise status() reports realTickers:0 / source:'offline' while the
           prices on screen are live — which is exactly what turned the
           account-page provider dots grey and printed "no tick yet". */
        svc.lastReal[p.ticker] = Number(q.price);
        svc.lastRealTime[p.ticker] = at;
        svc.lastRealAt = at;
        svc.lastTickAt = at;
        if (q.source === 'twelvedata') svc.lastTwelveAt = at;
        else if (q.source === 'binance' || q.source === 'coinbase') svc.lastBinanceAt = at;
        else svc.lastFinnhubAt = at;
        const row = tickerRow(st, p.ticker);
        if (row) { row.price = Number(q.price); row.prevClose = Number(q.prevClose) || row.price; row.updatedAt = at; }
        n++;
      }
    }
    return n;
  } catch (e) { return 0; }
}
function marketServiceFor(st) {
  const svc = new MarketService({
    dataDir: '/tmp',
    getDb: () => st.db,
    persist: () => {},
    broadcast: () => {}
  });
  /* 3.66.1: the service was created with its default 'simulated' config, so
     every status block claimed hasKey:false / source:'offline' / 'no-finnhub'
     even though FINNHUB_KEY is set in the function environment and the proxy
     was returning real prices. Adopt the environment keys here. */
  try {
    const cfgKey = FINNHUB_KEY || TWELVE_KEY || '';
    svc.config = {
      mode: cfgKey ? 'hybrid' : 'simulated',
      apiKey: FINNHUB_KEY || '',
      refreshSec: 15,
      twelvedataKey: TWELVE_KEY || ''
    };
  } catch (e) {}
  for (const row of (st.db.stocks || [])) {
    if (!row || !row.ticker) continue;
    const px = Number(row.price) || 0;
    if (px > 0) svc.quotes[String(row.ticker).toUpperCase()] = {
      price: px, prevClose: Number(row.prevClose) || px,
      open: Number(row.open) || px, dayHigh: Number(row.high) || px,
      dayLow: Number(row.low) || px, updatedAt: Date.now(), real: true
    };
  }
  return svc;
}
/* -------------------------------------------------------------------------
   Real provider market data (Binance klines / Finnhub / Twelve Data)
   ------------------------------------------------------------------------- */
function providerSymbolFor(st, ticker) {
  const t = String(ticker || '').toUpperCase().trim();
  if (!t) return '';
  const row = (st && st.db && st.db.stocks || []).find((x) => x && (String(x.ticker).toUpperCase() === t || String(x.displayTicker || '').toUpperCase() === t));
  const raw = row && row.finnhubSymbol ? String(row.finnhubSymbol) : t;
  return raw.replace(/^BINANCE:/i, '').replace(/^OANDA:/i, '').replace(/^FOREXCOM:/i, '').replace(/_/g, '').replace(/\//g, '');
}
let _marketData = null;
function marketDataFor() {
  if (_marketData) return _marketData;
  _marketData = createMarketData({
    connections: {
      stored: () => ({
        finnhub: { apiKey: FINNHUB_KEY },
        binance: {},
        marketData: { twelvedata: { apiKey: TWELVE_KEY }, binance: {} }
      })
    },
    log: () => {}
  });
  return _marketData;
}

/* Spot stock book (manual buy/sell + TP/SL) */
function spotServiceFor(st, svc) {
  return new SpotService({
    getDb: () => st.db,
    persist: () => {},
    broadcast: () => {},
    getQuote: (ticker) => {
      const t = String(ticker || '').toUpperCase();
      const q = svc && svc.quotes && svc.quotes[t];
      if (q && Number(q.price) > 0) return q;
      const row = (st.db.stocks || []).find((x) => x && String(x.ticker).toUpperCase() === t);
      return row && Number(row.price) > 0 ? { price: Number(row.price), prevClose: Number(row.prevClose) || Number(row.price) } : null;
    }
  });
}

/* Hydrate quotes for everything the Auto Buy/Sell watcher and spot TP/SL need. */
function autoWatchTickers(db) {
  const out = new Set();
  (db.users || []).forEach((u) => {
    const a = u && u.investAcct || {};
    (a.b2bAlerts || []).forEach((al) => { if (al && al.auto && al.ticker) out.add(String(al.ticker).toUpperCase()); });
    Object.keys(a.b2b || {}).forEach((t) => out.add(String(t).toUpperCase()));
  });
  (db.holdings || []).forEach((h) => { if (h && h.ticker) out.add(String(h.ticker).toUpperCase()); });
  return Array.from(out).slice(0, 60);
}
let lastB2bPollAt = 0;
function b2bSig(db) {
  try {
    return JSON.stringify((db.users || []).map((u) => {
      const a = (u && u.investAcct) || {};
      return [u.id,
        a.portfolios && a.portfolios.b2b, a.b2bProfit,
        (a.b2bAlerts || []).map((x) => [x.id, x.auto, x.autoState, x.autoUnits, x.autoError, x.sell])];
    }));
  } catch (e) { return ''; }
}
async function b2bTick(st, svc) {
  try {
    const db = st.db;
    if (!db) return false;
    const hasAlerts = (db.users || []).some((u) => u && u.investAcct && Array.isArray(u.investAcct.b2bAlerts) && u.investAcct.b2bAlerts.some((a) => a && a.auto));
    if (!hasAlerts) return false;
    const tickers = autoWatchTickers(db);
    if (tickers.length) await hydrateLiveQuotes(st, svc, tickers);
    const watcher = createB2BAlertWatcher({
      getDb: () => st.db,
      persist: () => {},
      broadcast: () => {},
      quotes: () => (svc && svc.quotes) || {},
      email: null,
      appUrl: () => process.env.PUBLIC_URL || 'https://whalechat.appwrite.network',
      everyMs: 15000
    });
    watcher.run();
    lastB2bPollAt = Date.now();
    return true;
  } catch (e) { return false; }
}

function botServiceFor(st, marketSvc) {
  return new BotService({
    getDb: () => st.db,
    persist: () => {},
    broadcast: () => {},
    market: marketSvc,
    getQuote: (ticker) => {
      try {
        const row = (st.db.stocks || []).find((x) => x && String(x.ticker).toUpperCase() === String(ticker).toUpperCase());
        const px = row && Number(row.price) > 0 ? Number(row.price) : (marketSvc && marketSvc.quotes[String(ticker).toUpperCase()] || {}).price;
        return px > 0 ? { price: px } : null;
      } catch (e) { return null; }
    }
  });
}
function botTickDue(st) {
  const t = st && st.db ? Number(st.db.botLastTickAt) || 0 : 0;
  return Date.now() - t >= 60000;
}
/* settle every interval a bot missed while no device was open */
function botCatchUp(svc, st) {
  let n = 0;
  for (let i = 0; i < 20; i++) {
    let changed = 0;
    try { changed = svc.tick(); } catch (e) { break; }
    n += changed ? 1 : 0;
    if (!changed) break;
  }
  st.db.botLastTickAt = Date.now();
  return n;
}
async function botsRoute(req, res, mode, fn) {
  const st = await readState();
  if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
  const marketSvc = marketServiceFor(st);
  try { await hydrateLiveQuotes(st, marketSvc, null); } catch (e) {}
  const svc = botServiceFor(st, marketSvc);
  try { svc.ensureDefaults(st.db); } catch (e) {}
  let ticked = false;
  if (mode !== 'read' || botTickDue(st)) { try { botCatchUp(svc, st); ticked = true; } catch (e) {} }
  let out;
  try { out = fn(svc, st); }
  catch (e) { return res.json({ ok: false, error: e.message, message: e.message }, 200, CORS); }
  if (mode !== 'read' || ticked) {
    const ok = await saveState(st);
    if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
  }
  return res.json(out, 200, CORS);
}

/* =========================================================================
   WhaleChat WC-Investing — server-side daily interest
   -------------------------------------------------------------------------
   Plans live in user.investAcct.wcInvest. Every state read settles elapsed
   days against the server's WC share price and matures plans on time, so
   interest accrues while the user is offline. Mirrors the client engine.
   ========================================================================= */
const WC_RATE = 0.5;
const WC_DEFAULT_PLANS = [
  { id: 'starter', name: 'Whale Starter', ratePct: 3, days: 7, minUsd: 10, maxUsd: 500, blurb: 'One-week plan · daily return on the shares you hold.' },
  { id: 'growth', name: 'Whale Growth', ratePct: 5, days: 14, minUsd: 50, maxUsd: 2500, blurb: 'Two-week plan · higher daily return.' },
  { id: 'elite', name: 'Whale Elite', ratePct: 8, days: 30, minUsd: 250, maxUsd: 25000, blurb: 'Monthly plan for larger allocations.' }
];
function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function r4(v) { return Math.round((Number(v) || 0) * 10000) / 10000; }
function wcWallet(u) {
  if (!u.investAcct) u.investAcct = { usd: 0, payout: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 } };
  const a = u.investAcct;
  if (!a.wcInvest || typeof a.wcInvest !== 'object') {
    a.wcInvest = { capital: 0, profit: 0, leftover: 0, autoReinvest: false, plans: [], history: [] };
  }
  const w = a.wcInvest;
  if (!Array.isArray(w.plans)) w.plans = [];
  if (!Array.isArray(w.history)) w.history = [];
  return w;
}
function wcPrice(db) {
  const m = db.shareMarket || {};
  const p = Number(m.priceUsd);
  return p > 0 ? p : Number(m.basePriceUsd) || 12.5;
}
function wcPlanCatalog(db) {
  if (!Array.isArray(db.wcPlans) || !db.wcPlans.length) db.wcPlans = WC_DEFAULT_PLANS.map((p) => Object.assign({}, p));
  return db.wcPlans;
}
function wcSweep(db, minGapMs) {
  if (!db || !Array.isArray(db.users)) return false;
  const now = Date.now();
  const price = wcPrice(db);
  const last = Number(db.wcLastSweepAt) || 0;
  const due = now - last >= (minGapMs == null ? 60000 : minGapMs);
  let changed = false;
  wcPlanCatalog(db);
  db.users.forEach((u) => {
    if (!u) return;
    const w = wcWallet(u);
    (w.plans || []).forEach((inv) => {
      if (!inv || inv.status !== 'active') return;
      const days = Math.max(1, Number(inv.days) || 1);
      const capital = Number(inv.capitalUsd) || 0;
      const start = Number(inv.startedAt) || now;
      const end = Number(inv.endsAt) || start + days * 864e5;
      const elapsedDays = Math.min(days, Math.max(0, Math.floor((Math.min(now, end) - start) / 864e5)));
      inv.priceLog = Array.isArray(inv.priceLog) ? inv.priceLog : [];
      if (!inv.priceLog.length) { inv.priceLog.push(r4(inv.entryPriceUsd || price)); changed = true; }
      if (due) {
        while (inv.priceLog.length < elapsedDays + 1 && inv.priceLog.length < days) {
          inv.priceLog.push(r4(price));
          changed = true;
        }
        const day = inv.priceLog.length - 1;
        if (day >= 0 && inv.priceLog[day] !== r4(price) && elapsedDays >= day) {
          inv.priceLog[day] = r4(price);
          changed = true;
        }
      }
      if (now < end) return;
      while (inv.priceLog.length < days) inv.priceLog.push(r4(price));
      const prices = inv.priceLog.slice(0, days);
      const avg = prices.reduce((a, p) => a + (Number(p) || 0), 0) / days;
      const profit = r2(prices.reduce((a, p) => a + (Number(p) || 0) * (Number(inv.ratePct) || 0) / 100 * capital, 0));
      inv.status = 'completed';
      inv.completedAt = now;
      inv.maturedPriceUsd = price;
      inv.avgPriceUsd = r4(avg);
      inv.maturityRoiUsd = profit;
      w.capital = r2((Number(w.capital) || 0) + capital);
      w.profit = r2((Number(w.profit) || 0) + profit);
      w.history.unshift({ id: 'wch_' + now.toString(36) + Math.random().toString(36).slice(2, 6), planName: inv.planName, capitalUsd: capital, profitUsd: profit, at: now });
      if (w.history.length > 200) w.history.length = 200;
      changed = true;
    });
  });
  if (due) db.wcLastSweepAt = now;
  return changed;
}
function wcStatePayload(db, userId) {
  const u = (db.users || []).find((x) => x && x.id === userId);
  if (!u) return { ok: false, error: 'user_not_found' };
  const w = wcWallet(u);
  const price = wcPrice(db);
  const plans = wcPlanCatalog(db);
  const view = (w.plans || []).map((inv) => {
    const days = Math.max(1, Number(inv.days) || 1);
    const start = Number(inv.startedAt) || Date.now();
    const end = Number(inv.endsAt) || start + days * 864e5;
    const active = inv.status === 'active';
    let accrued = 0;
    if (inv.status === 'completed') accrued = Number(inv.maturityRoiUsd) || 0;
    else {
      const log = (inv.priceLog || []).slice(0, Math.max(1, Math.min(days, Math.floor((Date.now() - start) / 864e5) + 1)));
      accrued = r2(log.reduce((a, p) => a + (Number(p) || 0) * (Number(inv.ratePct) || 0) / 100 * (Number(inv.capitalUsd) || 0), 0));
    }
    return Object.assign({}, inv, {
      accruedUsd: accrued,
      valueUsd: r2((Number(inv.capitalUsd) || 0) + accrued),
      progressPct: inv.status === 'completed' ? 100 : Math.min(100, Math.max(0, ((Date.now() - start) / Math.max(1, end - start)) * 100)),
      daysLeft: inv.status === 'completed' ? 0 : Math.max(0, Math.ceil((end - Date.now()) / 864e5)),
      serverActive: active
    });
  });
  return {
    ok: true,
    plans, investments: view, history: (w.history || []).slice(0, 40),
    wallet: { capitalUsd: r2(w.capital), profitUsd: r2(w.profit), leftoverUsd: r2(w.leftover), autoReinvest: !!w.autoReinvest },
    sharePriceUsd: r4(price), coinsPerUsd: 2, serverTime: Date.now()
  };
}

module.exports = async ({ req, res, log, error }) => {
  let method = (req.method || 'GET').toUpperCase();
  let path = String(req.path || '/').replace(/\/+$/, '') || '/';
  if (method === 'OPTIONS') return res.send('', 204, CORS);
  let body = {};
  /* Appwrite forwards the execution payload as req.bodyRaw for /executions
     calls, and as a parsed req.body for function-domain HTTP calls. */
  try {
    const rawBody = (req.bodyRaw !== undefined && req.bodyRaw !== null && req.bodyRaw !== '') ? req.bodyRaw : req.body;
    body = rawBody ? (typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody) : {};
  } catch (e) { body = {}; }

  /* ---- call envelope (3.64) ---------------------------------------------
     Appwrite's /executions endpoint always delivers path "/", so the web app
     posts { __wcPath, __wcMethod, __wcQuery, __wcPayload } instead. This keeps
     one function serving the full /api/* surface unchanged. */
  if (body && typeof body === 'object' && body.__wcPath) {
    path = String(body.__wcPath).replace(/\/+$/, '') || '/';
    method = String(body.__wcMethod || 'POST').toUpperCase();
    const payload = body.__wcPayload && typeof body.__wcPayload === 'object' ? body.__wcPayload : {};
    body = payload;
    if (body === null || typeof body !== 'object') body = {};
    /* re-expose the query string to the routes that read req.query */
    try {
      const qs = body.__wcQuery && typeof body.__wcQuery === 'object' ? body.__wcQuery : {};
      const merged = Object.assign({}, req.query || {}, qs);
      req = Object.assign(Object.create(Object.getPrototypeOf(req)), req, { query: merged, path, method });
    } catch (e) {}
  }

  try {
    /* Appwrite cron invocation: settle every server-side engine even when no
       device is open, then return. This is what keeps bots trading 24/7. */
    const trigger = String((req.headers && (req.headers['x-appwrite-trigger'] || req.headers['X-Appwrite-Trigger'])) || '');
    if (trigger === 'schedule') {
      const st = await readState();
      let changed = false;
      try {
        const svc = shareServiceFor(st);
        svc.ensureDefaults(st.db);
        svc.tick();
        changed = true;
      } catch (e) {}
      try {
        if (botTickDue(st)) {
          const b = botServiceFor(st);
          b.ensureDefaults(st.db);
          botCatchUp(b, st);
          changed = true;
        }
      } catch (e) {}
      try { if (wcSweep(st.db, 60000)) changed = true; } catch (e) {}
      try {
        const ms = marketServiceFor(st);
        if (await b2bTick(st, ms)) changed = true;
        const hts = Array.from(new Set((st.db.holdings || []).map((h) => h && h.ticker).filter(Boolean)));
        if (hts.length) { await hydrateLiveQuotes(st, ms, hts); if (spotServiceFor(st, ms).settle()) changed = true; }
      } catch (e) {}
      if (changed) await saveState(st);
      return res.json({ ok: true, engine: 'cron', rev: st.rev || 0, at: Date.now() }, 200, CORS);
    }

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


    /* ---------------- admin session (auto, no unlock code) ---------------- */
    if (path === '/api/admin/session/auto' && method === 'POST') {
      const st = await readState();
      const id = String(body.userId || '');
      const u = (st.db && st.db.users || []).find((x) => x && x.id === id && x.role === 'admin' && !x.banned);
      if (!u) return res.json({ ok: false, error: 'admin_only' }, 403, CORS);
      const now = Date.now();
      return res.json({ ok: true, token: signToken({ sub: u.id, email: u.email || '', role: 'admin', exp: now + ADMIN_TTL }), adminId: u.id, expiresAt: now + ADMIN_TTL }, 200, CORS);
    }



    /* ---------------- public engine tick (no cron on this plan) ------------- */
    if ((path === '/api/engine/tick' || path === '/api/engine/tick/') && (method === 'GET' || method === 'POST')) {
      const st = await readState();
      if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
      let botsTrades = 0, sharesTicked = false, wcChanged = false;
      try {
        const svc = shareServiceFor(st);
        svc.ensureDefaults(st.db);
        svc.tick();
        sharesTicked = true;
      } catch (e) {}
      try {
        const b = botServiceFor(st);
        b.ensureDefaults(st.db);
        botsTrades = botCatchUp(b, st);
      } catch (e) {}
      try { wcChanged = wcSweep(st.db, 0); } catch (e) {}
      let b2bTicked = false, spotClosed = 0;
      try {
        const ms = marketServiceFor(st);
        b2bTicked = await b2bTick(st, ms);
        const hts = Array.from(new Set((st.db.holdings || []).map((h) => h && h.ticker).filter(Boolean)));
        if (hts.length) { await hydrateLiveQuotes(st, ms, hts); spotClosed = spotServiceFor(st, ms).settle(); }
      } catch (e) {}
      const ok = await saveState(st);
      return res.json({
        ok: !!ok, engine: 'tick', rev: st.rev || 0, at: Date.now(),
        botsTrades, sharesTicked, wcChanged, b2bTicked, spotClosed,
        sessions: (st.db.botSessions || []).filter((x) => x && x.status === 'running').length
      }, ok ? 200 : 502, CORS);
    }

    /* ---------------- live trade close / take profit / secured profits ---------------- */
    if (path === '/api/market/trade/take-profit' && method === 'POST') {
      const st = await readState();
      if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
      const trade = (st.db.trades || []).find(t => t && t.id === String(body.tradeId || '') && t.userId === String(body.userId || '') && t.status === 'Open');
      if (!trade) return res.json({ ok: false, error: 'That trade is not open' }, 200, CORS);
      const svc = marketServiceFor(st);
      await hydrateLiveQuotes(st, svc, [trade.ticker]);
      try {
        const out = svc.takeProfitTrade(String(body.userId || ''), String(body.tradeId || ''));
        const ok = await saveState(st);
        if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
        return res.json(out, 200, CORS);
      } catch (e) { return res.json({ ok: false, error: e.message, message: e.message }, 200, CORS); }
    }
    if (path === '/api/market/trade/close' && method === 'POST') {
      const st = await readState();
      if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
      const trade = (st.db.trades || []).find(t => t && t.id === String(body.tradeId || '') && t.userId === String(body.userId || '') && t.status === 'Open');
      if (!trade) return res.json({ ok: false, error: 'That trade is not open' }, 200, CORS);
      const svc = marketServiceFor(st);
      await hydrateLiveQuotes(st, svc, [trade.ticker]);
      try {
        const out = svc.closeTradeManual(String(body.userId || ''), String(body.tradeId || ''), String(body.action || '') === 'sl' ? 'Stop Loss Hit' : 'Stopped by user');
        const ok = await saveState(st);
        if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
        return res.json(out, 200, CORS);
      } catch (e) { return res.json({ ok: false, error: e.message, message: e.message }, 200, CORS); }
    }
    if (path === '/api/market/secure-profit/claim-all' && method === 'POST') {
      const st = await readState();
      if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
      const svc = marketServiceFor(st);
      await hydrateLiveQuotes(st, svc, (st.db.trades || []).filter(t => t && t.status === 'Open').map(t => t.ticker));
      try {
        const out = svc.claimAllSecuredProfits(String(body.userId || ''));
        const ok = await saveState(st);
        if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
        return res.json(out, 200, CORS);
      } catch (e) { return res.json({ ok: false, error: e.message, message: e.message }, 200, CORS); }
    }
    if (path === '/api/market/secure-profit/claim' && method === 'POST') {
      const st = await readState();
      if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
      const svc = marketServiceFor(st);
      await hydrateLiveQuotes(st, svc, (st.db.trades || []).filter(t => t && t.status === 'Open').map(t => t.ticker));
      try {
        const out = svc.claimSecuredProfit(String(body.userId || ''), String(body.tradeId || ''), String(body.profitId || ''));
        const ok = await saveState(st);
        if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
        return res.json(out, 200, CORS);
      } catch (e) { return res.json({ ok: false, error: e.message, message: e.message }, 200, CORS); }
    }

    /* ------------------------------ bots ---------------------------------- */
    if (path === '/api/bots/state' && method === 'GET') {
      const userId = String((req.query || {}).userId || '');
      return botsRoute(req, res, 'read', (svc) => svc.publicState(userId));
    }
    if (path === '/api/bots/admin' && method === 'GET') {
      const st0 = await readState();
      if (!isAdminRequest(req, body, st0, req.query || {})) return res.json({ ok: false, error: 'admin_only' }, 403, CORS);
      return botsRoute(req, res, 'read', (svc) => svc.adminState());
    }
    if (path === '/api/bots/history' && method === 'GET') {
      const userId = String((req.query || {}).userId || '');
      return botsRoute(req, res, 'read', (svc) => svc.history(userId));
    }
    if (path === '/api/bots/subscribe' && method === 'POST') {
      return botsRoute(req, res, 'write', (svc) => svc.subscribe(body));
    }
    if (path === '/api/bots/start' && method === 'POST') {
      return botsRoute(req, res, 'write', (svc) => svc.start(body));
    }
    if (path === '/api/bots/resume' && method === 'POST') {
      return botsRoute(req, res, 'write', (svc) => svc.resume(body));
    }
    if (path === '/api/bots/stop' && method === 'POST') {
      return botsRoute(req, res, 'write', (svc) => svc.stop(body));
    }
    if (path === '/api/bots/topup' && method === 'POST') {
      return botsRoute(req, res, 'write', (svc) => svc.topup(body));
    }
    if (path === '/api/bots/transfer' && method === 'POST') {
      return botsRoute(req, res, 'write', (svc) => svc.transfer(body));
    }
    if (path === '/api/bots/auto-secure/subscribe' && method === 'POST') {
      return botsRoute(req, res, 'write', (svc) => svc.subscribeAutoSecure(body));
    }
    if (path === '/api/bots/auto-secure/toggle' && method === 'POST') {
      return botsRoute(req, res, 'write', (svc) => svc.toggleAutoSecure(body));
    }
    if (path === '/api/bots/admin/save' && method === 'POST') {
      const st0 = await readState();
      if (!isAdminRequest(req, body, st0, req.query || {})) return res.json({ ok: false, error: 'admin_only' }, 403, CORS);
      return botsRoute(req, res, 'write', (svc) => svc.saveAdminConfig(body));
    }

    /* --------------------------- WC investing ----------------------------- */
    if (path === '/api/wc/state' && method === 'GET') {
      return sharesRoute(req, res, 'write', (svc, st) => {
        wcSweep(st.db, 0);
        return wcStatePayload(st.db, String((req.query || {}).userId || ''));
      });
    }
    if (path === '/api/wc/plans' && method === 'GET') {
      const st = await readState();
      return res.json({ ok: true, plans: wcPlanCatalog(st.db) }, 200, CORS);
    }

    /* ------------------------- WhaleChat shares --------------------------- */
    if (path === '/api/shares/state' && method === 'GET') {
      const query = req.query || {};
      const userId = String(query.userId || '');
      return sharesRoute(req, res, 'read', (svc) => svc.publicState(userId));
    }

    if (path === '/api/shares/invest' && method === 'POST') {
      return sharesRoute(req, res, 'write', (svc) => svc.invest(body));
    }

    if (path === '/api/shares/admin' && method === 'GET') {
      const st = await readState();
      const admin = isAdminRequest(req, body, st, req.query || {});
      if (!admin) return res.json({ ok: false, error: 'admin_only' }, 403, CORS);
      return sharesRoute(req, res, 'read', (svc) => svc.adminState());
    }

    if (path === '/api/shares/admin/plans' && method === 'POST') {
      const st0 = await readState();
      if (!isAdminRequest(req, body, st0, req.query || {})) return res.json({ ok: false, error: 'admin_only' }, 403, CORS);
      return sharesRoute(req, res, 'write', (svc) => svc.savePlans(body));
    }

    if (path === '/api/shares/admin/settings' && method === 'POST') {
      const st0 = await readState();
      if (!isAdminRequest(req, body, st0, req.query || {})) return res.json({ ok: false, error: 'admin_only' }, 403, CORS);
      return sharesRoute(req, res, 'write', (svc) => {
        const r = svc.saveSettings(body);
        return { ok: true, settings: r.after, before: r.before, state: r.state };
      });
    }

    if (path === '/api/shares/admin/settings' && method === 'GET') {
      const st0 = await readState();
      if (!isAdminRequest(req, body, st0, req.query || {})) return res.json({ ok: false, error: 'admin_only' }, 403, CORS);
      return sharesRoute(req, res, 'read', (svc) => ({ ok: true, settings: svc.settingsView() }));
    }

    if (path === '/api/shares/admin/investments' && method === 'GET') {
      const st0 = await readState();
      const query = req.query || {};
      if (!isAdminRequest(req, body, st0, query)) return res.json({ ok: false, error: 'admin_only' }, 403, CORS);
      return sharesRoute(req, res, 'read', (svc) => svc.adminInvestments({ status: query.status, q: query.q }));
    }

    if (path === '/api/shares/admin/investment' && method === 'POST') {
      const st0 = await readState();
      if (!isAdminRequest(req, body, st0, req.query || {})) return res.json({ ok: false, error: 'admin_only' }, 403, CORS);
      return sharesRoute(req, res, 'write', (svc) => Object.assign({ ok: true }, svc.adminUpdateInvestment(body)));
    }

    /* --------------------------- market data ------------------------------ */
    if (path === '/api/market/keys') {
      return res.json({ ok: true, proxy: true, finnhub: !!FINNHUB_KEY, twelvedata: !!TWELVE_KEY, binance: true }, 200, CORS);
    }

    /* 3.66.1: the admin key screen calls these. In the Function edition the
       provider secrets live in the function environment, so we report status
       and refuse writes with an explicit reason instead of 404-ing. */
    if (path === '/api/connections' && method === 'GET') {
      const mask = (k) => (k ? (String(k).slice(0, 4) + '••••' + String(k).slice(-4)) : '');
      return res.json({
        ok: true,
        managed: 'function-env',
        providers: {
          finnhub: { configured: !!FINNHUB_KEY, apiKey: mask(FINNHUB_KEY), label: 'Finnhub' },
          twelvedata: { configured: !!TWELVE_KEY, apiKey: mask(TWELVE_KEY), label: 'Twelve Data' },
          binance: { configured: true, label: 'Binance' },
          brevo: { configured: !!process.env.BREVO_API_KEY, label: 'Brevo' }
        }
      }, 200, CORS);
    }

    if (path === '/api/connections' && method === 'POST') {
      return res.json({
        ok: false,
        managed: 'function-env',
        error: 'env_managed',
        message: 'Provider keys are stored in the WhaleChat function environment, not the app database. Set FINNHUB_API_KEY / TWELVE_DATA_API_KEY / BREVO_API_KEY on the function.'
      }, 200, CORS);
    }

    if (path === '/api/connections/test' && method === 'POST') {
      const which = String((body && body.which) || (req.query && req.query.which) || 'all').toLowerCase();
      const out = { ok: true, results: {} };
      try {
        if (which === 'all' || which === 'finnhub' || which === 'twelvedata') {
          const probe = await proxyQuotes('auto', ['AAPL', 'TSLA']);
          out.results.finnhub = {
            configured: !!FINNHUB_KEY,
            ok: !!(probe.quotes && (probe.quotes.AAPL || probe.quotes.TSLA)),
            price: (probe.quotes && (probe.quotes.AAPL || {}).price) || null
          };
          out.results.twelvedata = { configured: !!TWELVE_KEY, ok: !!TWELVE_KEY && probe.provider === 'twelvedata' };
        }
        if (which === 'all' || which === 'binance') {
          const b = await binanceQuotes(['BTCUSDT', 'ETHUSDT']);
          out.results.binance = { configured: true, ok: !!(b && b.BTCUSDT), price: (b && b.BTCUSDT && b.BTCUSDT.price) || null };
        }
        if (which === 'all' || which === 'brevo') {
          out.results.brevo = { configured: !!process.env.BREVO_API_KEY, ok: !!process.env.BREVO_API_KEY };
        }
      } catch (e) { out.ok = false; out.error = e.message; }
      return res.json(out, 200, CORS);
    }

    /* no server-side SSE in the Function edition: answer cleanly so the client
       stops retrying instead of logging a 404 forever */
    if (path === '/api/market/stream') {
      return res.json({ ok: true, stream: false, mode: 'poll', reason: 'appwrite_function_has_no_sse' }, 200, CORS);
    }

    if (path === '/api/market/proxy' && method === 'GET') {
      const query = req.query || {};
      const provider = String(query.provider || 'auto').toLowerCase();
      /* Appwrite hands query values over still URL-encoded: decode before
         splitting or a 50-symbol batch arrives as one long symbol name. */
      let rawSymbols = String(query.symbols || '');
      try { rawSymbols = decodeURIComponent(rawSymbols); } catch (e) {}
      rawSymbols = rawSymbols.replace(/\+/g, ' ');
      const symbols = rawSymbols.split(',').map((x) => x.trim()).filter(Boolean);
      if (!symbols.length) return res.json({ ok: false, error: 'symbols_required' }, 400, CORS);
      try {
        const out = await proxyQuotes(provider, symbols);
        return res.json(out, 200, CORS);
      } catch (e) {
        return res.json({ ok: false, error: 'proxy_failed', message: e.message }, 502, CORS);
      }
    }

    if (path === '/api/market/status') {
      const st = await readState();
      const stocks = (st.db && st.db.stocks) || [];
      const counts = { binance: 0, finnhub: 0, twelvedata: 0 };
      stocks.forEach((row) => {
        const p = row.provider || (row.assetClass === 'crypto' ? 'binance' : 'finnhub');
        if (counts[p] !== undefined) counts[p]++;
      });
      return res.json({
        ok: true,
        hasKey: !!(FINNHUB_KEY || TWELVE_KEY),
        feeds: { binance: true, finnhub: !!FINNHUB_KEY, twelvedata: !!TWELVE_KEY },
        counts, listed: stocks.length, realTickers: 0,
        source: 'appwrite', marketOpen: true, alwaysOpen: true
      }, 200, CORS);
    }

    /* -------- live provider quotes / candles / history (charts) --------- */
    if (path === '/api/market/quotes' && (method === 'GET' || method === 'POST')) {
      const st = await readState();
      const svc = marketServiceFor(st);
      const q = Object.assign({}, req.query || {}, body || {});
      let raw = String(q.tickers || q.symbols || '');
      try { raw = decodeURIComponent(raw); } catch (e) {}
      let list = raw.split(',').map((x) => x.trim()).filter(Boolean);
      if (!list.length) list = (st.db.stocks || []).filter((x) => x && x.ticker).map((x) => x.ticker).slice(0, 60);
      await hydrateLiveQuotes(st, svc, list.slice(0, 60));
      return res.json(svc.snapshot(), 200, CORS);
    }

    if (path === '/api/market/quote') {
      const st = await readState();
      const q = Object.assign({}, req.query || {}, body || {});
      const sym = String(q.symbol || q.ticker || '').trim();
      if (!sym) return res.json({ ok: false, error: 'symbol_required' }, 400, CORS);
      try {
        const quote = await marketDataFor().quote(providerSymbolFor(st, sym));
        return res.json({ ok: true, quote }, 200, CORS);
      } catch (e) {
        const svc = marketServiceFor(st);
        await hydrateLiveQuotes(st, svc, [sym]);
        const live = svc.quotes[String(sym).toUpperCase()];
        return res.json({ ok: !!live, quote: live || null, error: live ? undefined : e.message }, 200, CORS);
      }
    }

    if (path === '/api/market/candles') {
      const st = await readState();
      const q = Object.assign({}, req.query || {}, body || {});
      const sym = providerSymbolFor(st, String(q.symbol || q.ticker || ''));
      const tf = String(q.tf || q.interval || '1H');
      if (!sym) return res.json({ ok: false, error: 'symbol_required', candles: [] }, 400, CORS);
      try {
        const out = await marketDataFor().candles(sym, tf);
        return res.json(Object.assign({ ok: true }, out), 200, CORS);
      } catch (e) {
        return res.json({ ok: false, error: e.message, candles: [] }, 200, CORS);
      }
    }

    if (path === '/api/market/history') {
      const st = await readState();
      const q = Object.assign({}, req.query || {}, body || {});
      let raw = String(q.tickers || q.ticker || '');
      try { raw = decodeURIComponent(raw); } catch (e) {}
      const tickers = raw.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 24);
      const limit = Math.max(20, Math.min(2000, Number(q.limit) || 600));
      const history = {};
      /* real OHLC from the providers, transformed into the tick ring the app
         charts consume — never a made-up series */
      await Promise.all(tickers.map(async (t) => {
        const up = String(t).toUpperCase();
        history[up] = [];
        try {
          const c = await marketDataFor().candles(providerSymbolFor(st, t), '1m');
          const bars = (c && c.candles) || [];
          history[up] = bars.map((b) => ({ t: Number(b.time) * 1000, p: Number(b.close), real: true, source: c.source || 'provider' })).filter((x) => x.p > 0).slice(-limit);
        } catch (e) {}
        if (!history[up].length) {
          const row = (st.db.stocks || []).find((x) => x && String(x.ticker).toUpperCase() === up);
          const log = row && Array.isArray(row.priceLog) ? row.priceLog : [];
          if (log.length) history[up] = log.slice(-limit);
          const svc = marketServiceFor(st);
          if (!history[up].length && svc.history[up]) history[up] = svc.history[up].slice(-limit);
        }
      }));
      return res.json({ ok: true, at: Date.now(), source: 'provider', history }, 200, CORS);
    }

    if (path === '/api/market/symbols') {
      return res.json({ ok: true, symbols: marketDataFor().symbols(String((req.query || {}).type || 'crypto')) }, 200, CORS);
    }
    if (path === '/api/market/symbol-search') {
      const q = String((req.query || {}).q || '');
      try { return res.json({ ok: true, results: await marketDataFor().search(q) }, 200, CORS); }
      catch (e) { return res.json({ ok: true, results: [] }, 200, CORS); }
    }

    /* -------- spot stocks: manual buy / sell / take-profit / stop -------- */
    if (path === '/api/market/spot/buy' && method === 'POST') {
      const st = await readState();
      if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
      const svc = marketServiceFor(st);
      const ticker = String(body.ticker || '');
      await hydrateLiveQuotes(st, svc, [ticker]);
      try {
        const out = spotServiceFor(st, svc).buy(body);
        const ok = await saveState(st);
        if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
        return res.json(Object.assign({ ok: true }, out), 200, CORS);
      } catch (e) { return res.json({ ok: false, error: e.message, message: e.message }, 200, CORS); }
    }
    if (path === '/api/market/spot/sell' && method === 'POST') {
      const st = await readState();
      if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
      const svc = marketServiceFor(st);
      await hydrateLiveQuotes(st, svc, [String(body.ticker || '')]);
      try {
        const out = spotServiceFor(st, svc).sell(Object.assign({ reason: 'Manual sell' }, body));
        const ok = await saveState(st);
        if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
        return res.json(Object.assign({ ok: true }, out), 200, CORS);
      } catch (e) { return res.json({ ok: false, error: e.message, message: e.message }, 200, CORS); }
    }
    if (path === '/api/market/spot/tpsl' && method === 'POST') {
      const st = await readState();
      if (!st.db) return res.json({ ok: false, error: 'not_initialised' }, 409, CORS);
      const svc = marketServiceFor(st);
      await hydrateLiveQuotes(st, svc, [String(body.ticker || '')]);
      try {
        const out = spotServiceFor(st, svc).setTargets(body);
        const ok = await saveState(st);
        if (!ok) return res.json({ ok: false, error: 'storage_write_failed' }, 502, CORS);
        return res.json(Object.assign({ ok: true }, out), 200, CORS);
      } catch (e) { return res.json({ ok: false, error: e.message, message: e.message }, 200, CORS); }
    }
    if (path === '/api/market/spot/positions') {
      const st = await readState();
      const svc = marketServiceFor(st);
      const spot = spotServiceFor(st, svc);
      const userId = String((req.query || {}).userId || '');
      const tickers = (st.db.holdings || []).filter((h) => h && (!userId || h.userId === userId)).map((h) => h.ticker);
      await hydrateLiveQuotes(st, svc, tickers);
      /* TP / SL targets are checked against the fresh provider quotes */
      try { if (spot.settle()) await saveState(st); } catch (e) {}
      return res.json({ ok: true, positions: spot.positions(st.db, userId), status: spot.status() }, 200, CORS);
    }

    if (path === '/api/market/trading-status') {
      return res.json({ ok: true, open: true, alwaysOpen: true }, 200, CORS);
    }

    if (path === '/api/health' || path === '/') {
      const st = await readState();
      let mailOk = false;
      try { const mc = await readMailConfig(); mailOk = !!(mc.brevoKey || mc.resendKey); } catch (e) {}
      return res.json({ ok: true, app: 'whalechat', version: VERSION, provider: 'appwrite-function', stream: false, rev: st.rev || 0, users: (st.db && st.db.users) ? st.db.users.length : 0, storage: 'appwrite', email: mailOk }, 200, CORS);
    }

    /* ---------------------------------------------------------------- *
     * 3.64 config + Telesign + offline trade reconciliation            *
     * ---------------------------------------------------------------- */
    if (path === '/api/config/servers' && method === 'GET') {
      return res.json({
        ok: true,
        release: VERSION,
        appwrite: {
          endpoint: ENDPOINT,
          projectId: PROJECT,
          databaseId: WC_DB_ID,
          bucketId: BUCKET,
          collections: { orders: 'orders', offlineOrders: process.env.WC_OFFLINE_COLLECTION || 'offline_orders', portfolios: 'portfolios' }
        },
        market: { binanceWs: process.env.BINANCE_WS || 'wss://data-stream.binance.vision/stream' },
        reconciliation: { tolerancePct: offlineSync.TOLERANCE },
        features: {
          telesign: !!(TELESIGN_ID && TELESIGN_KEY),
          brevo: !!(process.env.BREVO_API_KEY),
          appwriteEmail: true
        }
      }, 200, CORS);
    }

    if (path === '/api/telesign/status' && method === 'GET') {
      return res.json({ ok: true, configured: !!(TELESIGN_ID && TELESIGN_KEY) }, 200, CORS);
    }

    if ((path === '/api/telesign/start' || path === '/api/telesign/verify') && method === 'POST') {
      const cid = TELESIGN_ID;
      const key = TELESIGN_KEY;
      if (!cid || !key) return res.json({ ok: false, error: 'telesign_not_configured' }, 501, CORS);
      const phone = '+' + String(body.phone || '').replace(/[^\d]/g, '');
      if (!/^\+\d{8,15}$/.test(phone)) return res.json({ ok: false, error: 'invalid_phone_number' }, 400, CORS);
      const auth = 'Basic ' + Buffer.from(cid + ':' + key).toString('base64');
      const base = (process.env.TELESIGN_BASE_API || 'https://rest-ww.telesign.com/v1').replace(/\/+$/, '');
      const codes = await readJsonFile('wc-telesign-codes', { codes: {} });
      codes.codes = codes.codes || {};
      const now = Date.now();

      if (path === '/api/telesign/start') {
        const last = Number((codes.codes[phone] || {}).sentAt) || 0;
        if (now - last < 60000) return res.json({ ok: false, error: 'code_already_sent', retryAfterMs: 60000 - (now - last) }, 429, CORS);
        const code = String(crypto.randomInt(100000, 1000000));
        const template = String(body.template || 'Your WhaleChat code is $$CODE$$. It expires in 5 minutes.').replace(/\$\$CODE\$\$/g, code);
        const r = await apiRaw(base + '/verify/sms', {
          method: 'POST',
          headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ phone_number: phone, template }).toString()
        });
        if (!r.ok) {
          const first = r.json && r.json.errors && r.json.errors[0];
          const why = (first && first.description) || (r.json && r.json.status && r.json.status.description) || ('HTTP ' + r.status);
          return res.json({
            ok: false,
            error: 'telesign_send_failed',
            message: why,
            code: first ? first.code : undefined,
            trial: /trial account/i.test(why)
          }, 502, CORS);
        }
        codes.codes[phone] = { hash: await sha256('wc::' + phone + '::' + code), referenceId: String((r.json && r.json.reference_id) || ''), sentAt: now, exp: now + 5 * 60000, tries: 0 };
        for (const k of Object.keys(codes.codes)) if (Number(codes.codes[k].exp) < now) delete codes.codes[k];
        await writeJsonFile('wc-telesign-codes', 'wc-telesign-codes.json', codes);
        return res.json({ ok: true, referenceId: codes.codes[phone].referenceId, expiresInMs: 300000, status: 'PENDING' }, 200, CORS);
      }

      const rec = codes.codes[phone];
      if (!rec) return res.json({ ok: false, error: 'no_pending_code' }, 404, CORS);
      if (Number(rec.exp) < now) { delete codes.codes[phone]; await writeJsonFile('wc-telesign-codes', 'wc-telesign-codes.json', codes); return res.json({ ok: false, error: 'code_expired' }, 410, CORS); }
      const given = await sha256('wc::' + phone + '::' + String(body.code || '').trim());
      if (given === rec.hash) {
        delete codes.codes[phone];
        await writeJsonFile('wc-telesign-codes', 'wc-telesign-codes.json', codes);
        return res.json({ ok: true, verified: true, status: 'VALID' }, 200, CORS);
      }
      rec.tries = (Number(rec.tries) || 0) + 1;
      if (rec.tries >= 5) { delete codes.codes[phone]; await writeJsonFile('wc-telesign-codes', 'wc-telesign-codes.json', codes); return res.json({ ok: true, verified: false, status: 'TOO_MANY_ATTEMPTS' }, 200, CORS); }
      await writeJsonFile('wc-telesign-codes', 'wc-telesign-codes.json', codes);
      return res.json({ ok: true, verified: false, status: 'INVALID', attemptsLeft: 5 - rec.tries }, 200, CORS);
    }

    if (path === '/api/orders/offline/push' && method === 'POST') {
      if (localBusy) return res.json({ ok: false, error: 'busy' }, 429, CORS);
      localBusy = true;
      try {
        const st = await readState();
        if (!st.db) return res.json({ ok: false, error: 'not_initialised', results: [] }, 409, CORS);
        const dbId = WC_DB_ID;
        const colId = process.env.WC_OFFLINE_COLLECTION || 'offline_orders';
        const deps = {
          collections: [colId],
          findOrder: async (col, clientOrderId) => {
            /* Appwrite 1.6+/2.x expects a JSON query object; the old string DSL
               answers 400 "Invalid query: Syntax error". */
            const q = encodeURIComponent(JSON.stringify({ method: 'equal', attribute: 'clientOrderId', values: [String(clientOrderId)] }));
            const r = await api('/databases/' + dbId + '/collections/' + col + '/documents?queries[]=' + q + '&limit=1');
            return (r.ok && r.json && (r.json.documents || [])[0]) || null;
          }
        };
        const out = await offlineSync.reconcile(st, body, deps);
        if (!out.ok) return res.json(out, 400, CORS);
        st.rev = Math.max(1, Number(st.rev) || 0) + 1;
        st.at = Date.now();
        const saved = await writeJsonFile(STATE_FILE, 'whalechat-state.json', st);
        if (!saved) return res.json({ ok: false, error: 'storage_write_failed', results: out.results }, 502, CORS);

        /* mirror every settled order into the Appwrite collection */
        for (const o of (out.settled || [])) {
          const id = String(o.clientOrderId).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 36);
          await api('/databases/' + dbId + '/collections/' + colId + '/documents', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ documentId: id, data: {
              clientOrderId: o.clientOrderId, userId: o.userId, ticker: o.assetSymbol, assetType: o.assetType,
              side: o.side, orderType: o.orderType, quantity: o.executedQuantity, notionalUsd: o.finalUsd,
              offlineSimulatedPrice: o.offlineSimulatedPrice, executedLivePrice: o.executedLivePrice,
              offlineTimestamp: o.offlineTimestamp, syncedAt: Date.now(), syncStatus: o.syncStatus
            } })
          });
        }

        /* one consolidated Brevo receipt per batch */
        if ((out.settled || []).length) {
          const u = (st.db.users || []).find((x) => x && x.id === body.userId);
          if (u && u.email) {
            try {
              const mc = await readMailConfig();
              const html = offlineSync.receiptHtml(u, out.settled, out.balanceUsd);
              const sent = await sendMail(mc, u.email, 'WhaleChat — ' + out.settled.length + ' offline trade(s) synced', html, 'Your offline trades were synced. Cash balance: $' + Number(out.balanceUsd || 0).toFixed(2));
              await appendMailLog({ at: Date.now(), to: u.email, subject: 'offline-sync', ok: !!sent.ok, provider: sent.provider, error: sent.error });
            } catch (e) {}
          }
        }

        delete out.settled;
        return res.json(out, 200, CORS);
      } finally { localBusy = false; }
    }

    if (path === '/api/appwrite/orders/health' && method === 'GET') {
      const col = process.env.WC_OFFLINE_COLLECTION || 'offline_orders';
      const key = String(process.env.WC_APPWRITE_KEY || process.env.APPWRITE_FUNCTION_API_KEY || '').trim();
      const r = await api('/databases/' + WC_DB_ID + '/collections/' + col + '/documents?limit=1');
      return res.json({
        ok: r.ok,
        configured: !!key,
        project: PROJECT || '(empty)',
        functionProject: process.env.APPWRITE_FUNCTION_PROJECT_ID || '',
        envProject: process.env.APPWRITE_PROJECT_ID || '',
        keySource: process.env.WC_APPWRITE_KEY ? 'wc_appwrite_key' : (process.env.APPWRITE_FUNCTION_API_KEY ? 'function_key' : 'none'),
        databaseId: WC_DB_ID,
        collection: col,
        status: r.status,
        error: r.ok ? '' : (r.text || '').slice(0, 200),
        documents: r.ok ? ((r.json && r.json.total) || 0) : null
      }, 200, CORS);
    }

    if (path === '/api/orders/offline/state' && method === 'GET') {
      const st = await readState();
      const rows = ((st.db && st.db.offlineOrders) || []);
      const uid = String((req.query && req.query.userId) || '').toString();
      const list = rows.filter((r) => !uid || r.userId === uid);
      const counts = list.reduce((a, r) => { a[r.syncStatus] = (a[r.syncStatus] || 0) + 1; return a; }, {});
      return res.json({ ok: true, counts, orders: list.slice(-200), tolerance: offlineSync.TOLERANCE }, 200, CORS);
    }

    if (path === '/api/state' && method === 'GET') {
      const st = await readState();
      /* shares keep moving while the app is closed: one lazy tick per minute
         accrues profit and settles matured plans into the payout balance */
      if (st.db) {
        let dirty = false;
        if (marketTickDue(st, 60000)) {
          try {
            const svc = shareServiceFor(st);
            svc.ensureDefaults(st.db);
            svc.tick();
            dirty = true;
          } catch (e) { try { error('shares tick: ' + e.message); } catch (x) {} }
        }
        /* bots trade while the phone is off — settled on the server */
        if (botTickDue(st)) {
          try {
            const b = botServiceFor(st);
            b.ensureDefaults(st.db);
            botCatchUp(b, st);
            dirty = true;
          } catch (e) { try { error('bots tick: ' + e.message); } catch (x) {} }
        }
        /* WC-Investing daily interest keeps accruing while offline */
        try { if (wcSweep(st.db, 60000)) dirty = true; } catch (e) {}
        /* Auto Buy/Sell + spot TP/SL also settle on a normal state poll, so an
           open app never waits for the next minute tick */
        if (Date.now() - lastB2bPollAt > 10000) {
          try {
            const before = b2bSig(st.db);
            const ms = marketServiceFor(st);
            await b2bTick(st, ms);
            const hts = Array.from(new Set((st.db.holdings || []).map((h) => h && h.ticker).filter(Boolean)));
            let closed = 0;
            if (hts.length) { await hydrateLiveQuotes(st, ms, hts); closed = spotServiceFor(st, ms).settle(); }
            if (closed > 0 || b2bSig(st.db) !== before) dirty = true;
          } catch (e) {}
        }
        if (dirty) await saveState(st);
      }
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

    if (path === '/api/email/welcome' && method === 'POST') {
      const st = await readState();
      const u = (st.db && st.db.users || []).find((x) => x && (x.id === body.userId || String(x.email || '').toLowerCase() === String(body.email || '').toLowerCase()));
      if (!u || !u.email) return res.json({ ok: false, error: 'user_missing' }, 404, CORS);
      const cfg = await readMailConfig();
      if (!cfg.brevoKey && !cfg.resendKey) return res.json({ ok: false, error: 'not_configured' }, 400, CORS);
      const first = String(u.fullName || u.username || 'there').split(' ')[0];
      const subject = 'Welcome to WhaleChat 🐋';
      const html = '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#04101a;color:#e9f4f9;padding:32px;border-radius:16px;max-width:560px;margin:auto">' +
        '<div style="font-size:28px;font-weight:900;color:#2ee6c9">WhaleChat</div>' +
        '<h2 style="margin:14px 0 8px">Welcome aboard, ' + first + ' 🐋</h2>' +
        '<p style="color:#8ba4b6;line-height:1.7">Your email is verified and your WhaleChat account is ready. Chat, shop, trade and invest — all in one place.</p>' +
        '<a href="https://whalechat.appwrite.network/whalechat.html#/profile" style="display:inline-block;margin-top:16px;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:800;padding:12px 20px;border-radius:10px">Open my account</a>' +
        '<p style="color:#63798a;font-size:11px;margin-top:22px">Sent by WhaleChat · whalechat1@gmail.com via Brevo</p></div>';
      const out = await sendMail(cfg, u.email, subject, html, 'Welcome to WhaleChat, ' + first + '! Your account is verified and ready.');
      await appendMailLog({ type: 'welcome', to: u.email, subject, status: out.ok ? 'sent' : 'failed', provider: out.provider, messageId: out.messageId, error: out.error, from: cfg.from, userId: u.id });
      return res.json(out.ok ? { ok: true, messageId: out.messageId } : { ok: false, error: 'send_failed', message: out.error }, out.ok ? 200 : 502, CORS);
    }

    if (path === '/api/notify/deposit-approved' && method === 'POST') {
      const st = await readState();
      const u = (st.db && st.db.users || []).find((x) => x && x.id === body.userId);
      if (!u || !u.email) return res.json({ ok: false, error: 'user_missing' }, 404, CORS);
      const cfg = await readMailConfig();
      if (!cfg.brevoKey && !cfg.resendKey) return res.json({ ok: false, error: 'not_configured' }, 400, CORS);
      const amount = Number(body.amount) || 0;
      const coin = String(body.coin || 'USD').toUpperCase();
      const subject = 'Deposit approved · ' + (coin === 'USD' ? '$' + amount.toFixed(2) : amount.toFixed(2) + ' ' + coin);
      const html = '<div style="font-family:system-ui,sans-serif;background:#04101a;color:#e9f4f9;padding:28px;border-radius:14px;max-width:540px;margin:auto">' +
        '<h2 style="color:#2ee6c9;margin:0 0 10px">Deposit approved ✅</h2>' +
        '<p style="color:#8ba4b6;line-height:1.7">Hi ' + String(u.fullName || u.username || 'there').split(' ')[0] + ', your deposit of <b style="color:#e9f4f9">' + amount.toFixed(2) + ' ' + coin + '</b> has been credited to your WhaleChat crypto balance.</p>' +
        '<p style="color:#8ba4b6">Open your account to convert it to WC or move it to your investment account.</p>' +
        '<a href="https://whalechat.appwrite.network/whalechat.html#/account" style="display:inline-block;margin-top:14px;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:800;padding:11px 18px;border-radius:10px">Open my account</a></div>';
      const out = await sendMail(cfg, u.email, subject, html, 'Your deposit of ' + amount.toFixed(2) + ' ' + coin + ' was approved and credited.');
      await appendMailLog({ type: 'deposit', to: u.email, subject, status: out.ok ? 'sent' : 'failed', provider: out.provider, messageId: out.messageId, error: out.error, from: cfg.from, userId: u.id });
      return res.json(out.ok ? { ok: true } : { ok: false, error: 'send_failed', message: out.error }, out.ok ? 200 : 502, CORS);
    }

    if (path === '/api/notify/withdrawal-approved' && method === 'POST') {
      const st = await readState();
      const u = (st.db && st.db.users || []).find((x) => x && x.id === body.userId);
      if (!u || !u.email) return res.json({ ok: false, error: 'user_missing' }, 404, CORS);
      const cfg = await readMailConfig();
      if (!cfg.brevoKey && !cfg.resendKey) return res.json({ ok: false, error: 'not_configured' }, 400, CORS);
      const amount = Number(body.amount) || 0;
      const network = String(body.network || 'USDT');
      const txRef = String(body.txRef || '');
      const subject = 'Withdrawal approved · ' + amount.toFixed(2) + ' ' + network;
      const html = '<div style="font-family:system-ui,sans-serif;background:#04101a;color:#e9f4f9;padding:28px;border-radius:14px;max-width:540px;margin:auto">' +
        '<h2 style="color:#2ee6c9;margin:0 0 10px">Withdrawal approved 💸</h2>' +
        '<p style="color:#8ba4b6;line-height:1.7">Hi ' + String(u.fullName || u.username || 'there').split(' ')[0] + ', your withdrawal of <b style="color:#e9f4f9">' + amount.toFixed(2) + ' ' + network + '</b> has been approved and sent.</p>' +
        (txRef ? '<p style="color:#8ba4b6;font-size:12px">Transaction: <b style="color:#e9f4f9">' + txRef + '</b></p>' : '') +
        '<a href="https://whalechat.appwrite.network/whalechat.html#/account" style="display:inline-block;margin-top:14px;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:800;padding:11px 18px;border-radius:10px">Open my account</a></div>';
      const out = await sendMail(cfg, u.email, subject, html, 'Your withdrawal of ' + amount.toFixed(2) + ' ' + network + ' was approved.');
      await appendMailLog({ type: 'withdrawal', to: u.email, subject, status: out.ok ? 'sent' : 'failed', provider: out.provider, messageId: out.messageId, error: out.error, from: cfg.from, userId: u.id });
      return res.json(out.ok ? { ok: true } : { ok: false, error: 'send_failed', message: out.error }, out.ok ? 200 : 502, CORS);
    }

    if (path === '/api/notify/price-alert' && method === 'POST') {
      const st = await readState();
      const u = (st.db && st.db.users || []).find((x) => x && x.id === body.userId);
      if (!u || !u.email) return res.json({ ok: false, error: 'user_missing' }, 404, CORS);
      const cfg = await readMailConfig();
      if (!cfg.brevoKey && !cfg.resendKey) return res.json({ ok: false, error: 'not_configured' }, 400, CORS);
      const ticker = String(body.ticker || '').toUpperCase().slice(0, 20);
      const price = Number(body.price) || 0;
      const target = Number(body.target) || 0;
      const side = String(body.side || 'price');
      const subject = ticker + ' price alert · ' + (side === 'sell' ? 'sell target reached' : side === 'buy' ? 'buy target reached' : 'target reached');
      const html = '<div style="font-family:system-ui,sans-serif;background:#04101a;color:#e9f4f9;padding:28px;border-radius:14px;max-width:540px;margin:auto">' +
        '<h2 style="color:#2ee6c9;margin:0 0 10px">' + ticker + ' price alert</h2>' +
        '<p style="color:#8ba4b6;line-height:1.7">Hi ' + String(u.fullName || u.username || 'there').split(' ')[0] + ', <b style="color:#e9f4f9">' + ticker + '</b> is now <b style="color:#e9f4f9">$' + price.toFixed(2) + '</b> and your ' + side + ' target of <b style="color:#e9f4f9">$' + target.toFixed(2) + '</b> was reached.</p>' +
        '<a href="https://whalechat.appwrite.network/whalechat.html#/investment/b2b" style="display:inline-block;margin-top:14px;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:800;padding:11px 18px;border-radius:10px">Open the trading desk</a></div>';
      const out = await sendMail(cfg, u.email, subject, html, ticker + ' is now $' + price.toFixed(2) + ' — your ' + side + ' target of $' + target.toFixed(2) + ' was reached.');
      await appendMailLog({ type: 'price_alert', to: u.email, subject, status: out.ok ? 'sent' : 'failed', provider: out.provider, messageId: out.messageId, error: out.error, from: cfg.from, userId: u.id });
      return res.json(out.ok ? { ok: true } : { ok: false, error: 'send_failed', message: out.error }, out.ok ? 200 : 502, CORS);
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
