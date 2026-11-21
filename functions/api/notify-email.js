/**
 * POST /api/notify-email  { userId, title, body, link, icon }
 *
 * Sends an account's email notification through Brevo (from the Cloudflare
 * edge, where the Brevo key is authorised). The recipient must exist, be
 * verified, and not have switched email notifications off. A KV throttle keeps
 * a busy chat from sending more than one mail every two minutes per account.
 */
import { json, esc, sendBrevo } from '../_lib/mail.js';

const SYNC_DEFAULT = 'https://whalechat-live.fly.dev';
const THROTTLE_MS = 120000;

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const userId = String((body && body.userId) || '').trim();
  if (!userId) return json({ ok: false, error: 'missing_user' }, 400);
  if (!env.BREVO_API_KEY || !env.WC_STATE) return json({ ok: false, error: 'not_configured' }, 503);

  const throttleKey = 'mailnotif:' + userId;
  if (await env.WC_STATE.get(throttleKey)) return json({ ok: true, throttled: true });
  await env.WC_STATE.put(throttleKey, '1', { expirationTtl: Math.ceil(THROTTLE_MS / 1000) });

  const sync = String(env.SYNC_ORIGIN || SYNC_DEFAULT).replace(/\/+$/, '');
  let user = null;
  try {
    const res = await fetch(sync + '/api/state', { headers: { accept: 'application/json' } });
    const data = await res.json();
    const users = (data && data.db && Array.isArray(data.db.users)) ? data.db.users : [];
    user = users.find((u) => u && u.id === userId) || null;
  } catch (e) { return json({ ok: false, error: 'sync_unavailable' }, 502); }
  if (!user || !user.email) return json({ ok: false, error: 'user_not_found' }, 404);
  if (user.settings && user.settings.emailNotifications === false) return json({ ok: true, disabled: true });
  if (user.emailVerified !== true && user.verified !== true) return json({ ok: true, unverified: true });
  if (/@whalechat\.app$/i.test(user.email)) return json({ ok: true, skipped: 'internal' });

  const host = request.headers.get('host') || 'whalechat.pages.dev';
  const link = String((body && body.link) || '#/home');
  const url = 'https://' + host + '/whalechat.html' + (link.indexOf('#') === 0 ? link : '#/home');
  const title = esc((body && body.title) || 'WhaleChat notification');
  const text = esc((body && body.body) || 'You have a new notification.');
  const first = esc(String(user.fullName || user.username || 'there').split(' ')[0]);

  const html = `
  <div style="background:#04101a;padding:26px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#0b1723;border:1px solid #16303f;border-radius:16px;overflow:hidden">
      <div style="padding:18px 22px;background:linear-gradient(135deg,#0f766e,#0b3d5c)">
        <div style="font-size:11px;letter-spacing:.18em;color:#9fe9dd;font-weight:700">WHALECHAT</div>
        <h1 style="margin:6px 0 0;font-size:20px;color:#eaf6fb">${title}</h1>
      </div>
      <div style="padding:20px 22px;color:#c7d8e2;font-size:14.5px;line-height:1.65">
        <p style="margin:0 0 10px">Hi ${first},</p>
        <p style="margin:0 0 18px">${text}</p>
        <a href="${esc(url)}" style="display:inline-block;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:800;padding:11px 20px;border-radius:10px">Open WhaleChat</a>
        <p style="margin:18px 0 0;font-size:11.5px;color:#63808f">You are receiving this because email notifications are on. You can turn them off in Settings → Preferences.</p>
      </div>
    </div>
  </div>`;

  const mail = await sendBrevo(env, { to: user.email, toName: user.fullName || user.username, subject: title, html });
  if (!mail.ok) return json({ ok: false, error: mail.error || 'mail_failed' }, 502);
  return json({ ok: true, sentTo: String(user.email).slice(0, 2) + '***' });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
}
