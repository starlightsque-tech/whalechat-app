'use strict';
/* =========================================================================
   WhaleChat · hosted realtime provider (3.71)
   -------------------------------------------------------------------------
   One small adapter so the chat lane can deliver a message over a hosted
   WebSocket (Pusher Channels or Ably) instead of a poll.

   The server never imports an SDK: both providers are reached over their
   documented REST APIs with node's global fetch, and the browser talks the
   provider protocol directly (see public/wc-live-chat.js). That keeps the
   Appwrite Function bundle small (no node_modules) and keeps every secret on
   the server.

   Configuration (all optional — with none set the lane simply uses SSE on the
   app's own Node server, or the existing poll):
     PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER (default mt1)
     ABLY_API_KEY  ("keyName:keySecret")
     WC_PUSHER_HOST / WC_ABLY_HOST for a self-hosted/regional endpoint

   Channels
     wc-user-<userId>   every message addressed to that user (+ copies for
                        the sender's other devices)
     wc-room-<chatId>   typing / read / presence for one conversation
     wc-admin          the admin desk: SMS sends, delivery reports, app replies

   Published frame (one event name, `wc`, for both providers):
     { kind: 'message'|'typing'|'read'|'presence'|'sms', at, ...payload }
   ========================================================================= */

const crypto = require('crypto');

const PREFIX = String(process.env.WC_CHANNEL_PREFIX || 'wc').replace(/[^a-zA-Z0-9_-]/g, '') || 'wc';
const EVENTS = 'wc';
const MAX_LEN = 12000;

function clean(value, max) {
  return String(value == null ? '' : value).slice(0, max || 200);
}

function pusherConfig() {
  const appId = clean(process.env.PUSHER_APP_ID, 40).trim();
  const key = clean(process.env.PUSHER_KEY, 80).trim();
  const secret = String(process.env.PUSHER_SECRET || '').trim();
  if (!appId || !key || !secret) return null;
  const cluster = clean(process.env.PUSHER_CLUSTER || 'mt1', 20).trim();
  return {
    provider: 'pusher',
    appId, key, secret, cluster,
    host: clean(process.env.WC_PUSHER_HOST || ('api-' + cluster + '.pusher.com'), 120),
    wsHost: clean(process.env.WC_PUSHER_WS_HOST || ('ws-' + cluster + '.pusher.com'), 120),
    secure: true
  };
}

function ablyConfig() {
  const raw = String(process.env.ABLY_API_KEY || '').trim();
  const i = raw.indexOf(':');
  if (i < 4) return null;
  const keyName = raw.slice(0, i);
  const secret = raw.slice(i + 1);
  if (!secret) return null;
  return {
    provider: 'ably',
    keyName, secret,
    /* Ably's public browser key is the key *name*; the secret never leaves the server */
    key: keyName,
    restHost: clean(process.env.WC_ABLY_HOST || 'main.realtime.ably.net', 120),
    realtimeHost: clean(process.env.WC_ABLY_REALTIME_HOST || 'main.realtime.ably.net', 120),
    secure: true
  };
}

function active() {
  return pusherConfig() || ablyConfig() || null;
}

/* Public shape for /api/realtime/config — no secret, ever. */
function publicConfig() {
  const cfg = active();
  if (!cfg) {
    return {
      ok: true,
      provider: 'sse',
      enabled: false,
      secure: false,
      channelPrefix: PREFIX,
      event: EVENTS,
      note: 'No hosted provider configured — the lane uses the app server SSE stream, then the poll.'
    };
  }
  if (cfg.provider === 'pusher') {
    return {
      ok: true,
      provider: 'pusher',
      enabled: true,
      secure: !!cfg.secure,
      key: cfg.key,
      cluster: cfg.cluster,
      wsHost: cfg.wsHost,
      channelPrefix: PREFIX,
      event: EVENTS,
      authEndpoint: '/api/realtime/auth'
    };
  }
  return {
    ok: true,
    provider: 'ably',
    enabled: true,
    secure: !!cfg.secure,
    key: cfg.key,
    realtimeHost: cfg.realtimeHost,
    channelPrefix: PREFIX,
    event: EVENTS,
    tokenEndpoint: '/api/realtime/token'
  };
}

function configured() {
  const cfg = active();
  return { provider: cfg ? cfg.provider : 'sse', enabled: !!cfg };
}

function userChannel(userId) {
  return PREFIX + '-user-' + clean(userId, 80).replace(/[^a-zA-Z0-9_@=.,;-]/g, '');
}
function roomChannel(chatId) {
  return PREFIX + '-room-' + clean(chatId, 140).replace(/[^a-zA-Z0-9_@=.,;-]/g, '');
}
function adminChannel() {
  return PREFIX + '-admin';
}

function md5hex(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function qs(params) {
  return Object.keys(params).sort().map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
}

async function postJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 4500);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text.slice(0, 300), body: text };
  } finally { clearTimeout(timer); }
}

/* One publish. `data` is a small JSON object. Never throws: a provider outage
   must not stop a message from being stored and served by the poll. */
async function publish(channels, data) {
  const cfg = active();
  const list = (Array.isArray(channels) ? channels : [channels]).filter(Boolean);
  if (!cfg || !list.length) return { ok: false, skipped: true };
  let payload = data && typeof data === 'object' ? data : { kind: 'message', value: data };
  try {
    let frame = JSON.stringify(payload);
    if (frame.length > MAX_LEN) frame = JSON.stringify({ kind: payload.kind, truncated: true, chatId: payload.chatId, id: payload.id });
    if (cfg.provider === 'pusher') {
      const body = JSON.stringify({ name: EVENTS, channels: list, data: frame });
      const auth = { auth_key: cfg.key, auth_timestamp: Math.floor(Date.now() / 1000), auth_version: '1.0', body_md5: md5hex(body) };
      const authQs = qs(auth);
      const toSign = 'POST\n/apps/' + cfg.appId + '/events\n' + authQs;
      const sig = crypto.createHmac('sha256', cfg.secret).update(toSign).digest('hex');
      const url = 'https://' + cfg.host + '/apps/' + cfg.appId + '/events?' + authQs + '&auth_signature=' + sig;
      const out = await postJson(url, {}, body);
      if (!out.ok && global.console) console.log('[realtime] pusher publish ' + out.status + ' ' + out.text);
      return out;
    }
    /* Ably: batch publish as an identified server client. An app configured
       with "require identified clients" refuses a raw key publish (40161), so
       the server mints a short-lived publish token and sends it as Bearer. */
    /* Ably batch-publish shape: channels at the top, message objects inside */
    const body = JSON.stringify({ channels: list, messages: [{ name: EVENTS, data: frame }] });
    const token = await ablyServerToken();
    if (!token) return { ok: false, error: 'ably_token_failed' };
    const out = await postJson('https://' + cfg.restHost + '/messages',
      { authorization: 'Bearer ' + Buffer.from(token).toString('base64') }, body);
    if (!out.ok && global.console) console.log('[realtime] ably publish ' + out.status + ' ' + out.text);
    return out;
  } catch (e) {
    if (global.console) console.log('[realtime] publish failed: ' + e.message);
    return { ok: false, error: e.message };
  }
}

/* Pusher private-channel auth: signature over "<socket_id>:<channel>". */
function pusherAuth(socketId, channel) {
  const cfg = pusherConfig();
  if (!cfg) return null;
  const sig = crypto.createHmac('sha256', cfg.secret).update(String(socketId) + ':' + String(channel)).digest('hex');
  return { auth: cfg.key + ':' + sig };
}

/* Ably capability strings are canonical: sorted channels, sorted operations,
   no whitespace. The mac is the HMAC of every field (newline after each,
   including the last) as the TokenRequest spec requires. */
function canonicalCapability(capability) {
  const out = {};
  Object.keys(capability || {}).sort().forEach(function (channel) {
    out[channel] = (capability[channel] || []).slice().sort();
  });
  return JSON.stringify(out);
}

function signAblyTokenRequest(cfg, channels, clientId, operations, ttlMs) {
  const list = (Array.isArray(channels) && channels.length) ? channels : ['*'];
  const capability = {};
  list.forEach(function (c) { capability[c] = (operations || ['subscribe']).slice(); });
  const capabilityText = canonicalCapability(capability);
  const ttl = Math.max(60000, Number(ttlMs) || 3600000);
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = [cfg.keyName, ttl, capabilityText, clientId || '', timestamp, nonce].join('\n') + '\n';
  const mac = crypto.createHmac('sha256', cfg.secret).update(canonical).digest('base64');
  return {
    keyName: cfg.keyName,
    ttl: ttl,
    capability: capabilityText,
    clientId: clientId || '',
    timestamp: timestamp,
    nonce: nonce,
    mac: mac
  };
}

/* A signed TokenRequest (no network). Clients normally receive a real token
   from /api/realtime/token instead, but this is useful for diagnostics. */
function ablyTokenRequest(opts) {
  const cfg = ablyConfig();
  if (!cfg) return null;
  const channels = (Array.isArray(opts && opts.channels) ? opts.channels : [])
    .filter(function (c) { return typeof c === 'string' && c.length; })
    .slice(0, 12);
  return signAblyTokenRequest(cfg, channels, clean((opts && opts.clientId) || '', 80), ['subscribe'], 3600000);
}

/* Exchange a signed TokenRequest for an Ably Token (Basic auth, server only).
   The browser receives just the short-lived token, never the key secret. */
async function ablyToken(opts) {
  const cfg = ablyConfig();
  if (!cfg) return null;
  const channels = (Array.isArray(opts && opts.channels) ? opts.channels : [])
    .filter(function (c) { return typeof c === 'string' && c.length; })
    .slice(0, 12);
  const clientId = clean((opts && opts.clientId) || ('wc_' + crypto.randomBytes(4).toString('hex')), 80);
  const request = signAblyTokenRequest(cfg, channels, clientId, (opts && opts.operations) || ['subscribe'], (opts && opts.ttlMs) || 3600000);
  const basic = Buffer.from(cfg.keyName + ':' + cfg.secret).toString('base64');
  const res = await postJson('https://' + cfg.restHost + '/keys/' + encodeURIComponent(cfg.keyName) + '/requestToken',
    { authorization: 'Basic ' + basic }, request, 6000);
  if (!res.ok) {
    if (global.console) console.log('[realtime] ably token ' + res.status + ' ' + res.text);
    return null;
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) {}
  if (!json || !json.token) return null;
  return { token: json.token, keyName: json.keyName || cfg.keyName, expires: Number(json.expires) || (Date.now() + 3600000), capability: json.capability || request.capability, clientId: json.clientId || clientId };
}

/* One cached publish identity for the server (wildcard capability). */
let ABLY_SERVER_TOKEN = { token: '', expires: 0 };
async function ablyServerToken() {
  if (ABLY_SERVER_TOKEN.token && Date.now() < ABLY_SERVER_TOKEN.expires - 60000) return ABLY_SERVER_TOKEN.token;
  const t = await ablyToken({ channels: ['*'], clientId: 'wc-server', operations: ['publish', 'subscribe'], ttlMs: 3600000 });
  if (!t) return '';
  ABLY_SERVER_TOKEN = { token: t.token, expires: t.expires };
  return t.token;
}

/* Convenience: publish one chat message to the people it concerns. */
function publishMessage(message) {
  if (!message || !message.id) return Promise.resolve({ ok: false });
  const channels = [];
  if (message.to) channels.push(userChannel(message.to));
  if (message.from) channels.push(userChannel(message.from));
  if (message.chatId) channels.push(roomChannel(message.chatId));
  return publish(Array.from(new Set(channels)), {
    kind: 'message',
    id: message.id,
    chatId: message.chatId,
    from: message.from,
    to: message.to,
    seq: message.seq,
    status: message.status,
    at: Date.now(),
    /* the body rides along so the peer paints without a second round trip */
    message: {
      id: message.id, chatId: message.chatId, from: message.from, to: message.to,
      type: message.type, text: message.text, mediaId: message.mediaId, dur: message.dur,
      createdAt: message.createdAt, status: message.status, forwarded: !!message.forwarded,
      deleted: !!message.deleted, readBy: Array.isArray(message.readBy) ? message.readBy : []
    }
  });
}

function publishEvent(kind, payload) {
  const p = Object.assign({ kind: kind, at: Date.now() }, payload || {});
  const channels = [];
  if (payload && payload.chatId) channels.push(roomChannel(payload.chatId));
  if (payload && payload.to) channels.push(userChannel(payload.to));
  if (payload && payload.from) channels.push(userChannel(payload.from));
  if (payload && payload.admin) channels.push(adminChannel());
  return publish(Array.from(new Set(channels)), p);
}

module.exports = {
  configured,
  publicConfig,
  active,
  publish,
  publishMessage,
  publishEvent,
  pusherAuth,
  ablyTokenRequest,
  ablyToken,
  userChannel,
  roomChannel,
  adminChannel,
  EVENTS,
  PREFIX
};
