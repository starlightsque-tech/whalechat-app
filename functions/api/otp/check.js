/**
 * POST /api/otp/check  { email, code }
 *
 * Verifies a signup code from KV, marks the account verified on the sync
 * server, and returns the payload the app expects from
 * /api/verify/signup/confirm so the existing screen continues automatically.
 */
import { json, otpHash } from '../../_lib/mail.js';

const SYNC_DEFAULT = 'https://whalechat-live.fly.dev';

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const email = String((body && body.email) || '').trim().toLowerCase();
  const code = String((body && body.code) || '').replace(/\D/g, '');
  if (!email || code.length !== 6) return json({ ok: false, error: 'invalid', message: 'Enter the 6-digit code from the email' }, 400);
  if (!env.WC_STATE) return json({ ok: false, error: 'storage_unavailable' }, 503);

  const key = 'otp:signup:' + email;
  const rec = await env.WC_STATE.get(key, 'json');
  if (!rec) return json({ ok: false, error: 'no_code', message: 'Request a verification code first' }, 400);
  if (Date.now() > Number(rec.exp || 0)) {
    await env.WC_STATE.delete(key);
    return json({ ok: false, error: 'expired', message: 'That code has expired — send a new one' }, 400);
  }
  if (Number(rec.tries || 0) >= 6) {
    await env.WC_STATE.delete(key);
    return json({ ok: false, error: 'locked', message: 'Too many attempts — send a new code' }, 429);
  }

  const secret = String(env.WC_OTP_SECRET || 'whalechat-otp');
  const hash = await otpHash(secret, email, code);
  if (hash !== rec.hash) {
    rec.tries = Number(rec.tries || 0) + 1;
    await env.WC_STATE.put(key, JSON.stringify(rec), { expirationTtl: 900 });
    return json({ ok: false, error: 'invalid', message: 'That code is not correct', attemptsLeft: Math.max(0, 6 - rec.tries) }, 400);
  }

  const sync = String(env.SYNC_ORIGIN || SYNC_DEFAULT).replace(/\/+$/, '');
  let user = null;
  try {
    const res = await fetch(sync + '/api/state', { headers: { accept: 'application/json' } });
    const data = await res.json();
    const users = (data && data.db && Array.isArray(data.db.users)) ? data.db.users : [];
    user = users.find((u) => u && String(u.email || '').trim().toLowerCase() === email) || null;
  } catch (e) {
    return json({ ok: false, error: 'sync_unavailable', message: 'Could not reach the account service — try again' }, 502);
  }
  if (!user) return json({ ok: false, error: 'user_missing', message: 'Account not found — try again in a moment' }, 404);

  const now = Date.now();
  try {
    const opsRes = await fetch(sync + '/api/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ops: [{
          op: 'update', col: 'users', id: user.id,
          patch: {
            verified: true,
            emailVerified: true,
            verifiedAt: now,
            verificationMethod: 'email_code',
            emailVerifyRequired: false
          }
        }]
      })
    });
    const opsData = await opsRes.json().catch(() => ({}));
    if (!opsRes.ok || opsData.ok === false) {
      return json({ ok: false, error: 'verify_failed', message: 'Could not mark the account verified — try again' }, 502);
    }
  } catch (e) {
    return json({ ok: false, error: 'verify_failed', message: 'Could not mark the account verified — try again' }, 502);
  }

  await env.WC_STATE.delete(key);
  return json({ ok: true, verifiedAt: now, userId: user.id, username: user.username || '', role: user.role || 'user' });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
}
