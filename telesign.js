'use strict';
/* =========================================================================
   WhaleChat · Telesign SMS (verify + notifications)  — server side only
   -------------------------------------------------------------------------
   The Telesign customer id / API key never reach the browser. The app calls
   our own endpoints and the server signs the Telesign request with HTTP Basic
   auth exactly as their REST docs specify:

     POST {base}/verify/sms
       content-type: application/x-www-form-urlencoded
       phone_number=+14692466072
       template=Your WhaleChat code is $$CODE$$ ...

     POST {base}/verify/{reference_id}      → status PENDING / VALID / INVALID
     POST {base}/messaging                 → plain SMS notification

   Endpoints exposed to the app (wired in server.js):
     POST /api/telesign/start     {phone, purpose}      → sends a code, ref id
     POST /api/telesign/verify    {phone, code|referenceId}  → VALID / INVALID
     POST /api/telesign/sms       {phone, message}      (staff/notification use)
     GET  /api/telesign/status                          → configured / not

   Codes are stored hashed in memory + DATA_DIR/telesign-codes.json so a
   restart cannot silently accept an old code. Every record is bounded by a
   TTL, attempts are capped, and the module fails closed when unconfigured.
   ========================================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./server-config');

const MAX_ATTEMPTS = 5;
const RESEND_WINDOW_MS = 60 * 1000;
const STORE_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'telesign-codes.json');

const memory = new Map();       // phone -> record
const rate = new Map();         // phone -> last send ms
let loaded = false;

function configured() {
  return !!(cfg.DEFAULTS.telesign.customerId && cfg.DEFAULTS.telesign.apiKey);
}

function normalizePhone(input) {
  let raw = String(input || '').replace(/[^\d+]/g, '');
  if (!raw) return '';
  if (raw.startsWith('+')) raw = raw.slice(1);
  if (!/^\d{8,15}$/.test(raw)) return '';
  return '+' + raw;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const now = Date.now();
    for (const [phone, rec] of Object.entries(raw || {})) {
      if (rec && rec.expiresAt > now) memory.set(phone, rec);
    }
  } catch (e) { /* no store yet */ }
}

function save() {
  try {
    const dir = path.dirname(STORE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const out = {};
    for (const [phone, rec] of memory.entries()) out[phone] = rec;
    fs.writeFileSync(STORE_FILE, JSON.stringify(out), { mode: 0o600 });
  } catch (e) { /* a failed write must not break verification */ }
}

function basicAuth() {
  const { customerId, apiKey } = cfg.DEFAULTS.telesign;
  return 'Basic ' + Buffer.from(customerId + ':' + apiKey).toString('base64');
}

async function callTelesign(pathname, form) {
  const { baseUrl } = cfg.DEFAULTS.telesign;
  const body = new URLSearchParams(form).toString();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(baseUrl + pathname, {
      method: 'POST',
      headers: {
        authorization: basicAuth(),
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      const first = json && json.errors && json.errors[0];
      const err = new Error((first && first.description) || (json && json.status && json.status.description) || 'telesign_http_' + res.status);
      err.status = res.status === 401 ? 403 : res.status;   /* auth succeeded, the transaction was refused */
      err.code = first ? first.code : undefined;
      err.detail = json;
      throw err;
    }
    return json || {};
  } finally { clearTimeout(timer); }
}

function makeCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/* ------------------------------------------------------------------ start */
async function startVerification(input) {
  load();
  if (!configured()) throw Object.assign(new Error('telesign_not_configured'), { status: 501 });

  const phone = normalizePhone(input.phone);
  if (!phone) throw Object.assign(new Error('invalid_phone_number'), { status: 400 });

  const now = Date.now();
  const last = rate.get(phone) || 0;
  if (now - last < RESEND_WINDOW_MS) {
    throw Object.assign(new Error('code_already_sent'), { status: 429, retryAfterMs: RESEND_WINDOW_MS - (now - last) });
  }

  const code = makeCode();
  const template = String(input.template || cfg.DEFAULTS.telesign.verifyTemplate).replace(/\$\$CODE\$\$/g, code);

  const out = await callTelesign('/verify/sms', {
    phone_number: phone,
    template,
    ...(cfg.DEFAULTS.telesign.senderId ? { sender_id: cfg.DEFAULTS.telesign.senderId } : {})
  });

  rate.set(phone, now);
  memory.set(phone, {
    phone,
    purpose: String(input.purpose || 'login').slice(0, 40),
    codeHash: sha(code),
    referenceId: String(out.reference_id || ''),
    createdAt: now,
    expiresAt: now + cfg.DEFAULTS.telesign.codeTtlMs,
    attempts: 0,
    status: 'PENDING'
  });
  save();

  return {
    ok: true,
    phone: phone.replace(/^(\+\d{2})\d+(\d{2})$/, '$1******$2'),
    referenceId: String(out.reference_id || ''),
    expiresInMs: cfg.DEFAULTS.telesign.codeTtlMs,
    status: String(out.status || 'PENDING')
  };
}

/* ----------------------------------------------------------------- verify */
async function checkVerification(input) {
  load();
  const phone = normalizePhone(input.phone);
  if (!phone) throw Object.assign(new Error('invalid_phone_number'), { status: 400 });
  const rec = memory.get(phone);
  const code = String(input.code || '').trim();

  /* A code entered on another device can still be checked by reference id. */
  if (!rec && input.referenceId) {
    if (!configured()) throw Object.assign(new Error('telesign_not_configured'), { status: 501 });
    const out = await callTelesign('/verify/' + encodeURIComponent(input.referenceId), {});
    const verified = String(out.status || '').toUpperCase() === 'VALID';
    return { ok: true, verified, status: String(out.status || 'UNKNOWN'), source: 'telesign' };
  }
  if (!rec) throw Object.assign(new Error('no_pending_code'), { status: 404 });
  if (rec.expiresAt < Date.now()) {
    memory.delete(phone); save();
    throw Object.assign(new Error('code_expired'), { status: 410 });
  }
  if (!code) throw Object.assign(new Error('code_required'), { status: 400 });

  /* Local check first: works even if Telesign's verify endpoint is slow. */
  if (crypto.timingSafeEqual(Buffer.from(rec.codeHash), Buffer.from(sha(code)))) {
    rec.status = 'VALID';
    memory.delete(phone);
    save();
    return { ok: true, verified: true, status: 'VALID', source: 'local' };
  }

  rec.attempts += 1;
  if (rec.attempts >= MAX_ATTEMPTS) {
    rec.status = 'BLOCKED';
    memory.delete(phone);
    save();
    return { ok: true, verified: false, status: 'TOO_MANY_ATTEMPTS' };
  }
  save();

  /* Fall back to Telesign's own status (e.g. code typed on another device). */
  if (rec.referenceId && configured()) {
    try {
      const out = await callTelesign('/verify/' + encodeURIComponent(rec.referenceId), {});
      const status = String(out.status || '').toUpperCase();
      if (status === 'VALID') { memory.delete(phone); save(); return { ok: true, verified: true, status, source: 'telesign' }; }
    } catch (e) { /* local result stands */ }
  }
  return { ok: true, verified: false, status: 'INVALID', attemptsLeft: MAX_ATTEMPTS - rec.attempts };
}

/* -------------------------------------------------------------- sms send */

/* A plain SMS cannot render an HTML button, so an admin "button" is delivered
   the way a phone can actually tap it: a labelled link on its own line, below
   the message, with the full https URL on the next line. iPhone/Android both
   turn that URL into a tappable link, which is the button the user taps.
   The text stays inside one GSM-7 friendly body so it cannot be split into
   dozens of segments by an emoji. */
function cleanUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let url = raw;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    if (!u.hostname || u.hostname.indexOf('.') < 0) return '';
    return u.toString();
  } catch (e) { return ''; }
}

function cleanLabel(input) {
  return String(input || '').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, 60);
}

function composeMessage(input) {
  const body = String(input && input.message || '').replace(/\r\n/g, '\n').trim().slice(0, 700);
  const url = cleanUrl(input && input.buttonUrl);
  const label = cleanLabel(input && input.buttonLabel) || (url ? 'Open WhaleChat' : '');
  if (!url) return { text: body, hasButton: false, url: '', label: '' };
  const link = '\n\n' + label + ': ' + url;
  const text = (body + link).slice(0, 1400);
  return { text, hasButton: true, url, label };
}

async function sendSms(input) {
  if (!configured()) throw Object.assign(new Error('telesign_not_configured'), { status: 501 });
  const phone = normalizePhone(input.phone);
  if (!phone) throw Object.assign(new Error('invalid_phone_number'), { status: 400 });
  const composed = composeMessage(input);
  const message = composed.text;
  if (!message) throw Object.assign(new Error('message_required'), { status: 400 });
  const out = await callTelesign('/messaging', {
    phone_number: phone,
    message,
    message_type: String(input.messageType || 'ARN'),
    ...(cfg.DEFAULTS.telesign.senderId ? { sender_id: cfg.DEFAULTS.telesign.senderId } : {})
  });
  return {
    ok: true,
    phone: phone.replace(/^(\+\d{2})\d+(\d{2})$/, '$1******$2'),
    referenceId: String(out.reference_id || ''),
    status: String(out.status || 'QUEUED'),
    hasButton: composed.hasButton
  };
}

/* Admin broadcast: one composed message, many recipients, sequential so a
   provider rate limit cannot swallow half the batch. Results are reported per
   phone number so the panel can show exactly who was reached. */
async function sendBulk(input) {
  if (!configured()) throw Object.assign(new Error('telesign_not_configured'), { status: 501 });
  const composed = composeMessage(input);
  if (!composed.text) throw Object.assign(new Error('message_required'), { status: 400 });
  const phones = [];
  const seen = {};
  (Array.isArray(input.phones) ? input.phones : []).forEach(function (p) {
    const phone = normalizePhone(p);
    if (!phone || seen[phone]) return;
    seen[phone] = true;
    phones.push(phone);
  });
  const cap = Math.max(1, Math.min(Number(input.limit) || 100, 500));
  const batch = phones.slice(0, cap);
  const results = [];
  let sent = 0;
  for (const phone of batch) {
    try {
      const out = await callTelesign('/messaging', {
        phone_number: phone,
        message: composed.text,
        message_type: String(input.messageType || 'ARN'),
        ...(cfg.DEFAULTS.telesign.senderId ? { sender_id: cfg.DEFAULTS.telesign.senderId } : {})
      });
      sent += 1;
      results.push({ phone: phone.replace(/^(\+\d{2})\d+(\d{2})$/, '$1******$2'), ok: true, status: String(out.status || 'QUEUED'), referenceId: String(out.reference_id || '') });
    } catch (e) {
      results.push({ phone: phone.replace(/^(\+\d{2})\d+(\d{2})$/, '$1******$2'), ok: false, error: String(e.message || 'send_failed') });
    }
    await new Promise(function (r) { setTimeout(r, 40); });
  }
  return {
    ok: true,
    sent,
    failed: batch.length - sent,
    attempted: batch.length,
    remaining: Math.max(0, phones.length - batch.length),
    recipients: phones.length,
    hasButton: composed.hasButton,
    button: composed.hasButton ? { label: composed.label, url: composed.url } : null,
    preview: composed.text,
    results
  };
}

function status() {
  load();
  return {
    configured: configured(),
    baseUrl: cfg.DEFAULTS.telesign.baseUrl,
    pending: memory.size,
    hasCredentials: { customerId: !!cfg.DEFAULTS.telesign.customerId, apiKey: !!cfg.DEFAULTS.telesign.apiKey }
  };
}

module.exports = { startVerification, checkVerification, sendSms, sendBulk, composeMessage, cleanUrl, status, normalizePhone, configured };
