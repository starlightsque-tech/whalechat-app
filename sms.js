'use strict';
/* =========================================================================
   WhaleChat · unified SMS + OTP service  (3.77)
   -------------------------------------------------------------------------
   One module for every text message the app sends:

     · Brevo transactional SMS  — POST /v3/transactionalSMS/sms, authenticated
       with the Brevo API key. This is the default when Telesign is not set,
       so the same Brevo account that sends mail also sends SMS and OTP.
     · Telesign Verify          — used when TELESIGN_CUSTOMER_ID /
       TELESIGN_API_KEY are configured (kept as a first-class fallback).

   OTP codes sent through Brevo are generated and verified locally, hashed
   with SHA-256, capped at 5 attempts, single-use and expire after 5 minutes.
   The public surface is identical to telesign.js so server.js keeps working.
   ========================================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const base = require('./server-config');

let telesign = null;
try { telesign = require('./telesign'); } catch (e) { telesign = null; }

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'brevo-sms-codes.json');
const MAX_ATTEMPTS = 5;
const RESEND_WINDOW_MS = 60 * 1000;
const TTL_MS = Number(process.env.BREVO_SMS_CODE_TTL_MS || 5 * 60 * 1000);

const memory = new Map();
const rate = new Map();
let loaded = false;

function apiKey() {
  return String(process.env.BREVO_SMS_API_KEY || process.env.BREVO_API_KEY || base.DEFAULTS.brevo.apiKey || '').trim();
}
function sender() {
  return String(process.env.BREVO_SMS_SENDER || process.env.BREVO_SENDER_NAME || base.DEFAULTS.brevo.senderName || 'WhaleChat').trim();
}
/* Brevo is the requested provider. Telesign is only used when no Brevo API
   key exists, so the same account that sends mail also sends SMS/OTP. */
function telesignOn() {
  return !apiKey() && !!(telesign && telesign.configured && telesign.configured());
}
function configured() {
  return !!apiKey() || !!(telesign && telesign.configured && telesign.configured());
}
function provider() {
  if (apiKey()) return 'brevo';
  if (telesign && telesign.configured && telesign.configured()) return 'telesign';
  return 'none';
}

function normalizePhone(input) {
  let raw = String(input || '').replace(/[^\d+]/g, '');
  if (!raw) return '';
  if (raw.startsWith('+')) raw = raw.slice(1);
  if (!/^\d{8,15}$/.test(raw)) return '';
  return '+' + raw;
}
function mask(phone) {
  return String(phone).replace(/^(\+\d{2})\d+(\d{2})$/, '$1******$2');
}
function sha(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function makeCode() { return String(crypto.randomInt(100000, 1000000)); }

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const now = Date.now();
    for (const [phone, rec] of Object.entries(raw || {})) {
      if (rec && rec.expiresAt > now) memory.set(phone, rec);
    }
  } catch (e) { /* first run */ }
}
function save() {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    const out = {};
    for (const [phone, rec] of memory.entries()) out[phone] = rec;
    fs.writeFileSync(STORE_FILE, JSON.stringify(out), { mode: 0o600 });
  } catch (e) { /* a failed write must not break verification */ }
}

/* ---------------------------------------------------------------- compose */
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
  if (telesign && telesign.composeMessage) return telesign.composeMessage(input);
  const body = String((input && input.message) || '').replace(/\r\n/g, '\n').trim().slice(0, 700);
  const url = cleanUrl(input && input.buttonUrl);
  const label = cleanLabel(input && input.buttonLabel) || (url ? 'Open WhaleChat' : '');
  if (!url) return { text: body, hasButton: false, url: '', label: '' };
  return { text: (body + '\n\n' + label + ': ' + url).slice(0, 1400), hasButton: true, url, label };
}

/* ------------------------------------------------------------------ Brevo */
async function brevoSend(phone, content) {
  const key = apiKey();
  if (!key) throw Object.assign(new Error('brevo_sms_not_configured'), { status: 501 });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: {
        'api-key': key,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: sender().slice(0, 11),
        recipient: phone.replace(/^\+/, ''),
        content: String(content || '').slice(0, 1400),
        type: 'transactional',
        tag: 'whalechat'
      }),
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      const why = (json && (json.message || json.error)) || ('Brevo SMS HTTP ' + res.status);
      const err = new Error(why);
      err.status = res.status;
      err.detail = json;
      throw err;
    }
    return {
      ok: true,
      provider: 'brevo',
      referenceId: String((json && (json.reference || json.messageId)) || ''),
      status: 'QUEUED',
      remainingCredits: json && json.remainingCredits
    };
  } finally { clearTimeout(timer); }
}

/* --------------------------------------------------------- verification */
async function startVerification(input) {
  if (telesignOn()) return telesign.startVerification(input);
  load();
  if (!apiKey()) throw Object.assign(new Error('sms_not_configured'), { status: 501 });
  const phone = normalizePhone(input && input.phone);
  if (!phone) throw Object.assign(new Error('invalid_phone_number'), { status: 400 });

  const now = Date.now();
  const last = rate.get(phone) || 0;
  if (now - last < RESEND_WINDOW_MS) {
    throw Object.assign(new Error('code_already_sent'), { status: 429, retryAfterMs: RESEND_WINDOW_MS - (now - last) });
  }
  const code = makeCode();
  const template = String((input && input.template) || process.env.BREVO_SMS_VERIFY_TEMPLATE ||
    'Your WhaleChat code is ' + code + '. It expires in 5 minutes.').replace(/\$\$CODE\$\$/g, code).replace(/\{code\}/gi, code);
  const out = await brevoSend(phone, template);
  rate.set(phone, now);
  memory.set(phone, {
    phone,
    purpose: String((input && input.purpose) || 'login').slice(0, 40),
    codeHash: sha(code),
    referenceId: String(out.referenceId || ''),
    createdAt: now,
    expiresAt: now + TTL_MS,
    attempts: 0,
    status: 'PENDING',
    provider: 'brevo'
  });
  save();
  return {
    ok: true,
    phone: mask(phone),
    referenceId: String(out.referenceId || ''),
    expiresInMs: TTL_MS,
    status: 'PENDING',
    provider: 'brevo'
  };
}

async function checkVerification(input) {
  if (telesignOn()) return telesign.checkVerification(input);
  load();
  const phone = normalizePhone(input && input.phone);
  if (!phone) throw Object.assign(new Error('invalid_phone_number'), { status: 400 });
  const rec = memory.get(phone);
  if (!rec) throw Object.assign(new Error('no_pending_code'), { status: 404 });
  if (rec.expiresAt < Date.now()) {
    memory.delete(phone); save();
    throw Object.assign(new Error('code_expired'), { status: 410 });
  }
  const code = String((input && input.code) || '').trim();
  if (!code) throw Object.assign(new Error('code_required'), { status: 400 });

  if (crypto.timingSafeEqual(Buffer.from(rec.codeHash), Buffer.from(sha(code)))) {
    memory.delete(phone); save();
    return { ok: true, verified: true, status: 'VALID', source: 'brevo' };
  }
  rec.attempts += 1;
  if (rec.attempts >= MAX_ATTEMPTS) {
    memory.delete(phone); save();
    return { ok: true, verified: false, status: 'TOO_MANY_ATTEMPTS' };
  }
  save();
  return { ok: true, verified: false, status: 'INVALID', attemptsLeft: MAX_ATTEMPTS - rec.attempts };
}

/* ------------------------------------------------------------ plain SMS */
async function sendSms(input) {
  if (telesignOn()) return telesign.sendSms(input);
  if (!apiKey()) throw Object.assign(new Error('sms_not_configured'), { status: 501 });
  const phone = normalizePhone(input && input.phone);
  if (!phone) throw Object.assign(new Error('invalid_phone_number'), { status: 400 });
  const composed = composeMessage(input);
  if (!composed.text) throw Object.assign(new Error('message_required'), { status: 400 });
  const out = await brevoSend(phone, composed.text);
  return { ok: true, phone: mask(phone), referenceId: out.referenceId, status: out.status, hasButton: composed.hasButton, provider: 'brevo' };
}

async function sendBulk(input) {
  if (telesignOn()) return telesign.sendBulk(input);
  if (!apiKey()) throw Object.assign(new Error('sms_not_configured'), { status: 501 });
  const composed = composeMessage(input);
  if (!composed.text) throw Object.assign(new Error('message_required'), { status: 400 });
  const phones = [];
  const seen = {};
  (Array.isArray(input.phones) ? input.phones : []).forEach((p) => {
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
      const out = await brevoSend(phone, composed.text);
      sent += 1;
      results.push({ phone: mask(phone), ok: true, status: out.status, referenceId: out.referenceId });
    } catch (e) {
      results.push({ phone: mask(phone), ok: false, error: String(e.message || 'send_failed') });
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return {
    ok: true,
    provider: 'brevo',
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
  if (telesign && telesign.status) {
    const st = telesign.status();
    if (st.configured) return Object.assign(st, { provider: 'telesign' });
  }
  return {
    configured: !!apiKey(),
    provider: apiKey() ? 'brevo' : 'none',
    sender: sender(),
    pending: memory.size,
    hasCredentials: { apiKey: !!apiKey() }
  };
}

module.exports = {
  startVerification, checkVerification, sendSms, sendBulk,
  composeMessage, cleanUrl, cleanLabel, status, normalizePhone,
  configured, provider
};
