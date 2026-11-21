/**
 * POST /api/brevo/smtp/email
 *
 * Brevo-compatible relay used by the WhaleChat sync server. The server's own
 * IP is blocked by Brevo, so it sends here (Cloudflare edge) with a shared
 * relay secret in the `api-key` header. The real Brevo key never leaves
 * Cloudflare.
 *
 * Body: { sender, to, subject, htmlContent, textContent }  (Brevo format)
 * Header: api-key: <MAIL_RELAY_SECRET>
 */
import { json } from '../../../_lib/mail.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const secret = String(env.MAIL_RELAY_SECRET || '');
  const given = String(request.headers.get('api-key') || request.headers.get('x-mail-relay-secret') || '');
  if (!secret) return json({ ok: false, error: 'relay_not_configured' }, 503);
  if (given !== secret) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.BREVO_API_KEY) return json({ ok: false, error: 'brevo_not_configured' }, 503);

  let payload;
  try { payload = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  if (!payload || !payload.to || !payload.subject) return json({ ok: false, error: 'invalid_message' }, 400);
  if (!payload.sender || !payload.sender.email) {
    payload.sender = {
      name: env.BREVO_SENDER_NAME || 'WhaleChat',
      email: env.BREVO_SENDER_EMAIL || env.BREVO_FROM || 'whalechat1@gmail.com'
    };
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j.message || msg; } catch (e) {}
      return json({ ok: false, error: 'brevo_failed', status: res.status, message: msg }, 502);
    }
    let out = {};
    try { out = JSON.parse(text); } catch (e) {}
    return json({ ok: true, messageId: out.messageId || null });
  } catch (e) {
    return json({ ok: false, error: 'brevo_unreachable' }, 502);
  }
}

export async function onRequestGet() {
  return json({ ok: true, service: 'whalechat-mail-relay', ready: true });
}
