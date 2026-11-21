/* =========================================================================
   WhaleChat transactional email (Brevo API, Brevo SMTP relay, Resend or
   Outlook / Microsoft 365 SMTP)
   -------------------------------------------------------------------------
   Provider priority:
     1. BREVO_API_KEY                         Brevo transactional API
     2. RESEND_API_KEY                        Resend API
     3. BREVO_SMTP_KEY (+ BREVO_SMTP_USER)    Brevo SMTP relay
     4. SMTP_USER + SMTP_PASS                 any SMTP mailbox (Outlook etc.)

   Brevo SMTP relay variables:
     BREVO_SMTP_USER  your Brevo login (e.g. you@example.com)
     BREVO_SMTP_KEY   SMTP key from Brevo → SMTP & API → SMTP
     BREVO_SMTP_HOST  default smtp-relay.brevo.com
     BREVO_SMTP_PORT  default 587 (STARTTLS)

   Shared:
     MAIL_FROM     verified sender address (default whalechat1@gmail.com)
     MAIL_FROM_NAME default WhaleChat
   Emails are queued in DATA_DIR/outbox.json and retried, so a temporary
   SMTP failure never loses a notification.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAIL_CFG_FILE = path.join(DATA_DIR, 'mail.json');
function applyRuntimeMail() {
  try {
    const c = JSON.parse(fs.readFileSync(MAIL_CFG_FILE, 'utf8'));
    if (c.brevoKey) cfg.brevoKey = c.brevoKey;
    if (c.brevoSmtpUser) cfg.brevoSmtpUser = c.brevoSmtpUser;
    if (c.brevoSmtpKey) cfg.brevoSmtpKey = c.brevoSmtpKey;
    if (c.brevoSmtpHost) cfg.brevoSmtpHost = c.brevoSmtpHost;
    if (c.brevoSmtpPort) cfg.brevoSmtpPort = Number(c.brevoSmtpPort);
    if (c.resendKey) cfg.resendKey = c.resendKey;
    if (c.from) cfg.from = c.from;
    if (c.fromName) cfg.fromName = c.fromName;
    if (c.host) cfg.host = c.host;
    if (c.port) cfg.port = Number(c.port);
  } catch (e) {}
}

const OUTBOX = path.join(DATA_DIR, 'outbox.json');
const SENT = path.join(DATA_DIR, 'email-sent.json');

const cfg = {
  host: process.env.SMTP_HOST || 'smtp-mail.outlook.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  user: process.env.SMTP_USER || process.env.OUTLOOK_EMAIL || '',
  pass: process.env.SMTP_PASS || process.env.OUTLOOK_APP_PASSWORD || '',
  resendKey: process.env.RESEND_API_KEY || '',
  resendFrom: process.env.RESEND_FROM || '',
  brevoKey: process.env.BREVO_API_KEY || '',
  brevoSmtpUser: process.env.BREVO_SMTP_USER || process.env.BREVO_LOGIN || '',
  brevoSmtpKey: process.env.BREVO_SMTP_KEY || process.env.BREVO_SMTP_PASSWORD || '',
  brevoSmtpHost: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
  brevoSmtpPort: Number(process.env.BREVO_SMTP_PORT || 587),
  /* wc-verified-sender */ from: (function () {
    var want = String(process.env.MAIL_FROM || '').trim().toLowerCase();
    var verified = 'whalechat1@gmail.com';
    if (want && want === verified) return process.env.MAIL_FROM;
    if (want) console.warn('[mail] MAIL_FROM ' + want + ' is not a verified Brevo sender - using ' + verified);
    return verified;
  })(),
  fromName: process.env.MAIL_FROM_NAME || 'WhaleChat'
};
function provider() {
  applyRuntimeMail();
  if (cfg.brevoKey) return 'brevo';
  if (cfg.resendKey) return 'resend';
  if (cfg.brevoSmtpUser && cfg.brevoSmtpKey) return 'brevo-smtp';
  if (cfg.user && cfg.pass) return 'smtp';
  return 'none';
}

const state = { queued: 0, sent: 0, failed: 0, lastError: '', lastSentAt: null };
let queue = [];
let sentKeys = [];
let transport = null;
let timer = null;

function configured() {
  applyRuntimeMail();
  if (cfg.brevoKey) return !!cfg.from;
  if (cfg.resendKey) return !!cfg.from;
  if (cfg.brevoSmtpUser && cfg.brevoSmtpKey) return !!(nodemailer && cfg.from);
  return !!(nodemailer && cfg.user && cfg.pass && cfg.from);
}
function transportConfig() {
  const p = provider();
  if (p === 'brevo-smtp') {
    return {
      host: cfg.brevoSmtpHost, port: cfg.brevoSmtpPort, secure: cfg.brevoSmtpPort === 465,
      auth: { user: cfg.brevoSmtpUser, pass: cfg.brevoSmtpKey }
    };
  }
  return { host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass } };
}
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJSON(file, value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch (e) { /* storage is best-effort; email must never crash the app */ }
}

function load() {
  queue = readJSON(OUTBOX, []);
  sentKeys = readJSON(SENT, []);
  if (!Array.isArray(queue)) queue = [];
  if (!Array.isArray(sentKeys)) sentKeys = [];
  state.queued = queue.length;
  if (configured() && (provider() === 'smtp' || provider() === 'brevo-smtp')) {
    const tc = transportConfig();
    transport = nodemailer.createTransport({
      host: tc.host, port: tc.port, secure: tc.secure, auth: tc.auth,
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
    });
  } else {
    transport = null;
  }
  clearInterval(timer);
  timer = setInterval(() => { flush().catch(() => {}); }, 60 * 1000);
  if (timer.unref) timer.unref();
  if (configured() && queue.length) setTimeout(() => { flush().catch(() => {}); }, 1200);
}
function save() {
  state.queued = queue.length;
  writeJSON(OUTBOX, queue.slice(-200));
  writeJSON(SENT, sentKeys.slice(-5000));
}
function isSent(key) { return sentKeys.includes(key); }
function markSent(key) { if (!sentKeys.includes(key)) { sentKeys.push(key); } }

function layout(title, bodyHtml, cta) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#04101a;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#04101a;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0a1a28;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden">
        <tr><td style="padding:22px 26px;border-bottom:1px solid rgba(255,255,255,.07)">
          <span style="font-size:19px;font-weight:800;color:#e9f4f9;letter-spacing:-.02em">Whale<span style="color:#2ee6c9">Chat</span></span>
        </td></tr>
        <tr><td style="padding:26px">
          ${title ? `<h1 style="margin:0 0 12px;font-size:21px;line-height:1.25;color:#e9f4f9">${title}</h1>` : ''}
          <div style="font-size:14px;line-height:1.7;color:#a9bfcd">${bodyHtml}</div>
          ${cta ? `<div style="margin-top:22px"><a href="${cta.url}" style="display:inline-block;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">${cta.label}</a></div>` : ''}
        </td></tr>
        <tr><td style="padding:16px 26px;border-top:1px solid rgba(255,255,255,.07);font-size:11px;color:#63798a">
          You are receiving this because you have a WhaleChat account. Replies to this address are monitored.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

const templates = {
  welcome(user, ctx) {
    const name = (user.fullName || user.username || 'there').split(' ')[0];
    return {
      subject: 'Welcome to WhaleChat 🐋',
      html: layout('Welcome aboard, ' + escapeHtml(name) + '!',
        `Your WhaleChat account is ready.<br/><br/>
         <b style="color:#e9f4f9">Username:</b> @${escapeHtml(user.username || '')}<br/>
         <b style="color:#e9f4f9">Email:</b> ${escapeHtml(user.email || '')}<br/>
         <b style="color:#e9f4f9">Referral code:</b> ${escapeHtml(user.referralCode || '')}<br/><br/>
         Chat with contacts, shop the marketplace and manage your Whale Coin wallet from one place.`,
        { label: 'Open WhaleChat', url: ctx.appUrl + '/whalechat.html' }),
      text: `Welcome to WhaleChat, ${name}. Your account @${user.username} is ready. Open ${ctx.appUrl}/whalechat.html`
    };
  },
  delivered(payload, ctx) {
    const order = (payload && payload.order) || payload || {};
    const user = (payload && payload.user) || {};
    const items = (order.items || []).map(i => `${i.name} × ${i.qty || 1}`).join(', ');
    return {
      subject: 'Your WhaleChat order ' + (order.ref || '') + ' has arrived 📦',
      html: layout('Your package has arrived',
        `Hi ${escapeHtml((user.fullName || user.username || 'there').split(' ')[0])},<br/><br/>
         Order <b style="color:#e9f4f9">${escapeHtml(order.ref || '')}</b> was marked as delivered.<br/><br/>
         <b style="color:#e9f4f9">Items:</b> ${escapeHtml(items || '—')}<br/>
         <b style="color:#e9f4f9">Total:</b> ${escapeHtml(String(order.totalCoins || 0))} WC<br/>
         ${order.tracking ? `<b style="color:#e9f4f9">Tracking:</b> ${escapeHtml(order.tracking)}<br/>` : ''}
         <br/>Thanks for shopping with WhaleChat.`,
        { label: 'View your order', url: ctx.appUrl + '/whalechat.html#/orders' }),
      text: `Order ${order.ref} has arrived. Items: ${items}.`
    };
  },
  custom(data, ctx) {
    const html = String(data.html || '');
    const text = String(data.text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000));
    return { subject: String(data.subject || 'WhaleChat'), html: layout(null, html, null), text };
  },
  b2bAlert(data, ctx) {
    const d = data || {};
    const user = d.user || {};
    const first = String(user.fullName || user.username || 'there').split(' ')[0];
    const ticker = String(d.ticker || '').toUpperCase();
    const isBuy = String(d.side || 'buy') === 'buy';
    const price = Number(d.price) || 0;
    const target = Number(d.target) || 0;
    const money = (v) => '$' + (Math.round(v * 100) / 100).toFixed(2);
    const buyUrl = d.buyUrl || (ctx.appUrl + '/whalechat.html#/investment/b2b/buy');
    const sellUrl = d.sellUrl || (ctx.appUrl + '/whalechat.html#/investment/b2b/sell');
    const title = isBuy ? 'Buy target reached · ' + ticker : 'Sell target reached · ' + ticker;
    const line = isBuy
      ? ticker + ' is trading at <b style="color:#e9f4f9">' + money(price) + '</b>, at or below your buy target of ' + money(target) + '.'
      : ticker + ' is trading at <b style="color:#e9f4f9">' + money(price) + '</b>, at or above your sell target of ' + money(target) + '.';
    const primary = isBuy ? buyUrl : sellUrl;
    return {
      subject: title + ' · WhaleChat',
      html: layout(title,
        `Hi ${escapeHtml(first)},<br/><br/>${line}<br/><br/>
         Your B2B investing desk is ready — open it to act on the alert.
         <div style="margin-top:18px">
           <a href="${escapeHtml(buyUrl)}" style="display:inline-block;background:#22c55e;color:#04220f;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px;margin:0 8px 0 0">Buy now</a>
           <a href="${escapeHtml(sellUrl)}" style="display:inline-block;background:#ef4444;color:#2a0505;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px">Sell now</a>
         </div>
         <div style="margin-top:16px;font-size:12px;color:#63798a">This alert stays active until you remove it on the desk. Price alerts do not place orders for you unless you selected Auto Buy/Sell for this asset.</div>`,
        { label: isBuy ? 'Buy ' + ticker + ' now' : 'Sell ' + ticker + ' now', url: primary }),
      text: title + '. ' + ticker + ' is ' + money(price) + ' (target ' + money(target) + '). Buy: ' + buyUrl + ' · Sell: ' + sellUrl
    };
  },
  b2bAutoTrade(data, ctx) {
    const d = data || {};
    const user = d.user || {};
    const first = String(user.fullName || user.username || 'there').split(' ')[0];
    const ticker = String(d.ticker || '').toUpperCase();
    const isBuy = String(d.side || 'buy') === 'buy';
    const money = (v) => '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);
    const units = Number(Number(d.units) || 0).toLocaleString('en-US', { maximumFractionDigits: 6 });
    const deskUrl = d.deskUrl || (ctx.appUrl + '/whalechat.html#/investment/b2b');
    const payout = Number(d.payout) || 0;
    const title = isBuy ? 'Auto Buy/Sell bought ' + ticker : 'Auto Buy/Sell sold ' + ticker;
    const line = isBuy
      ? 'Your Auto Buy/Sell tool bought <b style="color:#e9f4f9">' + units + ' ' + escapeHtml(ticker) + '</b> for ' + money(d.amount) + ' at your buy price of <b style="color:#e9f4f9">' + money(d.price) + '</b>. It was paid from your B2B capital balance.'
      : 'Your Auto Buy/Sell tool sold <b style="color:#e9f4f9">' + units + ' ' + escapeHtml(ticker) + '</b> at your sell price of <b style="color:#e9f4f9">' + money(d.price) + '</b> (' + money(d.proceeds) + '). Payout <b style="color:' + (payout >= 0 ? '#22c55e' : '#ef4444') + '">' + (payout >= 0 ? '+' : '') + money(payout) + '</b> went to your B2B profit balance and ' + money(d.basis) + ' capital returned to your capital balance.';
    return {
      subject: title + ' · WhaleChat',
      html: layout(title,
        `Hi ${escapeHtml(first)},<br/><br/>${line}<br/><br/>
         <div style="margin-top:16px;font-size:12px;color:#63798a">Auto Buy/Sell only trades assets where you selected "Use Auto Buy/Sell" and set a buy or sell price. You can switch it off on the B2B desk at any time.</div>`,
        { label: 'Open the B2B desk', url: deskUrl }),
      text: title + '. ' + units + ' ' + ticker + ' at ' + money(d.price) + (isBuy ? ' for ' + money(d.amount) : ' · payout ' + money(payout)) + '. ' + deskUrl
    };
  },
  verifyCode(data, ctx) {
    const d = data || {};
    const code = String(d.code || '');
    const first = String(d.name || 'there').split(' ')[0];
    const purpose = escapeHtml(d.purposeLabel || 'your request');
    const copyUrl = ctx.appUrl + '/whalechat.html#/investment/account/' + encodeURIComponent(d.purposeRoute || 'delete') + '?code=' + encodeURIComponent(code);
    return {
      subject: 'Your WhaleChat verification code: ' + code,
      html: layout('Your verification code',
        `Hi ${escapeHtml(first)},<br/><br/>Use this code to verify ${purpose}. It expires in 15 minutes.
         <div style="margin:18px 0;text-align:center">
           <div style="display:inline-block;font-family:Menlo,Consolas,monospace;font-size:30px;letter-spacing:8px;font-weight:800;color:#e9f4f9;background:#04101a;border:1px dashed #2ee6c9;border-radius:12px;padding:14px 22px;user-select:all;-webkit-user-select:all">${escapeHtml(code)}</div>
         </div>
         <div style="text-align:center;margin-bottom:8px">
           <a href="${escapeHtml(copyUrl)}" style="display:inline-block;background:#2ee6c9;color:#03221d;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:10px">Copy code &amp; open WhaleChat</a>
         </div>
         <div style="font-size:12px;color:#63798a;text-align:center">Tip: tap and hold (or double-click) the code to select and copy it.</div>
         <br/>If you did not request this, ignore this email and contact support. Never share this code with anyone.`, null),
      text: 'Your WhaleChat verification code is ' + code + ' (valid 15 minutes). Open: ' + copyUrl
    };
  },
  test(ctx) {
    return {
      subject: 'WhaleChat email service is working',
      html: layout('Email service connected',
        `This test confirms WhaleChat can send mail through <b style="color:#e9f4f9">${escapeHtml(cfg.from)}</b> (${escapeHtml(cfg.host)}).<br/><br/>
         Account-creation and package-delivery emails will use this channel.`,
        { label: 'Open WhaleChat', url: ctx.appUrl + '/whalechat.html' }),
      text: 'WhaleChat email service is working.'
    };
  }
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function enqueue({ key, to, template, data, appUrl }) {
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) return false;
  if (key && isSent(key)) return false;
  const tpl = templates[template];
  if (!tpl) return false;
  const t = tpl(data, { appUrl });
  const item = {
    id: 'em_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    key: key || null, to: String(to), subject: t.subject, html: t.html, text: t.text,
    template, createdAt: Date.now(), attempts: 0, lastError: '', sentAt: null
  };
  // collapse duplicates that are already waiting
  if (key && queue.some(q => q.key === key)) return false;
  queue.push(item);
  save();
  kickFlush();
  return true;
}

function kickFlush(delay) { setTimeout(() => { flush().catch(() => {}); }, delay || 300); }

async function flush() {
  if (!configured() || !queue.length) return { sent: 0, failed: 0 };
  if (flush.running) return { sent: 0, failed: 0 };
  flush.running = true;
  let sent = 0, failed = 0;
  try {
    for (const item of [...queue]) {
      try {
        if (provider() === 'brevo') {
          /* The Fly Render host's IP is not on Brevo's allow-list, so mail is
             relayed through the Cloudflare edge when a relay is configured. */
          const relayUrl = String(process.env.MAIL_RELAY_URL || '').trim();
          const relaySecret = String(process.env.MAIL_RELAY_SECRET || '').trim();
          const target = (relayUrl && relaySecret) ? relayUrl : 'https://api.brevo.com/v3/smtp/email';
          const apiKey = (relayUrl && relaySecret) ? relaySecret : cfg.brevoKey;
          const res = await fetch(target, {
            method: 'POST',
            headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              sender: { name: cfg.fromName, email: cfg.from },
              to: [{ email: item.to }],
              subject: item.subject,
              htmlContent: item.html,
              textContent: item.text
            })
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            let msg = body.slice(0, 300);
            try { const j = JSON.parse(body); msg = j.message || msg; } catch (e) {}
            throw new Error('Brevo ' + res.status + ': ' + msg);
          }
        } else if (provider() === 'resend') {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + cfg.resendKey, 'content-type': 'application/json' },
            body: JSON.stringify({
              from: `${cfg.fromName} <${cfg.from}>`,
              to: [item.to],
              subject: item.subject,
              html: item.html,
              text: item.text
            })
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            let msg = body.slice(0, 300);
            try { msg = JSON.parse(body).message || msg; } catch (e) {}
            throw new Error('Resend ' + res.status + ': ' + msg);
          }
        } else {
          if (!transport) {
            const tc = transportConfig();
            transport = nodemailer.createTransport({
              host: tc.host, port: tc.port, secure: tc.secure, auth: tc.auth,
              tls: { minVersion: 'TLSv1.2' },
              connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
            });
          }
          await transport.sendMail({
            from: `"${cfg.fromName}" <${cfg.from}>`,
            to: item.to,
            subject: item.subject,
            text: item.text,
            html: item.html
          });
        }
        item.sentAt = Date.now();
        if (item.key) markSent(item.key);
        queue = queue.filter(q => q.id !== item.id);
        sent++;
        state.sent++;
        state.lastSentAt = item.sentAt;
        state.lastError = '';
      } catch (e) {
        item.attempts = (item.attempts || 0) + 1;
        item.lastError = String(e.message || e).slice(0, 300);
        state.lastError = item.lastError;
        state.failed++;
        failed++;
        if (item.attempts >= 6) {
          queue = queue.filter(q => q.id !== item.id);
          if (item.key) markSent(item.key); // stop retrying a permanently bad address
        }
        break; // SMTP trouble: stop this round and retry later
      }
    }
  } finally {
    flush.running = false;
    save();
    if (queue.length && failed === 0) kickFlush(800);
  }
  return { sent, failed };
}

function status() {
  return {
    ok: true,
    configured: configured(),
    provider: provider(),
    from: cfg.from || null,
    host: provider() === 'brevo' ? 'api.brevo.com'
      : provider() === 'resend' ? 'api.resend.com'
      : provider() === 'brevo-smtp' ? cfg.brevoSmtpHost
      : cfg.host,
    port: provider() === 'brevo-smtp' ? cfg.brevoSmtpPort : (provider() === 'smtp' ? cfg.port : 443),
    queued: queue.length,
    sent: state.sent,
    failed: state.failed,
    lastError: state.lastError,
    lastSentAt: state.lastSentAt
  };
}

load();

module.exports = { enqueue, flush, status, configured };
