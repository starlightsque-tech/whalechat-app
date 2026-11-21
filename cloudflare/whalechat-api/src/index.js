/* =========================================================================
   WhaleChat Cloudflare sync server
   One Durable Object owns the database, presence, messages and session rooms.
   It fans every write out over a single SSE stream per device, so the client
   stays local-first and never polls.
   ========================================================================= */
const APP = 'whalechat';
const VERSION = '3.59.0';
const DO_NAME = 'global:v7';
const PREV_DO_NAME = 'global:v6';
const BUILD = '2026-11-22T00:30:00Z';
const COLLECTIONS = ['users', 'vendors', 'companyProducts', 'products', 'orders', 'deposits', 'withdrawals', 'messages', 'statuses', 'notifications', 'contacts', 'blocks', 'txs', 'referrals', 'purchases', 'refunds', 'vendorApplications', 'reports', 'bonuses', 'bonusClaims', 'emailCampaigns', 'stocks', 'holdings', 'trades', 'watchlist', 'alerts', 'audit', 'portfolioAudit', 'botAccounts', 'botEvents', 'traffic', 'shareInvestments', 'serviceRequests'];
const PRESENCE_STALE_MS = 35000;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '86400'
};
const json = (data, code = 200) => new Response(JSON.stringify(data), {
  status: code,
  headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS)
});
const frameOf = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (buf) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (str) => {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(s + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};
const concat = (...parts) => {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
async function hkdfExpand(prk, info, len) {
  const blocks = [];
  let t = new Uint8Array(0);
  for (let i = 1; i <= 255; i++) {
    t = await hmac(prk, concat(t, info, new Uint8Array([i])));
    blocks.push(t);
    if (blocks.reduce((a, b) => a + b.length, 0) >= len) break;
  }
  return concat(...blocks).slice(0, len);
}
function previewText(m) {
  if (!m) return 'New message';
  if (m.type === 'image') return '📷 Photo';
  if (m.type === 'video') return '🎥 Video';
  if (m.type === 'voice' || m.type === 'audio') return '🎤 Voice note';
  return String(m.text || '').slice(0, 140) || 'New message';
}
/* ticker -> Yahoo Finance symbol (public, keyless) */
function yahooSymbol(asset) {
  if (!asset) return '';
  const ticker = String(asset.ticker || asset.displayTicker || '').toUpperCase();
  const display = String(asset.displayTicker || asset.finnhubSymbol || asset.ticker || '').toUpperCase();
  const cls = String(asset.assetClass || '').toLowerCase();
  if (cls === 'crypto' || /USDT$/.test(ticker)) {
    if (/USDT$/.test(ticker)) return ticker.slice(0, -4) + '-USD';
    if (/USD$/.test(ticker)) return ticker.slice(0, -3) + '-USD';
    return ticker;
  }
  if (cls === 'forex' || /^[A-Z]{6}$/.test(ticker) && /USD$/.test(ticker)) {
    if (ticker === 'XAUUSD') return 'GC=F';
    if (ticker === 'XAGUSD') return 'SI=F';
    return ticker + '=X';
  }
  const clean = display.replace(/^[A-Z]+:/, '');
  const m = /\.([A-Z]{1,3})$/.exec(clean);
  if (m && ['L', 'DE', 'T', 'TO', 'AX', 'PA', 'AS', 'MI', 'MC', 'SW', 'SI', 'HK', 'KS', 'TW', 'NS', 'BO', 'SA', 'F', 'V'].includes(m[1])) return clean;
  return clean.replace(/\./g, '-');
}


export class ChatHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.db = null;
    this.rev = 0;
    this.updatedAt = 0;
    this.clients = new Map();      // id -> { user, controller, at }
    this.marketClients = new Map();// id -> controller (separate quote stream)
    this.presence = new Map();     // userId -> { ts, lastSeen, currentChatWith, device, visible }
    this.quotes = {};
    this.marketAt = 0;
    this.marketRefreshing = null;
    this.vapid = null;
    this.loaded = false;
    this.saveTimer = null;
    this.ready = this.load();
  }
  async load() {
    try {
      let meta = await this.state.storage.get('state:meta');
      if ((!meta || !meta.chunks) && PREV_DO_NAME && PREV_DO_NAME !== DO_NAME) {
        /* one-time copy from the previous, still-running object after a
           versioned deploy — the new instance always runs the newest code */
        try {
          const prev = this.env.CHAT_HUB.get(this.env.CHAT_HUB.idFromName(PREV_DO_NAME));
          const res = await prev.fetch(new Request('https://do/api/state'));
          const st = await res.json();
          if (st && st.db) {
            this.db = st.db; this.rev = st.rev || 0; this.updatedAt = st.updatedAt || Date.now();
            await this.persistNow();
            meta = await this.state.storage.get('state:meta');
          }
        } catch (e) { console.error('[hub] previous state copy failed', e.message); }
      }
      if (meta && meta.chunks) {
        let s = '';
        for (let i = 0; i < meta.chunks; i++) s += (await this.state.storage.get('state:' + i)) || '';
        if (s) {
          const parsed = JSON.parse(s);
          this.db = parsed.db || null;
          this.rev = parsed.rev || 0;
          this.updatedAt = parsed.updatedAt || 0;
        }
      }
      const mkt = await this.state.storage.get('market:snapshot');
      if (mkt && mkt.quotes) { this.quotes = mkt.quotes; this.marketAt = mkt.at || 0; }
    } catch (e) { console.error('[hub] load failed', e.message); }
    this.loaded = true;
    try { await this.state.storage.setAlarm(Date.now() + 15000); } catch (e) {}
  }
  async alarm() {
    try {
      this.ping();
      this.sweepPresence();
      if (this.marketClients.size || (this.marketAt && Date.now() - this.marketAt > 60000)) {
        try { await this.refreshMarket(); } catch (e) {}
      }
    } finally {
      try { await this.state.storage.setAlarm(Date.now() + 20000); } catch (e) {}
    }
  }
  async persistNow() {
    if (!this.db) return;
    try {
      const s = JSON.stringify({ db: this.db, rev: this.rev, updatedAt: this.updatedAt });
      const size = 80000;
      const chunks = Math.ceil(s.length / size) || 1;
      const prev = await this.state.storage.get('state:meta');
      for (let i = 0; i < chunks; i++) await this.state.storage.put('state:' + i, s.slice(i * size, (i + 1) * size));
      await this.state.storage.put('state:meta', { chunks, rev: this.rev, updatedAt: this.updatedAt });
      if (prev && prev.chunks > chunks) {
        for (let i = chunks; i < prev.chunks; i++) await this.state.storage.delete('state:' + i);
      }
    } catch (e) { console.error('[hub] save failed', e.message); }
  }
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; try { this.state.waitUntil(this.persistNow()); } catch (e) { this.persistNow(); } }, 250);
  }
  ping() {
    for (const [id, c] of this.clients) {
      try { c.controller.enqueue(enc.encode(': ping\n\n')); }
      catch (e) { this.clients.delete(id); }
    }
    for (const [id, c] of this.marketClients) {
      try { c.enqueue(enc.encode(': ping\n\n')); }
      catch (e) { this.marketClients.delete(id); }
    }
  }
  online(userId) {
    for (const c of this.clients.values()) if (c.user === userId) return true;
    return false;
  }
  countSockets(userId) {
    let n = 0; for (const c of this.clients.values()) if (c.user === userId) n++;
    return n;
  }
  presenceView(userId) {
    const id = String(userId || '');
    const p = this.presence.get(id);
    const stored = (this.db && this.db.presence && this.db.presence[id]) || null;
    const online = !!(p && p.visible !== false && this.online(id));
    return {
      userId: id,
      online,
      lastSeen: online ? Date.now() : Math.max(Number(p && p.lastSeen) || 0, Number(stored && stored.lastSeen) || 0),
      currentChatWith: (p && p.currentChatWith) || (stored && stored.currentChatWith) || ''
    };
  }
  roomPeers(userId) {
    const out = new Set();
    ((this.db && this.db.sessionRooms) || []).forEach((r) => {
      if (!r || !Array.isArray(r.members) || !r.members.includes(userId)) return;
      r.members.forEach((id) => { if (id !== userId) out.add(String(id)); });
    });
    return [...out];
  }
  presenceAudience(userId) {
    const ids = new Set([String(userId)]);
    const db = this.db || {};
    (db.messages || []).forEach((m) => {
      if (!m) return;
      if (m.from === userId && m.to) ids.add(String(m.to));
      else if (m.to === userId && m.from) ids.add(String(m.from));
    });
    (db.contacts || []).forEach((c) => {
      if (!c) return;
      if (c.ownerId === userId && c.userId) ids.add(String(c.userId));
      else if (c.userId === userId && c.ownerId) ids.add(String(c.ownerId));
    });
    this.roomPeers(userId).forEach((id) => ids.add(id));
    return [...ids];
  }
  broadcastAll(event, data) {
    const frame = enc.encode(frameOf(event, data));
    for (const [id, c] of this.clients) {
      try { c.controller.enqueue(frame); } catch (e) { this.clients.delete(id); }
    }
    return this.clients.size;
  }
  broadcastTo(userIds, event, data) {
    const want = new Set((userIds || []).filter(Boolean));
    if (!want.size) return 0;
    const frame = enc.encode(frameOf(event, data));
    let n = 0;
    for (const [id, c] of this.clients) {
      if (!want.has(c.user)) continue;
      try { c.controller.enqueue(frame); n++; } catch (e) { this.clients.delete(id); }
    }
    return n;
  }
  touchPresence(userId, patch) {
    const id = String(userId || ''); if (!id) return null;
    const prev = this.presence.get(id) || { ts: 0, lastSeen: 0, currentChatWith: '', device: '', visible: true };
    const next = Object.assign({}, prev, patch || {}, { ts: Date.now() });
    this.presence.set(id, next);
    return this.broadcastPresence(id);
  }
  broadcastPresence(userId) {
    const view = this.presenceView(userId);
    this.broadcastTo(this.presenceAudience(userId), 'presence', { presence: view, at: Date.now() });
    if (!this.db) return view;
    if (!this.db.presence) this.db.presence = {};
    this.db.presence[userId] = { lastSeen: view.lastSeen, currentChatWith: view.currentChatWith };
    this.scheduleSave();
    return view;
  }
  markOffline(userId) {
    const id = String(userId || ''); if (!id) return;
    const p = this.presence.get(id) || { ts: 0, lastSeen: 0 };
    p.ts = 0; p.visible = false; p.lastSeen = Date.now(); p.currentChatWith = '';
    this.presence.set(id, p);
    this.broadcastPresence(id);
  }
  sweepPresence() {
    const now = Date.now();
    this.presence.forEach((p, id) => {
      if (!p) return;
      if (now - Number(p.ts) >= PRESENCE_STALE_MS && (p.visible !== false || this.online(id))) {
        p.visible = false; p.lastSeen = now; p.currentChatWith = '';
        this.presence.set(id, p);
        this.broadcastPresence(id);
      }
    });
  }
  markDelivered(userId) {
    if (!this.db || !Array.isArray(this.db.messages)) return 0;
    const changed = [];
    this.db.messages.forEach((m) => {
      if (!m || m.to !== userId || m.status === 'seen' || m.status === 'delivered') return;
      m.status = 'delivered'; m.deliveredAt = m.deliveredAt || Date.now(); changed.push(m);
    });
    if (!changed.length) return 0;
    this.rev += 1; this.updatedAt = Date.now(); this.scheduleSave();
    changed.forEach((m) => this.broadcastTo([m.from], 'delivered', { chatId: m.chatId, userId, ids: [m.id], at: Date.now(), rev: this.rev }));
    return changed.length;
  }
  applyOps(ops) {
    const pushes = [];
    for (const op of ops || []) {
      if (!op || typeof op !== 'object') continue;
      if (op.op === 'set') { if (typeof op.key === 'string' && !op.key.startsWith('__')) this.db[op.key] = op.value; continue; }
      if (!COLLECTIONS.includes(op.col)) continue;
      if (!Array.isArray(this.db[op.col])) this.db[op.col] = [];
      const arr = this.db[op.col];
      if (op.op === 'push' && op.item && op.item.id) {
        const i = arr.findIndex((x) => x && x.id === op.item.id);
        if (i >= 0) arr[i] = op.item; else arr.push(op.item);
        pushes.push({ col: op.col, item: op.item, isNew: i < 0 });
      } else if (op.op === 'update' && op.id) {
        const i = arr.findIndex((x) => x && x.id === op.id);
        if (i >= 0) arr[i] = Object.assign({}, arr[i], op.patch || {});
        else if (op.patch && op.patch.id) arr.push(op.patch);
        if (i >= 0) pushes.push({ col: op.col, item: arr[i], isNew: false });
      } else if (op.op === 'remove' && op.id) {
        const i = arr.findIndex((x) => x && x.id === op.id); if (i >= 0) arr.splice(i, 1);
      }
    }
    return { pushes };
  }
  roomByCode(code) {
    const c = String(code || '').trim().toUpperCase();
    return ((this.db && this.db.sessionRooms) || []).find((r) => r && r.code === c) || null;
  }
  rooms() {
    if (!this.db) return [];
    if (!Array.isArray(this.db.sessionRooms)) this.db.sessionRooms = [];
    return this.db.sessionRooms;
  }
  code() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let k = 0; k < 40; k++) {
      let c = '';
      for (let i = 0; i < 6; i++) c += alphabet[Math.floor(Math.random() * alphabet.length)];
      if (!this.roomByCode(c)) return c;
    }
    return 'R' + Date.now().toString(36).toUpperCase().slice(-6);
  }
  roomView(r) {
    return { code: r.code, name: r.name || 'Internet session', ownerId: r.ownerId, members: (r.members || []).slice(), createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
  roomBroadcast(room, event, data, except) {
    this.broadcastTo((room.members || []).filter((id) => id !== except), event, data);
  }

  /* ------------------------------------------------------------------ *
   *  Web Push (VAPID + RFC 8291 aes128gcm)                              *
   * ------------------------------------------------------------------ */
  async ensureVapid() {
    if (this.vapid) return this.vapid;
    /* The key lives in the synced database so a versioned deploy (which starts
       a fresh Durable Object) keeps the same VAPID identity — otherwise every
       existing push subscription would become invalid. */
    if (this.db && this.db.pushVapid && this.db.pushVapid.jwk && this.db.pushVapid.pub) {
      this.vapid = this.db.pushVapid;
      return this.vapid;
    }
    let saved = null;
    try { saved = await this.state.storage.get('push:vapid'); } catch (e) {}
    if (!saved || !saved.jwk || !saved.pub) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      saved = { jwk, pub: b64u(raw), at: Date.now() };
    }
    try { await this.state.storage.put('push:vapid', saved); } catch (e) {}
    if (this.db) { this.db.pushVapid = saved; this.scheduleSave(); }
    this.vapid = saved;
    return saved;
  }
  async vapidAuthorization(endpoint) {
    const v = await this.ensureVapid();
    const aud = new URL(endpoint).origin;
    const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const payload = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:support@whalechat.app' })));
    const data = header + '.' + payload;
    const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(data));
    return 'vapid t=' + data + '.' + b64u(new Uint8Array(sig)) + ', k=' + v.pub;
  }
  async encryptPush(subscription, payload) {
    const uaPub = unb64u(subscription.keys.p256dh);
    const auth = unb64u(subscription.keys.auth);
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
    const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
    const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPub, ephPub);
    const ikm = await hkdfExpand(await hmac(auth, shared), keyInfo, 32);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const prk = await hmac(salt, ikm);
    const cek = await hkdfExpand(prk, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
    const nonce = await hkdfExpand(prk, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, concat(enc.encode(JSON.stringify(payload)), new Uint8Array([2]))));
    const rs = new Uint8Array(4);
    new DataView(rs.buffer).setUint32(0, 4096);
    return concat(salt, rs, new Uint8Array([65]), ephPub, ct);
  }
  async sendPushTo(subscription, payload) {
    try {
      if (!subscription || !subscription.endpoint || !subscription.keys) return false;
      const body = await this.encryptPush(subscription, payload);
      const auth = await this.vapidAuthorization(subscription.endpoint);
      const res = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          'TTL': String(payload.ttl || 86400),
          'Urgency': payload.urgency || 'high',
          'Authorization': auth
        },
        body
      });
      if (res.status === 404 || res.status === 410) return 'gone';
      return res.ok ? true : 'retry';
    } catch (e) {
      return 'retry';
    }
  }
  async pushMessage(msg) {
    if (!msg || !msg.to || msg.to === msg.from) return 0;
    const subs = (this.db && Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : []).filter((s) => s && s.userId === msg.to);
    if (!subs.length) return 0;
    const sender = (this.db.users || []).find((u) => u && u.id === msg.from) || {};
    const payload = {
      title: sender.fullName || sender.username || 'WhaleChat',
      body: previewText(msg),
      link: '#/chat/' + msg.from,
      tag: 'wc-msg-' + (msg.chatId || msg.from),
      icon: './assets/logo-192.png',
      badge: './assets/badge-72.png',
      requireInteraction: true,
      renotify: true,
      ts: Date.now()
    };
    let sent = 0;
    const gone = [];
    for (const sub of subs) {
      const r = await this.sendPushTo(sub, payload);
      if (r === true) sent++;
      else if (r === 'gone') gone.push(sub.endpoint);
    }
    if (gone.length) {
      this.db.pushSubscriptions = this.db.pushSubscriptions.filter((s) => !gone.includes(s.endpoint));
      this.scheduleSave();
    }
    return sent;
  }
  async pushRoomMessage(room, msg) {
    if (!room || !msg) return 0;
    const subs = (this.db && Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : []).filter((s) => s && s.userId && s.userId !== msg.from && (room.members || []).includes(s.userId));
    const sender = (this.db.users || []).find((u) => u && u.id === msg.from) || {};
    const payload = {
      title: sender.fullName || sender.username || 'WhaleChat',
      body: previewText(msg),
      link: '#/session/' + room.code,
      tag: 'wc-room-' + room.code,
      icon: './assets/logo-192.png',
      badge: './assets/badge-72.png',
      requireInteraction: true,
      renotify: true,
      ts: Date.now()
    };
    let sent = 0;
    for (const sub of subs) { if (await this.sendPushTo(sub, payload) === true) sent++; }
    return sent;
  }

  /* ------------------------------------------------------------------ *
   *  Market quotes (public Yahoo Finance spark + Binance fallback)      *
   * ------------------------------------------------------------------ */
  marketStatus() {
    const quotes = this.quotes || {};
    const priced = Object.keys(quotes).filter((t) => quotes[t] && quotes[t].price > 0).length;
    return {
      mode: 'live', source: 'yahoo', refreshSec: 30, tickers: priced,
      unpriced: Math.max(0, ((this.db && this.db.stocks) || []).length - priced),
      lastRealAt: this.marketAt, lastTickAt: this.marketAt, marketOpen: true, alwaysOpen: true,
      notice: 'Live quotes · Yahoo Finance public feed (stocks, ETFs, FX, crypto)'
    };
  }
  marketSnapshot() {
    const st = this.marketStatus();
    return { ok: true, at: Date.now(), source: 'live', marketOpen: true, alwaysOpen: true, notice: st.notice, status: st, quotes: this.quotes || {} };
  }
  async fetchSpark(symbols, interval) {
    if (!symbols.length) return {};
    const url = 'https://query1.finance.yahoo.com/v8/finance/spark?symbols=' + encodeURIComponent(symbols.join(',')) + '&interval=' + interval + '&range=1d';
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; WhaleChat/3.58.2)', accept: 'application/json' } });
    if (!res.ok) throw new Error('yahoo ' + res.status);
    return await res.json();
  }
  async refreshMarket() {
    if (this.marketRefreshing) return this.marketRefreshing;
    this.marketRefreshing = (async () => {
      try {
        const assets = (this.db && Array.isArray(this.db.stocks) ? this.db.stocks : []).filter((a) => a && a.ticker);
        if (!assets.length) return this.marketSnapshot();
        const map = new Map();
        assets.forEach((a) => { const y = yahooSymbol(a); if (y) map.set(y, a.ticker); });
        const symbols = [...map.keys()];
        const now = Date.now();
        const next = {};
        for (let i = 0; i < symbols.length; i += 20) {
          const chunk = symbols.slice(i, i + 20);
          let data = {};
          try { data = await this.fetchSpark(chunk, '1d'); } catch (e) { continue; }
          Object.keys(data || {}).forEach((sym) => {
            const row = data[sym];
            if (!row) return;
            const closes = Array.isArray(row.close) ? row.close.filter((n) => Number(n) > 0) : [];
            const price = Number(row.fulldayPrice || closes[closes.length - 1] || 0);
            if (!(price > 0)) return;
            const ticker = map.get(sym) || sym;
            const prevClose = Number(row.chartPreviousClose || row.previousClose || price);
            const prev = this.quotes[ticker] || {};
            next[ticker] = {
              ticker,
              price: Math.round(price * 10000) / 10000,
              prevClose: Math.round(prevClose * 10000) / 10000,
              open: Math.round(prevClose * 10000) / 10000,
              dayHigh: Math.max(Number(prev.dayHigh) || price, price),
              dayLow: Math.min(Number(prev.dayLow) || price, price),
              vol: 0,
              dir: price > (Number(prev.price) || price) ? 1 : price < (Number(prev.price) || price) ? -1 : 0,
              updatedAt: now,
              source: 'yahoo',
              real: true
            };
            const q = next[ticker];
            q.changeUsd = Math.round((q.price - q.prevClose) * 10000) / 10000;
            q.changePct = q.prevClose ? Math.round((q.changeUsd / q.prevClose) * 10000) / 100 : 0;
          });
        }
        if (Object.keys(next).length) {
          this.quotes = next;
          this.marketAt = now;
          try { this.state.waitUntil(this.state.storage.put('market:snapshot', { at: now, quotes: next })); } catch (e) {}
          const frame = enc.encode(frameOf('snapshot', this.marketSnapshot()));
          for (const [id, c] of this.marketClients) {
            try { c.enqueue(frame); } catch (e) { this.marketClients.delete(id); }
          }
        }
      } catch (e) {
        console.error('[market] refresh failed', e.message);
      } finally {
        this.marketRefreshing = null;
      }
      return this.marketSnapshot();
    })();
    return this.marketRefreshing;
  }
  async historyFor(tickers, limit) {
    const assets = (this.db && Array.isArray(this.db.stocks) ? this.db.stocks : []);
    const map = new Map();
    tickers.forEach((t) => {
      const a = assets.find((x) => x && (x.ticker === t || x.displayTicker === t)) || { ticker: t };
      const y = yahooSymbol(a);
      if (y) map.set(y, t);
    });
    const out = {};
    const symbols = [...map.keys()];
    for (let i = 0; i < symbols.length; i += 20) {
      const chunk = symbols.slice(i, i + 20);
      let data = {};
      try { data = await this.fetchSpark(chunk, '1m'); } catch (e) { continue; }
      Object.keys(data || {}).forEach((sym) => {
        const row = data[sym];
        const ticker = map.get(sym);
        if (!row || !ticker) return;
        const ts = Array.isArray(row.timestamp) ? row.timestamp : [];
        const closes = Array.isArray(row.close) ? row.close : [];
        const points = [];
        for (let k = 0; k < ts.length; k++) {
          const p = Number(closes[k]);
          if (Number(ts[k]) > 0 && p > 0) points.push({ t: Number(ts[k]) * 1000, p });
        }
        out[ticker] = points.slice(-(Math.min(900, Number(limit) || 240)));
      });
    }
    return out;
  }

  async fetch(request) {
    await this.ready;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    const q = url.searchParams;
    const body = async () => { try { return await request.json(); } catch (e) { return {}; } };

    if (path === '/api/health') {
      return json({ ok: true, app: APP, version: VERSION, build: BUILD, uptimeSec: 0, rev: this.rev, users: (this.db && this.db.users) ? this.db.users.length : 0, clients: this.clients.size, push: false, publicUrl: null, storage: 'durable-object', email: false, market: { mode: 'offline', source: 'offline', marketOpen: true, alwaysOpen: true, tickers: 0 } });
    }
    if (path === '/api/release') return json({ ok: true, version: VERSION, build: BUILD, users: (this.db && this.db.users) ? this.db.users.length : 0 });
    if (path === '/api/state' && request.method === 'GET') return json({ rev: this.rev, db: this.db, updatedAt: this.updatedAt });
    if (path === '/api/state/init' && request.method === 'POST') {
      if (this.db) return json({ ok: false, error: 'already_initialised', rev: this.rev }, 409);
      const b = await body();
      if (!b || !b.db || !Array.isArray(b.db.users)) return json({ ok: false, error: 'invalid_db' }, 400);
      this.db = b.db; this.rev = Math.max(1, Number(b.rev) || 1); this.updatedAt = Date.now();
      this.scheduleSave();
      return json({ ok: true, rev: this.rev });
    }
    if (path === '/api/state/merge' && request.method === 'POST') {
      /* Union a device's local database into the hub. Used once when a user
         arrives from an older sync host so an account created locally is
         never replaced by a server that has never seen it. */
      if (!this.db) return json({ ok: false, error: 'not_initialised' }, 409);
      const b = await body();
      const local = b && b.db;
      if (!local || !Array.isArray(local.users)) return json({ ok: false, error: 'invalid_db' }, 400);
      const added = {};
      COLLECTIONS.forEach((col) => {
        if (!Array.isArray(local[col])) return;
        if (!Array.isArray(this.db[col])) this.db[col] = [];
        const have = new Set(this.db[col].map((x) => x && x.id).filter(Boolean));
        let n = 0;
        local[col].forEach((item) => {
          if (!item || !item.id || have.has(item.id)) return;
          this.db[col].push(item); have.add(item.id); n++;
        });
        if (n) added[col] = n;
      });
      ['settings', 'chatsMeta', 'presence'].forEach((key) => {
        if (!local[key] || typeof local[key] !== 'object' || Array.isArray(local[key])) return;
        if (!this.db[key] || typeof this.db[key] !== 'object') this.db[key] = {};
        Object.keys(local[key]).forEach((k) => { if (this.db[key][k] === undefined) this.db[key][k] = local[key][k]; });
      });
      this.rev += 1; this.updatedAt = Date.now(); await this.persistNow();
      return json({ ok: true, rev: this.rev, added, db: this.db });
    }
    if (path === '/api/ops' && request.method === 'POST') {
      if (!this.db) return json({ ok: false, error: 'not_initialised' }, 409);
      const b = await body();
      const result = this.applyOps(Array.isArray(b.ops) ? b.ops : []);
      this.rev += 1; this.updatedAt = Date.now(); this.scheduleSave();
      const onlyMessages = Array.isArray(b.ops) && b.ops.length > 0 && b.ops.every((o) => o && o.col === 'messages');
      this.broadcastAll('change', { rev: this.rev, source: b.clientId || null, at: this.updatedAt, messagesOnly: onlyMessages });
      if (onlyMessages) {
        result.pushes.forEach((p) => {
          const m = p.item;
          if (!m || !m.id || !m.chatId) return;
          this.broadcastTo([m.from, m.to].filter(Boolean), 'message', { message: m, rev: this.rev, at: Date.now() });
          if (p.isNew && m.to && m.from !== m.to) {
            try { this.state.waitUntil(this.pushMessage(m)); } catch (e) { this.pushMessage(m).catch(() => {}); }
          }
        });
      }
      return json({ ok: true, rev: this.rev });
    }
    if (path === '/api/events' && request.method === 'GET') {
      return this.events(request, String(q.get('user') || ''));
    }

    /* presence */
    if (path === '/api/presence' && request.method === 'POST') {
      const b = await body(); const userId = String(b.userId || '');
      if (!userId) return json({ ok: false, error: 'userId_required' }, 400);
      this.touchPresence(userId, { currentChatWith: b.currentChatWith == null ? undefined : String(b.currentChatWith || ''), device: b.device == null ? undefined : String(b.device || '').slice(0, 120), visible: b.visible === undefined ? undefined : !!b.visible });
      return json({ ok: true, presence: this.presenceView(userId), online: this.online(userId) });
    }
    if (path === '/api/presence/offline' && request.method === 'POST') {
      const b = await body(); if (b.userId) this.markOffline(String(b.userId));
      return json({ ok: true });
    }
    if (path === '/api/presence/state' && request.method === 'GET') {
      const ids = String(q.get('users') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200);
      const out = {}; ids.forEach((id) => { out[id] = this.presenceView(id); });
      return json({ ok: true, at: Date.now(), presence: out });
    }
    if (path === '/api/typing' && request.method === 'POST') {
      const b = await body();
      const userId = String(b.userId || ''); const to = String(b.to || ''); const chatId = String(b.chatId || '');
      if (!userId || !chatId) return json({ ok: false, error: 'invalid_typing' }, 400);
      const payload = { chatId, from: userId, to, isTyping: !!b.isTyping, at: Date.now() };
      this.broadcastTo([to, userId].filter(Boolean), 'typing', payload);
      return json({ ok: true, at: payload.at });
    }

    /* messages */
    if (path === '/api/messages/send' && request.method === 'POST') {
      if (!this.db) return json({ ok: false, error: 'not_initialised' }, 409);
      const b = await body(); const msg = b && b.message;
      if (!msg || !msg.id || !msg.chatId || !msg.from) return json({ ok: false, error: 'invalid_message' }, 400);
      if (!Array.isArray(this.db.messages)) this.db.messages = [];
      const existing = this.db.messages.find((m) => m && m.id === msg.id);
      if (existing) return json({ ok: true, duplicate: true, id: msg.id, rev: this.rev, status: existing.status || 'sent' });
      const sender = (this.db.users || []).find((u) => u.id === msg.from);
      if (!sender) return json({ ok: false, error: 'unknown_sender' }, 403);
      const clean = Object.assign({}, msg, { id: String(msg.id).slice(0, 120), chatId: String(msg.chatId).slice(0, 200), status: 'sent', serverAt: Date.now(), deleted: false, readBy: Array.isArray(msg.readBy) ? msg.readBy : [] });
      delete clean.tempId; delete clean.queuedAt; delete clean.attempts;
      this.db.messages.push(clean);
      if (clean.to && clean.from !== clean.to && this.online(clean.to)) { clean.status = 'delivered'; clean.deliveredAt = Date.now(); }
      this.rev += 1; this.updatedAt = Date.now(); this.scheduleSave();
      this.broadcastTo([clean.from, clean.to].filter(Boolean), 'message', { message: clean, rev: this.rev, at: Date.now() });
      if (clean.status === 'delivered') this.broadcastTo([clean.from], 'delivered', { chatId: clean.chatId, userId: clean.to, ids: [clean.id], at: Date.now(), rev: this.rev });
      try { this.state.waitUntil(this.pushMessage(clean)); } catch (e) { this.pushMessage(clean).catch(() => {}); }
      return json({ ok: true, id: clean.id, rev: this.rev, status: clean.status });
    }
    if (path === '/api/messages/list' && request.method === 'GET') {
      if (!this.db) return json({ ok: false, error: 'not_initialised' }, 409);
      const chatId = String(q.get('chatId') || ''); const userId = String(q.get('user') || '');
      const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 100));
      const since = Number(q.get('since')) || 0;
      let rows = (this.db.messages || []).filter((m) => m && (!chatId || m.chatId === chatId) && (Number(m.createdAt) || 0) > since);
      if (userId) rows = rows.filter((m) => m.from === userId || m.to === userId);
      rows = rows.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
      return json({ ok: true, at: Date.now(), rev: this.rev, messages: rows.slice(-limit) });
    }
    if (path === '/api/messages/ack' && request.method === 'POST') {
      if (!this.db) return json({ ok: false, error: 'not_initialised' }, 409);
      const b = await body();
      const chatId = String(b.chatId || ''); const userId = String(b.userId || '');
      const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
      const kind = b.kind === 'read' ? 'read' : 'delivered';
      if (!chatId || !userId) return json({ ok: false, error: 'invalid_ack' }, 400);
      const changed = [];
      (this.db.messages || []).forEach((m) => {
        if (!m || m.chatId !== chatId || !ids.includes(m.id)) return;
        if (kind === 'read') {
          m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
          if (!m.readBy.includes(userId)) m.readBy.push(userId);
          if (m.to === userId) m.status = 'seen';
          m.seenAt = m.seenAt || Date.now();
        } else if (m.status !== 'seen') { m.status = 'delivered'; m.deliveredAt = m.deliveredAt || Date.now(); }
        changed.push(m);
      });
      if (!changed.length) return json({ ok: true, changed: 0 });
      this.rev += 1; this.updatedAt = Date.now(); this.scheduleSave();
      const targets = new Set(); changed.forEach((m) => { if (m.from !== userId) targets.add(m.from); });
      this.broadcastTo([...targets], kind === 'read' ? 'read' : 'delivered', { chatId, userId, ids: changed.map((m) => m.id), at: Date.now(), rev: this.rev });
      return json({ ok: true, changed: changed.length, rev: this.rev });
    }

    /* session rooms */
    if (path === '/api/rooms/create' && request.method === 'POST') {
      if (!this.db) return json({ ok: false, error: 'not_initialised' }, 409);
      const b = await body(); const userId = String(b.userId || '');
      if (!userId) return json({ ok: false, error: 'userId_required' }, 400);
      const known = new Set((this.db.users || []).map((u) => u && u.id));
      if (!known.has(userId)) return json({ ok: false, error: 'unknown_user' }, 403);
      const members = new Set([userId]);
      (Array.isArray(b.members) ? b.members : []).forEach((id) => { if (id && known.has(String(id))) members.add(String(id)); });
      let room = b.code ? this.roomByCode(b.code) : null;
      if (room && !room.members.includes(userId)) return json({ ok: false, error: 'not_a_member' }, 403);
      if (room) members.forEach((id) => { if (!room.members.includes(id)) room.members.push(id); });
      else { room = { code: b.code ? String(b.code).toUpperCase() : this.code(), name: String(b.name || 'Internet session').slice(0, 60), ownerId: userId, members: [...members], messages: [], createdAt: Date.now(), updatedAt: Date.now() }; this.rooms().push(room); }
      room.updatedAt = Date.now(); this.rev += 1; this.updatedAt = Date.now(); this.scheduleSave();
      const view = this.roomView(room);
      room.members.forEach((id) => { this.broadcastTo([id], 'room-invite', { room: view, at: Date.now(), rev: this.rev }); this.broadcastPresence(id); });
      return json({ ok: true, room: view });
    }
    if (path === '/api/rooms/join' && request.method === 'POST') {
      const b = await body(); const userId = String(b.userId || ''); const room = this.roomByCode(b.code);
      if (!userId) return json({ ok: false, error: 'userId_required' }, 400);
      if (!room) return json({ ok: false, error: 'room_not_found' }, 404);
      if (!room.members.includes(userId)) {
        room.members.push(userId); room.updatedAt = Date.now(); this.rev += 1; this.updatedAt = Date.now(); this.scheduleSave();
        this.roomBroadcast(room, 'room-update', { room: this.roomView(room), at: Date.now() });
        this.broadcastTo([userId], 'room-invite', { room: this.roomView(room), at: Date.now(), rev: this.rev });
        room.members.forEach((id) => this.broadcastPresence(id));
      }
      return json({ ok: true, room: this.roomView(room), messages: (room.messages || []).slice(-200) });
    }
    if (path === '/api/rooms/list' && request.method === 'GET') {
      const userId = String(q.get('user') || '');
      const rooms = this.rooms().filter((r) => r && Array.isArray(r.members) && r.members.includes(userId))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 50)
        .map((r) => Object.assign(this.roomView(r), { last: (r.messages || [])[(r.messages || []).length - 1] || null }));
      return json({ ok: true, rooms });
    }
    if (path === '/api/rooms/get' && request.method === 'GET') {
      const userId = String(q.get('user') || ''); const room = this.roomByCode(q.get('code'));
      if (!room) return json({ ok: false, error: 'room_not_found' }, 404);
      if (!room.members.includes(userId)) return json({ ok: false, error: 'not_a_member' }, 403);
      const presence = {}; room.members.forEach((id) => { presence[id] = this.presenceView(id); });
      return json({ ok: true, room: this.roomView(room), messages: (room.messages || []).slice(-200), presence, at: Date.now() });
    }
    if (path === '/api/rooms/message' && request.method === 'POST') {
      const b = await body(); const userId = String(b.userId || ''); const room = this.roomByCode(b.code);
      if (!userId) return json({ ok: false, error: 'userId_required' }, 400);
      if (!room) return json({ ok: false, error: 'room_not_found' }, 404);
      if (!room.members.includes(userId)) return json({ ok: false, error: 'not_a_member' }, 403);
      if (!Array.isArray(room.messages)) room.messages = [];
      const msg = { id: String(b.id || '').slice(0, 120) || ('rm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)), from: userId, text: String(b.text || '').slice(0, 4000), createdAt: Number(b.createdAt) || Date.now(), status: 'sent', readBy: [], deliveredTo: [] };
      const existing = room.messages.find((m) => m && m.id === msg.id);
      if (!existing) {
        room.members.forEach((id) => { if (id !== userId && this.online(id)) msg.deliveredTo.push(id); });
        if (msg.deliveredTo.length) msg.status = 'delivered';
        room.messages.push(msg);
        if (room.messages.length > 2000) room.messages = room.messages.slice(-2000);
        room.updatedAt = Date.now(); this.rev += 1; this.updatedAt = Date.now(); this.scheduleSave();
        this.roomBroadcast(room, 'room-message', { code: room.code, message: msg, at: Date.now(), rev: this.rev });
        try { this.state.waitUntil(this.pushRoomMessage(room, msg)); } catch (e) { this.pushRoomMessage(room, msg).catch(() => {}); }
      }
      return json({ ok: true, id: msg.id, message: existing || msg, rev: this.rev });
    }
    if (path === '/api/rooms/read' && request.method === 'POST') {
      const b = await body(); const userId = String(b.userId || ''); const room = this.roomByCode(b.code);
      if (!room || !room.members.includes(userId)) return json({ ok: false, error: 'not_a_member' }, 403);
      const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
      const changed = [];
      (room.messages || []).forEach((m) => {
        if (!m || !ids.includes(m.id) || m.from === userId) return;
        if (!Array.isArray(m.readBy)) m.readBy = [];
        if (!m.readBy.includes(userId)) { m.readBy.push(userId); changed.push(m.id); }
      });
      if (changed.length) { this.rev += 1; this.updatedAt = Date.now(); this.scheduleSave(); this.roomBroadcast(room, 'room-read', { code: room.code, userId, ids: changed, at: Date.now(), rev: this.rev }); }
      return json({ ok: true, changed: changed.length });
    }
    if (path === '/api/rooms/typing' && request.method === 'POST') {
      const b = await body(); const userId = String(b.userId || ''); const room = this.roomByCode(b.code);
      if (!room || !room.members.includes(userId)) return json({ ok: false }, 200);
      this.roomBroadcast(room, 'room-typing', { code: room.code, from: userId, isTyping: !!b.isTyping, at: Date.now() }, userId);
      return json({ ok: true, at: Date.now() });
    }

    /* email verification: this server has no mail transport, so it confirms
       accounts immediately instead of trapping a new user on the code screen */
    if (path === '/api/verify/signup/send' && request.method === 'POST') {
      const b = await body();
      return json({ ok: true, to: b.email || '', delivered: false, autoVerified: true, message: 'Verification is not required on this server' });
    }
    if (path === '/api/verify/signup/confirm' && request.method === 'POST') {
      return json({ ok: true, verifiedAt: Date.now(), verificationMethod: 'auto' });
    }
    if (path === '/api/verify/send' && request.method === 'POST') return json({ ok: true, delivered: false, autoVerified: true });
    if (path === '/api/verify/check' && request.method === 'POST') return json({ ok: true, verified: true });
    if (path === '/api/email/status') return json({ ok: true, configured: false, provider: 'none' });
    if (path.startsWith('/api/email/')) return json({ ok: false, error: 'email_not_configured' }, 200);
    if (path === '/api/connections') return json({ ok: false, error: 'connections_disabled' }, 200);

    /* web push */
    if (path === '/api/push/key' && request.method === 'GET') {
      const v = await this.ensureVapid();
      return json({ ok: true, publicKey: v.pub });
    }
    if (path === '/api/push/subscribe' && request.method === 'POST') {
      if (!this.db) return json({ ok: false, error: 'not_initialised' }, 409);
      const b = await body();
      const userId = String(b.userId || '');
      const sub = b.subscription || {};
      if (!userId || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ ok: false, error: 'invalid_subscription' }, 400);
      if (!Array.isArray(this.db.pushSubscriptions)) this.db.pushSubscriptions = [];
      this.db.pushSubscriptions = this.db.pushSubscriptions.filter((s) => s && s.endpoint !== sub.endpoint);
      this.db.pushSubscriptions.push({ userId, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device: String(b.device || '').slice(0, 180), at: Date.now() });
      const own = this.db.pushSubscriptions.filter((s) => s.userId === userId);
      if (own.length > 10) {
        const drop = new Set(own.sort((a, c) => (a.at || 0) - (c.at || 0)).slice(0, own.length - 10).map((s) => s.endpoint));
        this.db.pushSubscriptions = this.db.pushSubscriptions.filter((s) => !drop.has(s.endpoint));
      }
      this.scheduleSave();
      return json({ ok: true, devices: this.db.pushSubscriptions.filter((s) => s.userId === userId).length, publicKey: (await this.ensureVapid()).pub });
    }
    if (path === '/api/push/unsubscribe' && request.method === 'POST') {
      const b = await body();
      if (this.db && Array.isArray(this.db.pushSubscriptions)) {
        this.db.pushSubscriptions = this.db.pushSubscriptions.filter((s) => s && s.endpoint !== (b.endpoint || ''));
        this.scheduleSave();
      }
      return json({ ok: true });
    }
    if (path === '/api/push/status' && request.method === 'GET') {
      const userId = String(q.get('user') || '');
      const subs = (this.db && Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : []).filter((s) => s.userId === userId);
      return json({ ok: true, devices: subs.length, publicKey: (await this.ensureVapid()).pub });
    }
    if (path === '/api/push/test' && request.method === 'POST') {
      const b = await body();
      const userId = String(b.userId || '');
      const subs = (this.db && Array.isArray(this.db.pushSubscriptions) ? this.db.pushSubscriptions : []).filter((s) => s.userId === userId);
      if (!subs.length) return json({ ok: false, sent: 0, error: 'no_device' });
      let sent = 0;
      for (const sub of subs) {
        const r = await this.sendPushTo(sub, { title: b.title || 'WhaleChat', body: b.body || 'Push notifications are working 🐋', link: b.link || '#/notifications', tag: 'wc-test', icon: './assets/logo-192.png', badge: './assets/badge-72.png', renotify: true, ts: Date.now() });
        if (r === true) sent++;
      }
      return json({ ok: sent > 0, sent });
    }

    /* live market quotes */
    if (path === '/api/market/quotes' && request.method === 'GET') {
      if (!this.marketAt || Date.now() - this.marketAt > 30000) { try { await this.refreshMarket(); } catch (e) {} }
      return json(this.marketSnapshot());
    }
    if (path === '/api/market/status' && request.method === 'GET') return json(Object.assign({ ok: true }, this.marketStatus()));
    if (path === '/api/market/history' && request.method === 'GET') {
      const raw = String(q.get('tickers') || q.get('ticker') || '').toUpperCase();
      const tickers = raw.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 40);
      const limit = Number(q.get('limit')) || 240;
      const history = await this.historyFor(tickers, limit);
      return json({ ok: true, at: Date.now(), source: 'live', notice: this.marketStatus().notice, status: this.marketStatus(), history });
    }
    if (path === '/api/market/stream' && request.method === 'GET') {
      return this.marketStream(request);
    }

    /* optional services the app probes — keep the shell quiet, never fatal */
    if (path === '/api/bots/state') return json({ ok: true, bots: [], enabled: false });
    if (path === '/api/shares/state') return json({ ok: true, shares: [], enabled: false });

    return json({ ok: false, error: 'not_found', path }, 404);
  }
  marketStream(request) {
    const id = 'm_' + Math.random().toString(36).slice(2);
    let controller;
    const stream = new ReadableStream({
      start: (c) => { controller = c; },
      cancel: () => { this.marketClients.delete(id); }
    });
    this.marketClients.set(id, controller);
    try {
      controller.enqueue(enc.encode('retry: 5000\n\n'));
      controller.enqueue(enc.encode(frameOf('status', { source: 'live', notice: this.marketStatus().notice, status: this.marketStatus() })));
      if (this.quotes && Object.keys(this.quotes).length && Date.now() - this.marketAt < 60000) {
        controller.enqueue(enc.encode(frameOf('snapshot', this.marketSnapshot())));
      }
    } catch (e) {}
    const go = () => { this.refreshMarket().catch(() => {}); };
    if (!this.marketAt || Date.now() - this.marketAt > 30000) go();
    else setTimeout(go, Math.max(1000, 30000 - (Date.now() - this.marketAt)));
    if (request.signal) request.signal.addEventListener('abort', () => this.marketClients.delete(id));
    return new Response(stream, { headers: Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' }, CORS) });
  }

  events(request, userId) {
    const id = 'c_' + Math.random().toString(36).slice(2);
    let controller;
    const stream = new ReadableStream({
      start: (c) => { controller = c; },
      cancel: () => { this.clients.delete(id); if (userId && this.countSockets(userId) === 0) this.markOffline(userId); }
    });
    this.clients.set(id, { user: userId, controller, at: Date.now() });
    if (userId) {
      const snap = {};
      this.presenceAudience(userId).forEach((uid) => { snap[uid] = this.presenceView(uid); });
      try {
        controller.enqueue(enc.encode('retry: 1500\n\n'));
        controller.enqueue(enc.encode(frameOf('hello', { rev: this.rev, at: Date.now() })));
        controller.enqueue(enc.encode(frameOf('presence-snapshot', { at: Date.now(), presence: snap })));
      } catch (e) {}
      this.touchPresence(userId, { visible: true });
      this.markDelivered(userId);
    }
    if (request.signal) request.signal.addEventListener('abort', () => {
      this.clients.delete(id);
      if (userId && this.countSockets(userId) === 0) this.markOffline(userId);
    });
    return new Response(stream, { headers: Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' }, CORS) });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, app: APP, version: VERSION });
    const id = env.CHAT_HUB.idFromName(DO_NAME);
    return env.CHAT_HUB.get(id).fetch(request);
  }
};
