/**
 * WhaleChat Pages Function — welcome email after email verification.
 *
 * POST /api/welcome  { email, userId, username, fullName, referralCode }
 *
 * 1. Confirms the account is really verified by reading the sync server state
 *    (never trusts the browser alone).
 * 2. Sends the welcome mail through Brevo using the API key stored as a
 *    Pages secret (BREVO_API_KEY) — the key never reaches the browser.
 *
 * Environment (Cloudflare Pages → Settings → Environment variables):
 *   BREVO_API_KEY   required
 *   BREVO_FROM      verified Brevo sender, default whalechat1@gmail.com
 *   BREVO_FROM_NAME default WhaleChat
 *   SYNC_ORIGIN     default https://whalechat-live.fly.dev
 */

const DEFAULT_SYNC = 'https://whalechat-live.fly.dev';
const DEFAULT_FROM = 'whalechat1@gmail.com';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad_request' }, 400);

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ ok: false, error: 'bad_email' }, 400);
  if (!env.BREVO_API_KEY) return json({ ok: false, error: 'mail_not_configured' }, 503);

  const sync = String(env.SYNC_ORIGIN || DEFAULT_SYNC).replace(/\/+$/, '');

  /* 1. server-side check: the account must exist and be verified */
  let user = null;
  try {
    const res = await fetch(sync + '/api/state', { headers: { accept: 'application/json' } });
    if (!res.ok) return json({ ok: false, error: 'sync_unavailable' }, 502);
    const data = await res.json();
    const users = (data && data.db && Array.isArray(data.db.users)) ? data.db.users : [];
    user = users.find((u) => u && String(u.email || '').trim().toLowerCase() === email) || null;
  } catch (e) {
    return json({ ok: false, error: 'sync_unavailable' }, 502);
  }
  if (!user) return json({ ok: false, error: 'user_not_found' }, 404);
  if (body.userId && String(body.userId) !== String(user.id)) return json({ ok: false, error: 'user_mismatch' }, 403);
  if (user.emailVerified !== true && user.verified !== true) return json({ ok: false, error: 'not_verified' }, 403);

  /* 2. send the welcome mail */
  const name = String(user.fullName || user.username || 'there').split(' ')[0];
  const username = String(user.username || '');
  const code = String(user.referralCode || '');
  const appUrl = 'https://' + (request.headers.get('host') || 'whalechat.pages.dev');
  const from = String(env.BREVO_FROM || env.BREVO_SENDER_EMAIL || DEFAULT_FROM);
  const fromName = String(env.BREVO_FROM_NAME || env.BREVO_SENDER_NAME || 'WhaleChat');

  const html = `
  <div style="background:#04101a;padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#0b1723;border:1px solid #16303f;border-radius:18px;overflow:hidden">
      <div style="padding:22px 24px;background:linear-gradient(135deg,#0f766e,#0b3d5c)">
        <div style="font-size:12px;letter-spacing:.18em;color:#9fe9dd;font-weight:700">WHALECHAT</div>
        <h1 style="margin:8px 0 0;font-size:25px;color:#eaf6fb">Welcome aboard, ${esc(name)} 🐋</h1>
      </div>
      <div style="padding:24px;color:#c7d8e2;font-size:14.5px;line-height:1.7">
        <p style="margin:0 0 12px">Your email is verified and your WhaleChat account is ready. You can now chat with voice notes, shop the marketplace and manage your Whale Coin wallet.</p>
        <table style="width:100%;border-collapse:collapse;margin:14px 0">
          <tr><td style="padding:6px 0;color:#7f97a6">Username</td><td style="padding:6px 0;color:#eaf6fb;font-weight:700">@${esc(username)}</td></tr>
          <tr><td style="padding:6px 0;color:#7f97a6">Email</td><td style="padding:6px 0;color:#eaf6fb">${esc(email)}</td></tr>
          ${code ? `<tr><td style="padding:6px 0;color:#7f97a6">Referral code</td><td style="padding:6px 0;color:#eaf6fb;font-weight:700">${esc(code)}</td></tr>` : ''}
        </table>
        <a href="${esc(appUrl)}/whalechat.html#/account" style="display:inline-block;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:11px;margin-top:6px">Open my account</a>
        <p style="margin:18px 0 0;font-size:12px;color:#63808f">If this wasn't you, contact support immediately.</p>
      </div>
    </div>
  </div>`;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: fromName, email: from },
        to: [{ email, name: user.fullName || username || email }],
        subject: 'Welcome to WhaleChat — your account is verified 🐋',
        htmlContent: html
      })
    });
    if (!res.ok) {
      const txt = await res.text();
      return json({ ok: false, error: 'brevo_failed', status: res.status, message: String(txt).slice(0, 300) }, 502);
    }
    return json({ ok: true, sentTo: email.slice(0, 2) + '***' });
  } catch (e) {
    return json({ ok: false, error: 'brevo_unreachable' }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}
