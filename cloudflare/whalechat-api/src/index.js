/* =========================================================================
   WhaleChat Cloudflare sync server
   One Durable Object owns the database, presence, messages and session rooms.
   It fans every write out over a single SSE stream per device, so the client
   stays local-first and never polls.
   ========================================================================= */
const APP = 'whalechat';
const VERSION = '3.58.1';
const BUILD = '2026-11-21T22:00:00Z';
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

export class ChatHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.db = null;
    this.rev = 0;
    this.updatedAt = 0;
    this.clients = new Map();      // id -> { user, controller, at }
    this.presence = new Map();     // userId -> { ts, lastSeen, currentChatWith, device, visible }
    this.loaded = false;
    this.saveTimer = null;
    this.pingTimer = setInterval(() => this.ping(), 20000);
    this.sweepTimer = setInterval(() => this.sweepPresence(), 10000);
    this.ready = this.load();
  }
  async load() {
    try {
      const meta = await this.state.storage.get('state:meta');
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
    } catch (e) { console.error('[hub] load failed', e.message); }
    this.loaded = true;
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

    /* optional services the app probes — keep the shell quiet, never fatal */
    if (path.startsWith('/api/push/')) return json({ ok: false, disabled: true, reason: 'push_not_configured' });
    if (path === '/api/market/quotes') return json({ quotes: {}, at: Date.now(), ok: true, mode: 'offline' });
    if (path === '/api/market/status') return json({ ok: true, mode: 'offline', source: 'offline', marketOpen: true, alwaysOpen: true, tickers: 0, refreshSec: 30 });
    if (path === '/api/market/stream') return new Response('event: snapshot\ndata: {"quotes":{},"at":' + Date.now() + '}\n\nretry: 5000\n\n', { headers: Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' }, CORS) });
    if (path === '/api/bots/state') return json({ ok: true, bots: [], enabled: false });
    if (path === '/api/shares/state') return json({ ok: true, shares: [], enabled: false });

    return json({ ok: false, error: 'not_found', path }, 404);
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
    const id = env.CHAT_HUB.idFromName('global');
    return env.CHAT_HUB.get(id).fetch(request);
  }
};
