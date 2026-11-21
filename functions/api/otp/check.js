/**
 * POST /api/otp/check  { email, code }
 *
 * Verifies a signup code from KV, marks the account verified on the sync
 * server, and returns the payload the app expects from
 * /api/verify/signup/confirm so the existing screen continues automatically.
 *
 * Rule: a code that this edge actually emailed to the address always verifies.
 * Leading zeros, spaces, dashes, full-width digits, pasted text, a newer
 * resend, an expired clock or earlier typos can never make a correct code fail.
 */
import { json, otpHash, normalizeCode, hashMatches, otpCandidates } from '../../_lib/mail.js';

const SYNC_DEFAULT = 'https://whalechat-live.fly.dev';

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const email = String((body && body.email) || '').trim().toLowerCase();
  const code = normalizeCode(body && body.code);
  if (!email || code.length !== 6) return json({ ok: false, error: 'invalid', message: 'Enter the 6-digit code from the email' }, 400);
  if (!env.WC_STATE) return json({ ok: false, error: 'storage_unavailable' }, 503);

  const key = 'otp:signup:' + email;
  const rec = await env.WC_STATE.get(key, 'json');
  if (!rec) return json({ ok: false, error: 'no_code', message: 'Request a verification code first' }, 400);

  const secret = String(env.WC_OTP_SECRET || 'whalechat-otp');
  const hash = await otpHash(secret, email, code);
  const matches = hashMatches(hash, otpCandidates(rec));
  if (!matches) {
    /* Wrong guess: count it, but never clear or lock a code that might still
       be the one sitting in the user's inbox. */
    rec.tries = Number(rec.tries || 0) + 1;
    if (Array.isArray(rec.history)) rec.history = rec.history.filter((h) => h && h.hash);
    try { await env.WC_STATE.put(key, JSON.stringify(rec), { expirationTtl: 86400 }); } catch (e) {}
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
    /* The code is proven correct. Do not fail verification because the sync
       read was slow: let the device mark its local copy and retry the write. */
    return json({ ok: true, localOnly: true, verifiedAt: Date.now(), warning: 'sync_read_unavailable' });
  }

  if (!user) {
    return json({ ok: true, localOnly: true, verifiedAt: Date.now(), warning: 'user_not_synced_yet' });
  }

  const now = Date.now();
  if (user.emailVerified === true || user.verified === true) {
    try { await env.WC_STATE.delete(key); } catch (e) {}
    return json({ ok: true, verifiedAt: user.verifiedAt || now, userId: user.id, username: user.username || '', role: user.role || 'user', alreadyVerified: true });
  }

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
      /* Correct code, transient write failure — keep the code and report a
         retryable state instead of rejecting the user's valid code. */
      return json({ ok: true, localOnly: true, verifiedAt: now, userId: user.id, username: user.username || '', warning: 'sync_write_failed' });
    }
  } catch (e) {
    return json({ ok: true, localOnly: true, verifiedAt: now, userId: user.id, username: user.username || '', warning: 'sync_write_failed' });
  }

  try { await env.WC_STATE.delete(key); } catch (e) {}
  return json({ ok: true, verifiedAt: now, userId: user.id, username: user.username || '', role: user.role || 'user' });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
}
