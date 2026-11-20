'use strict';
/* =========================================================================
   WhaleChat · dependency-free SMTP client
   -------------------------------------------------------------------------
   Sends transactional mail through Brevo's SMTP relay (or any standard SMTP
   server) without nodemailer, so the exact same module works in the Node
   server and inside the Appwrite Function runtime.

     SMTP relay:  host smtp-relay.brevo.com · port 587 (STARTTLS) or 465 (TLS)
     login:       the Brevo account login (SMTP user)
     password:    the Brevo SMTP key (SMTP & API → SMTP tab)

   Supports implicit TLS (465), STARTTLS (587/25), AUTH PLAIN and AUTH LOGIN,
   UTF-8 subjects, HTML + plain-text multipart bodies and correct dot
   stuffing. Throws on a non-2xx reply so the caller can retry or fall back.
   ========================================================================= */

const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

const CRLF = '\r\n';
const DEFAULT_TIMEOUT = Number(process.env.SMTP_TIMEOUT_MS || 20000);

function cleanHeader(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeader(value) {
  const s = cleanHeader(value);
  if (!s) return '';
  /* ASCII-only headers can be sent verbatim; anything else is RFC 2047 */
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

function mailbox(email, name) {
  const addr = cleanHeader(email).replace(/[<>]/g, '');
  const label = name ? encodeHeader(name) : '';
  return label ? label + ' <' + addr + '>' : '<' + addr + '>';
}

class SmtpConnection {
  constructor(socket, opts) {
    this.socket = socket;
    this.opts = opts || {};
    this.buffer = '';
    this.current = null;
    this.responses = [];
    this.waiters = [];
    this.closed = false;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    this.buffer = '';
    this.current = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => {
      this.closed = true;
      this.fail(new Error('smtp_connection_closed'));
    });
  }

  detach() {
    try { this.socket.removeAllListeners('data'); } catch (e) {}
    try { this.socket.removeAllListeners('error'); } catch (e) {}
    try { this.socket.removeAllListeners('close'); } catch (e) {}
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this.onLine(raw);
    }
  }

  onLine(line) {
    const m = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!m) {
      /* banner or continuation text without a code: ignore */
      if (this.current) this.current.lines.push(line);
      return;
    }
    const code = Number(m[1]);
    if (!this.current || this.current.code !== code) {
      this.current = { code, lines: [] };
    }
    this.current.lines.push(m[3]);
    if (m[2] === ' ') {
      const res = { code, lines: this.current.lines.slice(), text: this.current.lines.join('\n') };
      this.current = null;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(res);
      else this.responses.push(res);
    }
  }

  fail(err) {
    const waiters = this.waiters.splice(0);
    waiters.forEach((w) => w.reject(err));
  }

  read(timeout) {
    if (this.responses.length) return Promise.resolve(this.responses.shift());
    if (this.closed) return Promise.reject(new Error('smtp_connection_closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('smtp_timeout'));
      }, timeout || this.opts.timeout || DEFAULT_TIMEOUT);
      if (timer.unref) timer.unref();
      const waiter = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      };
      this.waiters.push(waiter);
    });
  }

  write(line) {
    if (this.closed) throw new Error('smtp_connection_closed');
    this.socket.write(line + CRLF);
  }

  async command(line, expect, timeout) {
    this.write(line);
    const res = await this.read(timeout);
    if (expect && expect.indexOf(res.code) < 0) {
      const err = new Error('smtp_' + res.code + ': ' + res.text.slice(0, 240));
      err.code = res.code;
      err.reply = res;
      throw err;
    }
    return res;
  }

  async upgradeToTls(host) {
    this.detach();
    const secure = await new Promise((resolve, reject) => {
      const sock = tls.connect({
        socket: this.socket,
        servername: host,
        rejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || 'true') !== 'false'
      }, () => resolve(sock));
      sock.once('error', reject);
    });
    this.closed = false;
    this.attach(secure);
  }

  async close() {
    try { if (!this.closed) { this.write('QUIT'); await this.read(2000).catch(() => null); } } catch (e) {}
    try { this.socket.end(); } catch (e) {}
  }
}

function connectRaw(opts) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, sock) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(sock);
    };
    const socket = opts.secure
      ? tls.connect({
        host: opts.host,
        port: opts.port,
        servername: opts.host,
        rejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || 'true') !== 'false'
      }, () => done(null, socket))
      : net.connect({ host: opts.host, port: opts.port }, () => done(null, socket));
    socket.setTimeout(opts.timeout || DEFAULT_TIMEOUT, () => {
      try { socket.destroy(); } catch (e) {}
      done(new Error('smtp_connect_timeout'));
    });
    socket.once('error', (err) => done(err));
  });
}

function base64(value) { return Buffer.from(String(value), 'utf8').toString('base64'); }

function messageId(domain) {
  return '<' + Date.now().toString(36) + '.' + crypto.randomBytes(8).toString('hex') + '@' + (domain || 'whalechat.local') + '>';
}

function buildMessage({ from, fromName, to, toName, subject, text, html, replyTo }) {
  const domain = String(from || '').split('@')[1] || 'whalechat.local';
  const headers = [
    'Date: ' + new Date().toUTCString(),
    'From: ' + mailbox(from, fromName || 'WhaleChat'),
    'To: ' + mailbox(to, toName || ''),
    'Subject: ' + encodeHeader(subject || 'WhaleChat'),
    'Message-ID: ' + messageId(domain),
    'MIME-Version: 1.0'
  ];
  if (replyTo) headers.push('Reply-To: ' + mailbox(replyTo));
  headers.push('X-Mailer: WhaleChat SMTP');

  let body;
  if (html) {
    const boundary = 'wc_' + crypto.randomBytes(12).toString('hex');
    headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    const plain = text || String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    body = [
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64(plain).replace(/(.{76})/g, '$1\r\n'),
      '--' + boundary,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64(html).replace(/(.{76})/g, '$1\r\n'),
      '--' + boundary + '--'
    ].join(CRLF);
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    body = base64(text || '').replace(/(.{76})/g, '$1\r\n');
  }
  const raw = headers.join(CRLF) + CRLF + CRLF + body;
  /* RFC 5321 dot-stuffing + guaranteed CRLF before the terminator */
  return raw.replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
}

/**
 * Send one message.
 * @param {object} cfg { host, port, secure, user, pass, timeout }
 * @param {object} mail { from, fromName, to, toName, subject, text, html, replyTo }
 */
async function sendMail(cfg, mail) {
  cfg = cfg || {};
  const host = String(cfg.host || process.env.SMTP_HOST || 'smtp-relay.brevo.com').trim();
  const port = Number(cfg.port || process.env.SMTP_PORT || 587);
  const secure = cfg.secure != null ? !!cfg.secure : (port === 465 || String(process.env.SMTP_SECURE || '').toLowerCase() === 'true');
  const user = String(cfg.user || process.env.SMTP_USER || '').trim();
  const pass = String(cfg.pass || process.env.SMTP_PASS || '').trim();
  const timeout = Number(cfg.timeout || DEFAULT_TIMEOUT);

  if (!host) throw new Error('smtp_host_required');
  if (!mail || !mail.to) throw new Error('smtp_recipient_required');
  if (!mail.from) throw new Error('smtp_sender_required');

  const socket = await connectRaw({ host, port, secure, timeout });
  const conn = new SmtpConnection(socket, { timeout });
  try {
    const greet = await conn.read(timeout);
    if (greet.code !== 220) throw new Error('smtp_greeting_' + greet.code);

    const hostname = os.hostname() || 'whalechat.local';
    let ehlo = await conn.command('EHLO ' + hostname, [250]);
    let caps = ehlo.text.toUpperCase();

    if (!secure && /\bSTARTTLS\b/.test(caps)) {
      await conn.command('STARTTLS', [220]);
      await conn.upgradeToTls(host);
      ehlo = await conn.command('EHLO ' + hostname, [250]);
      caps = ehlo.text.toUpperCase();
    }

    if (user && pass) {
      let authed = false;
      if (/\bAUTH\b[^\n]*\bPLAIN\b/.test(caps) || /\bAUTH\s+PLAIN\b/.test(caps) || /\bAUTH\b/.test(caps)) {
        try {
          await conn.command('AUTH PLAIN ' + base64('\0' + user + '\0' + pass), [235]);
          authed = true;
        } catch (e) {
          if (e.code !== 504 && e.code !== 535 && e.code !== 500) throw e;
        }
      }
      if (!authed) {
        await conn.command('AUTH LOGIN', [334]);
        await conn.command(base64(user), [334]);
        await conn.command(base64(pass), [235]);
      }
    }

    await conn.command('MAIL FROM:<' + cleanHeader(mail.from).replace(/[<>]/g, '') + '>', [250, 251]);
    await conn.command('RCPT TO:<' + cleanHeader(mail.to).replace(/[<>]/g, '') + '>', [250, 251]);
    await conn.command('DATA', [354]);
    const raw = buildMessage(mail);
    conn.write(raw);
    conn.write('.');
    const accepted = await conn.read(60000);
    if (accepted.code !== 250) {
      const err = new Error('smtp_rejected_' + accepted.code + ': ' + accepted.text.slice(0, 240));
      err.code = accepted.code;
      throw err;
    }
    await conn.close();
    return {
      ok: true,
      provider: 'smtp',
      host,
      port,
      accepted: true,
      messageId: (raw.match(/^Message-ID: (.+)$/m) || [])[1] || ''
    };
  } catch (err) {
    try { conn.socket.destroy(); } catch (e) {}
    throw err;
  }
}

module.exports = { sendMail, buildMessage, mailbox, encodeHeader };
