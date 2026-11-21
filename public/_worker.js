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
  if (!token) return null;
  try {
    const r = await fetch(syncOrigin(env) + '/api/admin/me', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token })
    });
    const j = await r.json().catch(() => null);
    return r.ok && j && j.ok ? j.admin : null;
  } catch (e) { return null; }
}
async function stateDb(env) {
  const r = await fetch(syncOrigin(env) + '/api/state?t=' + Date.now(), { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  return j && j.db ? j.db : null;
}
function cleanText(v, max) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 700); }

/* ---------------------------------------------------------------- main -- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });

    try {
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
