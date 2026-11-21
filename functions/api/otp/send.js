/**
 * POST /api/otp/send  { email, name }
 *
 * Generates a 6-digit signup verification code and emails it through Brevo
 * from the Cloudflare edge (the app's sync host cannot reach Brevo because of
 * its IP allow-list). Codes live in the WC_STATE KV namespace for 15 minutes,
 * hashed with WC_OTP_SECRET, with a 60s resend cooldown and 5 sends/hour.
 */
import { json, maskEmail, codeEmail, otpHash, sendBrevo } from '../../_lib/mail.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ ok: false, error: 'bad_email', message: 'Enter a valid email address' }, 400);
  }
  if (!env.WC_STATE) return json({ ok: false, error: 'storage_unavailable' }, 503);

  const key = 'otp:signup:' + email;
  const now = Date.now();
  let prev = null;
  try { prev = await env.WC_STATE.get(key, 'json'); } catch (e) { prev = null; }

  if (prev && now - Number(prev.sentAt || 0) < 60000) {
    return json({
      ok: false, error: 'too_soon', message: 'Please wait before requesting another code',
      retryIn: Math.ceil((60000 - (now - Number(prev.sentAt || 0))) / 1000)
    }, 429);
  }
  const inWindow = prev && now - Number(prev.windowStart || 0) < 3600000;
  const sends = inWindow ? Number(prev.sends || 0) : 0;
  if (sends >= 5) {
    return json({ ok: false, error: 'too_many', message: 'Too many codes requested. Try again in an hour.' }, 429);
  }

  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  const code = String(100000 + (bytes[0] % 900000));
  const secret = String(env.WC_OTP_SECRET || 'whalechat-otp');
  const hash = await otpHash(secret, email, code);
  /* Keep every code issued in the last 24h: a resend must never invalidate a
     code the user already has in their inbox. */
  const KEEP_MS = 24 * 60 * 60 * 1000;
  const history = (prev && Array.isArray(prev.history))
    ? prev.history.filter((h) => h && h.hash && now - Number(h.at || 0) < KEEP_MS)
    : [];
  history.unshift({ hash, at: now, exp: now + 15 * 60000 });

  const appUrl = 'https://' + (request.headers.get('host') || 'whalechat.pages.dev');
  const purpose = String((body && body.purpose) || 'signup') === 'signup' ? 'your WhaleChat account' : 'your WhaleChat account';
  const name = String((body && body.name) || '').trim();

  const mail = await sendBrevo(env, {
    to: email,
    toName: name || email,
    subject: 'Your WhaleChat verification code: ' + code,
    html: codeEmail({ name, code, purpose, appUrl })
  });
  if (!mail.ok) {
    return json({ ok: false, error: mail.error || 'mail_failed', message: 'Could not send the code right now. Try again.' }, 502);
  }

  await env.WC_STATE.put(key, JSON.stringify({
    hash,
    hashes: history.map((h) => h.hash).slice(0, 10),
    history: history.slice(0, 10),
    exp: now + 15 * 60000,
    sentAt: now,
    windowStart: inWindow ? Number(prev.windowStart) : now,
    sends: sends + 1,
    tries: 0,
    name,
    email
  }), { expirationTtl: 900 });

  return json({ ok: true, queued: true, to: maskEmail(email), expiresIn: 900, attemptsLeft: 6 });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
}
