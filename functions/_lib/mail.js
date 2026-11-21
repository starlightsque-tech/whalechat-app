/** Shared Brevo sender for WhaleChat Pages Functions (not routed). */

export const DEFAULT_FROM = 'whalechat1@gmail.com';

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

export async function sendBrevo(env, { to, toName, subject, html }) {
  if (!env.BREVO_API_KEY) return { ok: false, error: 'mail_not_configured' };
  const from = String(env.BREVO_FROM || env.BREVO_SENDER_EMAIL || DEFAULT_FROM);
  const fromName = String(env.BREVO_FROM_NAME || env.BREVO_SENDER_NAME || 'WhaleChat');
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: fromName, email: from },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html
      })
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, error: 'brevo_failed', status: res.status, message: String(txt).slice(0, 300) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'brevo_unreachable' };
  }
}

export async function otpHash(secret, email, code) {
  const data = new TextEncoder().encode('whalechat::otp::v1::' + secret + '::' + String(email).toLowerCase() + '::' + String(code));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function maskEmail(e) {
  return String(e || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
}

export function codeEmail({ name, code, purpose, appUrl }) {
  const first = String(name || 'there').split(' ')[0];
  return `
  <div style="background:#04101a;padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#0b1723;border:1px solid #16303f;border-radius:18px;overflow:hidden">
      <div style="padding:22px 24px;background:linear-gradient(135deg,#0f766e,#0b3d5c)">
        <div style="font-size:12px;letter-spacing:.18em;color:#9fe9dd;font-weight:700">WHALECHAT</div>
        <h1 style="margin:8px 0 0;font-size:23px;color:#eaf6fb">Your verification code</h1>
      </div>
      <div style="padding:24px;color:#c7d8e2;font-size:14.5px;line-height:1.7">
        <p style="margin:0 0 6px">Hi ${esc(first)}, use this code to verify ${esc(purpose || 'your WhaleChat account')}. It expires in 15 minutes.</p>
        <div style="margin:20px 0;text-align:center">
          <div style="display:inline-block;font-family:Menlo,Consolas,monospace;font-size:32px;letter-spacing:9px;font-weight:800;color:#eaf6fb;background:#04101a;border:1px dashed #2ee6c9;border-radius:12px;padding:14px 22px;user-select:all;-webkit-user-select:all">${esc(code)}</div>
        </div>
        <p style="text-align:center;margin:16px 0 6px"><a href="${esc(appUrl)}/whalechat.html#/verify" style="display:inline-block;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:800;padding:11px 20px;border-radius:10px">Open WhaleChat &amp; paste the code</a></p>
        <p style="font-size:12px;color:#63808f;margin:12px 0 0">Tip: tap and hold the code to copy it. If you did not request this, ignore this email and never share the code.</p>
      </div>
    </div>
  </div>`;
}
