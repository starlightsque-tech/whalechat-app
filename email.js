/* =========================================================================
   WhaleChat transactional email (Outlook / Microsoft 365 SMTP)
   -------------------------------------------------------------------------
   Configure with environment variables:
     SMTP_HOST     default smtp-mail.outlook.com
     SMTP_PORT     default 587 (STARTTLS)
     SMTP_USER     e.g. whalechat@hotmail.com
     SMTP_PASS     app password for that mailbox
     MAIL_FROM     default SMTP_USER
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
const OUTBOX = path.join(DATA_DIR, 'outbox.json');
const SENT = path.join(DATA_DIR, 'email-sent.json');

const cfg = {
  host: process.env.SMTP_HOST || 'smtp-mail.outlook.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  user: process.env.SMTP_USER || process.env.OUTLOOK_EMAIL || '',
  pass: process.env.SMTP_PASS || process.env.OUTLOOK_APP_PASSWORD || '',
  from: process.env.MAIL_FROM || process.env.SMTP_USER || process.env.OUTLOOK_EMAIL || '',
  fromName: process.env.MAIL_FROM_NAME || 'WhaleChat'
};

const state = { queued: 0, sent: 0, failed: 0, lastError: '', lastSentAt: null };
let queue = [];
let sentKeys = [];
let transport = null;
let timer = null;

function configured() {
  return !!(nodemailer && cfg.user && cfg.pass && cfg.from);
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
  if (configured()) {
    transport = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
    });
  }
  clearInterval(timer);
  timer = setInterval(() => { flush().catch(() => {}); }, 60 * 1000);
  if (timer.unref) timer.unref();
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
          <h1 style="margin:0 0 12px;font-size:21px;line-height:1.25;color:#e9f4f9">${title}</h1>
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
  flush().catch(() => {});
  return true;
}

async function flush() {
  if (!configured() || !queue.length) return { sent: 0, failed: 0 };
  if (flush.running) return { sent: 0, failed: 0 };
  flush.running = true;
  let sent = 0, failed = 0;
  try {
    for (const item of [...queue]) {
      try {
        await transport.sendMail({
          from: `"${cfg.fromName}" <${cfg.from}>`,
          to: item.to,
          subject: item.subject,
          text: item.text,
          html: item.html
        });
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
  }
  return { sent, failed };
}

function status() {
  return {
    ok: true,
    configured: configured(),
    from: cfg.from || null,
    host: cfg.host,
    port: cfg.port,
    queued: queue.length,
    sent: state.sent,
    failed: state.failed,
    lastError: state.lastError,
    lastSentAt: state.lastSentAt
  };
}

load();

module.exports = { enqueue, flush, status, configured };
