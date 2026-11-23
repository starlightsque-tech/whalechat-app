/* =========================================================================
   WhaleChat instant + offline chat  (v1.0)

   Architecture (local-first):
     1. SEND      — the message is written to IndexedDB and drawn on screen
                    synchronously. No network in the send path. Input cleared.
     2. OUTBOX    — a durable IndexedDB queue retries the send in the background
                    (immediately, then 5s / 10s / 30s) and can also be flushed by
                    the service worker when the tab is closed.
     3. RECEIVE   — one long-lived SSE connection (or Appwrite Realtime when
                    configured) applies the message straight into IndexedDB and
                    the open thread. No polling, no full state download.
     4. HISTORY   — IndexedDB cache is merged into the in-memory database at boot,
                    so a chat never shows a spinner.
     5. STATUS    — clock = queued · single tick = sent · double = delivered ·
                    blue double = read.

   The transport is pluggable:
     - default : the WhaleChat server (/api/messages/*) — works on Fly/self-host,
                 no Render proxy in the path.
     - appwrite: set
                 localStorage['wc.appwrite'] = JSON.stringify({endpoint,project,
                   database,collection})
                 …and the same optimistic/offline pipeline talks to Appwrite
                 Realtime instead (see CHAT-INSTANT.md).

   Everything is idempotent: the message id is generated on the device and is
   reused as the document id, so retries can never duplicate a message.
   ========================================================================= */
'use strict';

(function () {
  if (typeof window === 'undefined') return;
  if (window.__WCI_LOADED__) return;
  window.__WCI_LOADED__ = true;

  const WCI = window.WCI = {};
  const DB_NAME = 'whalechat_instant';
  const DB_VER = 1;
  const RETRY_MS = [5000, 10000, 30000, 60000];
  const $ = (id) => document.getElementById(id);
  const now = () => Date.now();
  const rand = () => Math.random().toString(36).slice(2, 10);

  const ST = { QUEUED: 'queued', SENT: 'sent', DELIVERED: 'delivered', SEEN: 'seen' };
  /* message ids that only the instant outbox may transmit — keeps the generic
     cross-device state sync from racing (and bypassing) the outbox. */
  const pendingIds = new Set();
  const RANK = { queued: 0, sent: 1, delivered: 2, seen: 3 };

  /* ------------------------------------------------------------------ *
   *  IndexedDB (tiny promise wrapper — no CDN dependency, works offline) *
   * ------------------------------------------------------------------ */
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no-indexeddb'));
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('messages')) {
          const s = d.createObjectStore('messages', { keyPath: 'id' });
          s.createIndex('chatAt', ['chatId', 'createdAt']);
          s.createIndex('at', 'createdAt');
        }
        if (!d.objectStoreNames.contains('outbox')) {
          const o = d.createObjectStore('outbox', { keyPath: 'id' });
          o.createIndex('at', 'createdAt');
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb-open-failed'));
    }).catch((e) => { console.warn('[wci] indexeddb unavailable', e && e.message); return null; });
    return dbp;
  }
  function tx(store, mode) {
    return idb().then((d) => {
      if (!d) throw new Error('no-idb');
      return d.transaction(store, mode).objectStore(store);
    });
  }
  function idbPut(store, value) {
    return tx(store, 'readwrite').then((s) => new Promise((res, rej) => {
      const r = s.put(value); r.onsuccess = () => res(value); r.onerror = () => rej(r.error);
    })).catch(() => null);
  }
  function idbDel(store, key) {
    return tx(store, 'readwrite').then((s) => new Promise((res) => {
      const r = s.delete(key); r.onsuccess = () => res(true); r.onerror = () => res(false);
    })).catch(() => null);
  }
  function idbAll(store) {
    return tx(store, 'readonly').then((s) => new Promise((res) => {
      const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]);
    })).catch(() => []);
  }
  function idbChat(chatId, limit) {
    return tx('messages', 'readonly').then((s) => new Promise((res) => {
      const out = [];
      const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
      const cur = s.index('chatAt').openCursor(range, 'prev');
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || out.length >= (limit || 200)) return res(out.sort((a, b) => a.createdAt - b.createdAt));
        out.push(c.value); c.continue();
      };
      cur.onerror = () => res([]);
    })).catch(() => []);
  }
  WCI.idbAll = idbAll;
  WCI.idbChat = idbChat;
  WCI.server = () => new Promise((res) => {
    tx('meta', 'readonly').then((s) => {
      const r = s.get('server'); r.onsuccess = () => res((r.result || {}).v || ''); r.onerror = () => res('');
    }).catch(() => res(''));
  });

  /* ------------------------------------------------------------------ *
   *  Transport: self-hosted WhaleChat server (default) or Appwrite       *
   * ------------------------------------------------------------------ */
  function awCfg() {
    try {
      const raw = localStorage.getItem('wc.appwrite');
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || !c.endpoint || !c.project || !c.database || !c.collection) return null;
      return c;
    } catch (e) { return null; }
  }
  WCI.awCfg = awCfg;

  function apiPath(p) {
    if (awCfg()) return null;                       // appwrite mode: no app-server hop
    try { if (typeof Remote !== 'undefined' && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }
  function serverBase() {
    try { if (typeof Remote !== 'undefined' && Remote.enabled) return Remote.base || location.origin; } catch (e) {}
    return location.origin;
  }
  WCI.online = () => navigator.onLine !== false;
  WCI.transport = () => (awCfg() ? 'appwrite' : (typeof Remote !== 'undefined' && Remote.enabled ? 'whalechat-server' : 'local-only'));

  async function postJSON(url, body, timeout) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout || 9000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
        keepalive: true
      });
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } finally { clearTimeout(t); }
  }

  /* Appwrite REST helpers (only used when wc.appwrite is configured) */
  function awHeaders(c) {
    return { 'content-type': 'application/json', 'x-appwrite-project': c.project, 'x-sdk-version': 'whalechat-instant' };
  }
  async function awCreate(c, msg) {
    const doc = {
      messageId: msg.id,
      chatId: msg.chatId,
      from: msg.from,
      to: msg.to,
      type: msg.type || 'text',
      text: msg.text || '',
      createdAt: msg.createdAt,
      status: 'sent',
      deleted: false,
      readBy: [],
      clientId: msg.id
    };
    const url = c.endpoint.replace(/\/$/, '') + '/databases/' + encodeURIComponent(c.database) +
      '/collections/' + encodeURIComponent(c.collection) + '/documents';
    const r = await postJSON(url, Object.assign({ documentId: 'unique()' }, doc, { permissions: [
      'read("user:' + msg.from + '")', 'read("user:' + msg.to + '")',
      'update("user:' + msg.from + '")', 'update("user:' + msg.to + '")'
    ] }), 10000);
    return r;
  }

  /* ------------------------------------------------------------------ *
   *  Local state helpers                                               *
   * ------------------------------------------------------------------ */
  function appDb() {
    try { return (typeof DB !== 'undefined' && DB) ? DB : null; } catch (e) { return null; }
  }
  function meId() {
    try { return (typeof me === 'function' && me()) ? me().id : null; } catch (e) { return null; }
  }
  function persistNow() {
    try { if (typeof persist === 'function') persist(true); } catch (e) {}
  }
  function safeRender() {
    try { if (typeof render === 'function') render(); } catch (e) {}
  }
  function activeChat() {
    try { return (typeof ACTIVE_CHAT !== 'undefined' && ACTIVE_CHAT) ? ACTIVE_CHAT : null; } catch (e) { return null; }
  }
  function hashChatId() {
    try {
      const m = /^#\/chat\/([^?#\/]+)/.exec(location.hash || '');
      const uid = meId();
      if (!m || !uid) return null;
      return [uid, decodeURIComponent(m[1])].sort().join('__');
    } catch (e) { return null; }
  }
  function routeType() {
    try { return (location.hash || '').replace(/^#\/?/, '').split('?')[0].split('/')[0] || 'home'; } catch (e) { return 'home'; }
  }
  function stripVolatile(m) {
    const c = Object.assign({}, m);
    delete c.__local;
    return c;
  }

  /* ------------------------------------------------------------------ *
   *  SEND — optimistic, synchronous, 0 network                           *
   * ------------------------------------------------------------------ */
  function newId() { return 'msg_' + now().toString(36) + '_' + rand(); }

  function drawMessage(cid, msg, otherId) {
    const body = $('chatBody');
    if (!body) return false;
    try {
      const u = me();
      const other = (typeof findUser === 'function' ? findUser(otherId) : null) || { id: otherId, fullName: 'Contact' };
      if (typeof messageHTML !== 'function') return false;
      body.insertAdjacentHTML('beforeend', messageHTML(msg, u, other));
      body.scrollTop = body.scrollHeight;
      return true;
    } catch (e) { return false; }
  }

  function paintStatus(id, status) {
    const el = document.querySelector('[data-msg="' + id + '"] .tick');
    if (!el) return;
    const st = status || ST.SENT;
    el.classList.toggle('seen', st === ST.SEEN);
    el.innerHTML = st === ST.QUEUED
      ? (typeof ic === 'function' ? ic('clock', 12) : '…')
      : (typeof ic === 'function' ? ic(st === ST.SENT ? 'check' : 'checks', 12) : '✓✓');
    el.title = st === ST.QUEUED ? 'Waiting for connection' : st === ST.SEEN ? 'Read' : st === ST.DELIVERED ? 'Delivered' : 'Sent';
  }

  async function enqueue(msg) {
    pendingIds.add(msg.id);
    const row = {
      id: msg.id, chatId: msg.chatId, from: msg.from, to: msg.to,
      type: msg.type || 'text', text: msg.text || '', createdAt: msg.createdAt,
      /* stickers (and anything else a message carries) must survive the outbox */
      sticker: msg.sticker || null, mediaUrl: msg.mediaUrl || null,
      attempts: 0, nextAt: 0
    };
    await idbPut('messages', stripVolatile(Object.assign({}, msg, { __state: 'queued' })));
    await idbPut('outbox', row);
    kick();
    registerBackgroundSync();
  }

  let flushing = false;
  function kick() { setTimeout(flush, 0); }

  async function flush() {
    if (flushing) return;
    if (!WCI.online()) return;                       // stay queued, no error, no button
    const rows = (await idbAll('outbox')).sort((a, b) => a.createdAt - b.createdAt);
    if (!rows.length) return;
    if (!awCfg() && !(typeof Remote !== 'undefined' && Remote.enabled)) return; // local-only mode

    flushing = true;
    try {
      for (const row of rows.slice(0, 25)) {
        if (row.nextAt && row.nextAt > now()) continue;
        const sent = await pushOne(row);
        if (sent === 'sent') continue;
        if (sent === 'fatal') return;
        if (sent === 'retry') {
          const wait = RETRY_MS[Math.min(row.attempts || 0, RETRY_MS.length - 1)];
          row.attempts = (row.attempts || 0) + 1;
          row.nextAt = now() + wait;
          await idbPut('outbox', row);
        }
      }
    } finally { flushing = false; }

    const left = await idbAll('outbox');
    if (left.length) {
      const soonest = Math.min.apply(null, left.map((r) => r.nextAt || 0));
      setTimeout(flush, Math.max(1200, soonest - now()));
    }
  }
  WCI.flush = flush;
  /* used by the sticker tray: queue any already-built message on the same
     durable outbox so stickers get the same offline queue and delivery ticks */
  WCI.enqueueMessage = function (msg) {
    try { return enqueue(msg); } catch (e) { return Promise.resolve(); }
  };
  WCI.newId = function () { return newId(); };

  function markSent(msgId, sid, status) {
    pendingIds.delete(msgId);
    const db = appDb(); if (!db || !Array.isArray(db.messages)) return;
    const m = db.messages.find((x) => x && x.id === msgId);
    if (m) {
      if ((RANK[status || ST.SENT] || 0) > (RANK[m.status] || 0)) m.status = status || ST.SENT;
      m.sid = sid || m.sid || null;
      m.queuedAt = m.queuedAt || null;
    }
    persistNow();
    paintStatus(msgId, (m && m.status) || status || ST.SENT);
  }

  async function pushOne(row) {
    const msg = {
      id: row.id, chatId: row.chatId, from: row.from, to: row.to,
      type: row.type || 'text', text: row.text || '', createdAt: row.createdAt,
      status: ST.SENT, deleted: false, readBy: []
    };
    if (row.sticker) msg.sticker = row.sticker;
    if (row.mediaUrl) msg.mediaUrl = row.mediaUrl;
    try {
      if (awCfg()) {
        const r = await awCreate(awCfg(), msg);
        if (r.ok || r.status === 409) {
          await idbDel('outbox', row.id);
          markSent(row.id, (r.data && r.data.$id) || null, ST.SENT);
          await idbPut('messages', Object.assign({}, msg, { sid: (r.data && r.data.$id) || null }));
          return 'sent';
        }
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          // rejected for good (permissions/schema): keep the text, stop retrying forever
          await idbPut('outbox', Object.assign({}, row, { attempts: 9, nextAt: now() + 3600000, error: (r.data && r.data.message) || ('HTTP ' + r.status) }));
          console.warn('[wci] appwrite rejected message', r.status, r.data);
          return 'retry';
        }
        return 'retry';
      }

      const url = apiPath('/api/messages/send');
      const r = await postJSON(url, { message: msg }, 9000);
      if (r.ok) {
        await idbDel('outbox', row.id);
        markSent(row.id, (r.data && r.data.id) || null, ST.SENT);
        await idbPut('messages', Object.assign({}, msg, { sid: (r.data && r.data.id) || null }));
        return 'sent';
      }
      if (r.status === 404) {
        /* Older server without the message API: hand the message to the legacy
           state sync (it is already in DB.messages) and stop queueing. */
        WCI.legacy = true;
        try { if (typeof Remote !== 'undefined' && Remote.enabled) Remote.onLocalChange(); } catch (e) {}
        await idbDel('outbox', row.id);
        markSent(row.id, null, ST.SENT);
        return 'sent';
      }
      if (r.status === 403) {
        await idbPut('outbox', Object.assign({}, row, { attempts: 9, nextAt: now() + 3600000, error: 'forbidden' }));
        return 'retry';
      }
      return 'retry';
    } catch (e) {
      return 'retry';
    }
  }

  /* ------------------------------------------------------------------ *
   *  Ingestion — one path for realtime, history and local echo           *
   * ------------------------------------------------------------------ */
  function ensureContact(ownerId, otherId) {
    const db = appDb(); if (!db) return false;
    if (!Array.isArray(db.contacts)) db.contacts = [];
    if (ownerId === otherId) return false;
    if (db.contacts.some((c) => c && c.ownerId === ownerId && c.userId === otherId)) return false;
    const other = (db.users || []).find((u) => u && u.id === otherId);
    if (!other) return false;
    db.contacts.push({ id: 'ct_' + rand(), ownerId, userId: otherId, createdAt: now(), auto: true });
    return true;
  }

  function isMeRead(m, uid) {
    if (!m) return false;
    if (Array.isArray(m.readBy)) return m.readBy.includes(uid);
    return m.status === ST.SEEN;             // legacy rows
  }
  function markReadLocal(m, uid) {
    if (!m) return;
    if (!Array.isArray(m.readBy)) m.readBy = [];
    if (!m.readBy.includes(uid)) m.readBy.push(uid);
    /* never change the status on the reader's copy: status belongs to the
       sender and is delivered by the realtime ack, not by state sync. */
    try { idbPut('messages', stripVolatile(m)); } catch (e) {}
  }

  function ingest(raw, opts) {
    const db = appDb();
    const uid = meId();
    if (!db || !uid || !raw || !raw.id) return false;
    if (raw.from !== uid && raw.to !== uid) return false;   // never display someone else's traffic
    if (!Array.isArray(db.messages)) db.messages = [];

    const i = db.messages.findIndex((m) => m && m.id === raw.id);
    const prev = i >= 0 ? db.messages[i] : null;
  /* ring + vibrate for a genuinely new incoming message (not history replay) */
  try {
    const age = Date.now() - (Number(raw.createdAt) || Date.now());
    if (!prev && raw.from !== uid && age < 60000 && window.WC_ALERT) window.WC_ALERT.play('message');
  } catch (e) {}
    const next = Object.assign({}, prev || {}, raw);
    let changed = !prev;
    const prevRank = prev ? (RANK[prev.status] || 0) : -1;
    if ((RANK[raw.status] || 0) < prevRank) next.status = prev.status;
    if (!next.status) next.status = (next.from === uid ? ST.SENT : ST.SENT);
    if (prev) {
      if (prev.status !== next.status) changed = true;
      if (prev.text !== next.text) changed = true;
      if (Array.isArray(next.readBy) && Array.isArray(prev.readBy) && next.readBy.length !== prev.readBy.length) changed = true;
      if ((prev.deleted || false) !== (next.deleted || false)) changed = true;
    }
    if (i >= 0) db.messages[i] = next; else db.messages.push(next);

    /* a message from someone the receiver never saved still gets a thread */
    let contactsChanged = false;
    if (next.to === uid) contactsChanged = ensureContact(uid, next.from);
    if (contactsChanged) changed = true;

    idbPut('messages', stripVolatile(next));
    /* IndexedDB is the durable write. The whole-database localStorage snapshot
       is deferred until after the bubble is painted, so a large account never
       adds hundreds of milliseconds to an incoming message. */
    if (!opts || opts.persist !== false) setTimeout(persistNow, 0);

    const open = activeChat() || hashChatId();
    const isOpen = open && next.chatId === open;
    if (isOpen && next.to === uid && !isMeRead(next, uid)) {
      /* the thread is on screen: mark it read locally and tell the sender.
         (Never mark a message read just because it was downloaded — that used
         to suppress unread badges and read receipts for closed chats.) */
      markReadLocal(next, uid);
      changed = true;
    }
    if (isOpen) {
      if (prev) { scheduleRender(); }
      else if (!drawMessage(open, next, next.from === uid ? next.to : next.from)) scheduleRender();
      if (next.from !== uid) ackRead(next.chatId, [next.id]);
    } else if (contactsChanged || routeType() === 'home') {
      scheduleRender();
    } else if (changed) {
      bumpBadge();
    }
    return changed;
  }
  WCI.ingest = ingest;

  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      safeRender();
      try { if (typeof Media !== 'undefined' && Media.hydrate) Media.hydrate(document); } catch (e) {}
      if (activeChat()) { const b = $('chatBody'); if (b) b.scrollTop = b.scrollHeight; }
    }, 16);
  }

  function bumpBadge() {
    try {
      const uid = meId(); if (!uid) return;
      const n = (typeof unreadCount === 'function') ? unreadCount(uid) : 0;
      const b = $('navBadge') || document.querySelector('.nav-badge');
      if (b) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = n ? '' : 'none'; }
      try { syncBadge && 0; } catch (e) {}
      if (routeType() === 'home') scheduleRender();
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   *  READ RECEIPTS — durable queue                                      *
   *  A receipt is never dropped when the network is down: it is stored   *
   *  (localStorage survives a reload) and drained on reconnect.          *
   * ------------------------------------------------------------------ */
  const READQ_KEY = 'wc.readq.v1';
  function readQueue() {
    try { const q = JSON.parse(localStorage.getItem(READQ_KEY) || '[]'); return Array.isArray(q) ? q : []; }
    catch (e) { return []; }
  }
  function saveReadQueue(q) {
    try { localStorage.setItem(READQ_KEY, JSON.stringify((q || []).slice(-200))); } catch (e) {}
  }
  function queueRead(chatId, ids) {
    const q = readQueue();
    const hit = q.find((x) => x && x.chatId === chatId);
    if (hit) {
      const set = new Set(hit.ids || []);
      ids.forEach((id) => set.add(id));
      hit.ids = Array.from(set).slice(-500);
      hit.at = now();
    } else q.push({ chatId, ids: ids.slice(-500), at: now() });
    saveReadQueue(q);
  }

  const ackSent = new Set();
  function ackRead(chatId, ids) {
    const uid = meId();
    if (!uid || !chatId || !ids || !ids.length) return;
    const fresh = ids.filter((id) => !ackSent.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => ackSent.add(id));
    if (awCfg() || !(typeof Remote !== 'undefined' && Remote.enabled)) return;
    queueRead(chatId, fresh);
    drainReadQueue();
  }

  let drainingReads = false;
  async function drainReadQueue() {
    if (drainingReads || !WCI.online()) return;
    if (awCfg() || !(typeof Remote !== 'undefined' && Remote.enabled)) return;
    let q = readQueue();
    if (!q.length) return;
    const uid = meId();
    if (!uid) return;
    drainingReads = true;
    try {
      while (q.length) {
        const item = q[0];
        let r = null;
        try { r = await postJSON(apiPath('/api/messages/ack'), { chatId: item.chatId, userId: uid, ids: item.ids, kind: 'read' }, 7000); }
        catch (e) { break; }                       // offline: keep it queued
        const fatal = r && r.status >= 400 && r.status < 500;
        if ((r && r.ok) || fatal) { q.shift(); saveReadQueue(q); }
        else break;                                // retry on the next wake-up
      }
    } finally { drainingReads = false; }
  }
  WCI.drainReadQueue = drainReadQueue;

  function ackDelivered(chatId, ids) {
    const uid = meId();
    if (!uid || !chatId || !ids || !ids.length) return;
    if (awCfg() || !(typeof Remote !== 'undefined' && Remote.enabled)) return;
    postJSON(apiPath('/api/messages/ack'), { chatId, userId: uid, ids, kind: 'delivered' }, 7000).catch(() => {});
  }

  function applyAck(kind, d) {
    const db = appDb(); if (!db) return;
    const uid = meId();
    if (!uid) return;
    const status = kind === 'read' ? ST.SEEN : ST.DELIVERED;
    let touched = false;
    (d.ids || []).forEach((id) => {
      const m = (db.messages || []).find((x) => x && x.id === id);
      if (!m) return;
      if (m.from !== uid) {
        if (kind === 'read' && d.userId && Array.isArray(m.readBy) && !m.readBy.includes(d.userId)) {
          m.readBy.push(d.userId); touched = true;
        }
        return;
      }
      if ((RANK[status] || 0) > (RANK[m.status] || 0)) {
        m.status = status; paintStatus(id, status); touched = true;
        try { idbPut('messages', stripVolatile(m)); } catch (e) {}
      }
    });
    if (!touched) return;
    persistNow();
    if (routeType() === 'home') scheduleRender();
  }

  /* ------------------------------------------------------------------ *
   *  REALTIME — one subscription for the whole app lifetime             *
   * ------------------------------------------------------------------ */
  /* Extra realtime channels (presence, typing, receipts) register here so the
     app keeps ONE EventSource for its whole lifetime. */
  const rtHandlers = {};
  WCI.onRealtime = function (name, fn) {
    if (typeof fn !== 'function') return function () {};
    (rtHandlers[name] = rtHandlers[name] || []).push(fn);
    return function () { rtHandlers[name] = (rtHandlers[name] || []).filter((f) => f !== fn); };
  };
  WCI.emit = function (name, data) {
    (rtHandlers[name] || []).forEach((fn) => { try { fn(data); } catch (e) {} });
    (rtHandlers['*'] || []).forEach((fn) => { try { fn(name, data); } catch (e) {} });
  };
  WCI.realtimeUrl = function () {
    const uid = meId() || '';
    return (Remote.base || '') + '/api/events?client=' + encodeURIComponent(Remote.clientId) + '&user=' + encodeURIComponent(uid);
  };

  let es = null, esRetry = 0, esWatchdog = null, lastEventAt = 0;

  function connectRealtime() {
    if (awCfg()) return connectAppwrite();
    if (!(typeof Remote !== 'undefined' && Remote.enabled)) {
      setTimeout(connectRealtime, 2500);
      return;
    }
    stopRealtime();
    const uid = meId() || '';
    const url = (Remote.base || '') + '/api/events?client=' + encodeURIComponent(Remote.clientId) + '&user=' + encodeURIComponent(uid);
    try { es = new EventSource(url); } catch (e) { return; }
    /* session-room frames ride the same stream; forward them to any module
       that registered a handler (no second socket, no polling). */
    ['room-message', 'room-invite', 'room-update', 'room-typing', 'room-read'].forEach((name) => {
      es.addEventListener(name, (e) => {
        lastEventAt = now();
        let d = {}; try { d = JSON.parse(e.data); } catch (err) { return; }
        WCI.emit(name, d);
      });
    });
    es.addEventListener('hello', () => {
      esRetry = 0; lastEventAt = now(); WCI.rtStatus = 'online';
      WCI.emit('hello', {});
      /* a reconnect may have missed frames: quietly catch up the open thread
         and flush anything the network refused while we were away. */
      try {
        const cid = activeChat() || hashChatId();
        const uidNow = meId();
        const other = cid && uidNow ? cid.split('__').find((x) => x !== uidNow) : null;
        if (other) fetchHistory(other, { force: true });
      } catch (e) {}
      drainReadQueue();
    });
    es.addEventListener('presence', (e) => {
      lastEventAt = now();
      let d = {}; try { d = JSON.parse(e.data); } catch (err) { return; }
      WCI.emit('presence', d);
    });
    es.addEventListener('presence-snapshot', (e) => {
      lastEventAt = now();
      let d = {}; try { d = JSON.parse(e.data); } catch (err) { return; }
      WCI.emit('presence-snapshot', d);
    });
    es.addEventListener('typing', (e) => {
      lastEventAt = now();
      let d = {}; try { d = JSON.parse(e.data); } catch (err) { return; }
      WCI.emit('typing', d);
    });
    es.addEventListener('message', (e) => {
      lastEventAt = now();
      let d = {}; try { d = JSON.parse(e.data); } catch (err) { return; }
      if (!d || !d.message) return;
      const m = d.message;
      const uidNow = meId();
      if (m.from === uidNow && m.to) {
        /* our own message came back — it is now on the server */
        markSent(m.id, m.id, ST.SENT);
        if (m.status && (RANK[m.status] || 0) > RANK[ST.SENT]) markSent(m.id, m.id, m.status);
      }
      ingest(m);
      if (m.to === uidNow && m.from !== uidNow) ackDelivered(m.chatId, [m.id]);
    });
    es.addEventListener('delivered', (e) => {
      lastEventAt = now();
      try { applyAck('delivered', JSON.parse(e.data)); } catch (err) {}
    });
    es.addEventListener('read', (e) => {
      lastEventAt = now();
      try { applyAck('read', JSON.parse(e.data)); } catch (err) {}
    });
    es.addEventListener('change', (e) => {
      /* message-only revision: we already applied the payload, so tell the
         state syncer to skip the expensive full-download for this revision. */
      try {
        const d = JSON.parse(e.data);
        if (d && d.messagesOnly && d.rev) WCI.msgOnlyRev = Math.max(WCI.msgOnlyRev || 0, d.rev);
      } catch (err) {}
    });
    es.onerror = () => {
      WCI.rtStatus = 'offline';
      try { es.close(); } catch (e) {}
      es = null;
      esRetry = Math.min(esRetry + 1, 6);
      setTimeout(connectRealtime, Math.min(8000, 400 * Math.pow(2, esRetry)));
    };
    clearInterval(esWatchdog);
    esWatchdog = setInterval(() => {
      if (!WCI.online()) return;
      if (now() - lastEventAt > 55000) {          // silent stream: rebuild it
        lastEventAt = now();
        try { es && es.close(); } catch (e) {}
        es = null; connectRealtime();
      }
    }, 20000);
  }

  function stopRealtime() {
    clearInterval(esWatchdog); esWatchdog = null;
    if (es) { try { es.close(); } catch (e) {} }
    es = null;
    if (awClient) { try { awClient.unsubscribe(); } catch (e) {} awClient = null; }
  }

  let awClient = null;
  function connectAppwrite() {
    const c = awCfg();
    if (!c) return;
    loadAppwriteSdk().then((Appwrite) => {
      if (!Appwrite) { setTimeout(connectAppwrite, 4000); return; }
      try {
        const client = new Appwrite.Client().setEndpoint(c.endpoint).setProject(c.project);
        const uid = meId();
        if (uid) client.setSession('');           // session cookie / anonymous: realtime works with project perms
        awClient = client;
        client.subscribe('databases.' + c.database + '.collections.' + c.collection + '.documents', (res) => {
          if (!res || !res.payload) return;
          const p = res.payload;
          const m = {
            id: p.messageId || p.$id, chatId: p.chatId, from: p.from, to: p.to,
            type: p.type, text: p.text, createdAt: Number(p.createdAt) || now(),
            status: p.status || ST.SENT, readBy: p.readBy || [], sid: p.$id
          };
          if (res.events && res.events.some((ev) => /\.delete$/.test(ev))) return;
          ingest(m);
        });
        WCI.rtStatus = 'online';
      } catch (e) { setTimeout(connectAppwrite, 5000); }
    });
  }

  function loadAppwriteSdk() {
    if (loadAppwriteSdk._p) return loadAppwriteSdk._p;
    loadAppwriteSdk._p = new Promise((resolve) => {
      if (window.Appwrite) return resolve(window.Appwrite);
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/appwrite@17.0.0/dist/iife/sdk.js';
      s.async = true;
      s.onload = () => resolve(window.Appwrite || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return loadAppwriteSdk._p;
  }

  /* ------------------------------------------------------------------ *
   *  HISTORY — cache first, network second                             *
   * ------------------------------------------------------------------ */
  async function hydrateFromCache() {
    const db = appDb(); if (!db) return 0;
    const rows = await idbAll('messages');
    if (!rows || !rows.length) return 0;
    const uid = meId(); if (!uid) return 0;
    const byChat = new Map();
    rows.forEach((m) => {
      if (!m || !m.id || (m.from !== uid && m.to !== uid)) return;
      const arr = byChat.get(m.chatId) || [];
      arr.push(m); byChat.set(m.chatId, arr);
    });
    let added = 0;
    if (!Array.isArray(db.messages)) db.messages = [];
    byChat.forEach((arr) => {
      arr.sort((a, b) => a.createdAt - b.createdAt);
      const keep = arr.slice(-150);
      const have = new Set((db.messages || []).map((m) => m && m.id));
      const base = new Map((db.messages || []).map((m) => [m && m.id, m]));
      keep.forEach((m) => {
        if (have.has(m.id)) {
          const cur = base.get(m.id);
          if (m.status && (RANK[m.status] || 0) > (RANK[cur.status] || 0)) cur.status = m.status;
          return;
        }
        const clean = Object.assign({}, m); delete clean.__state;
        db.messages.push(clean); added++;
      });
    });
    /* restore anything still queued in the outbox (app was killed mid-send) */
    const outbox = await idbAll('outbox');
    outbox.forEach((row) => {
      const m = (db.messages || []).find((x) => x && x.id === row.id);
      if (m && RANK[m.status] === 0) return;
      if (!m) {
        db.messages.push({
          id: row.id, chatId: row.chatId, from: row.from, to: row.to, type: row.type || 'text',
          text: row.text || '', createdAt: row.createdAt, status: ST.QUEUED, deleted: false, readBy: []
        });
        added++;
      } else { m.status = ST.QUEUED; }
    });
    if (added) persistNow();
    return added;
  }

  const lastFetchAt = {};
  async function fetchHistory(otherUserId, opts) {
    const uid = meId();
    if (!uid || !otherUserId) return 0;
    const gate = lastFetchAt[otherUserId] || 0;
    if (!opts || !opts.force) {
      if (now() - gate < 4000) return 0;
    }
    lastFetchAt[otherUserId] = now();
    const chatId = [uid, otherUserId].sort().join('__');
    const cached = (appDb() && appDb().messages || []).filter((m) => m && m.chatId === chatId);
    const since = cached.reduce((a, m) => Math.max(a, Number(m.createdAt) || 0), 0);
    if (awCfg()) return 0;                                   // realtime keeps Appwrite in sync
    if (!(typeof Remote !== 'undefined' && Remote.enabled)) return 0;
    try {
      const url = apiPath('/api/messages/list?chatId=' + encodeURIComponent(chatId) +
        '&user=' + encodeURIComponent(uid) + '&limit=200' +
        (opts && opts.full ? '' : '&since=' + since));
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      let data = null;
      try { const res = await fetch(url, { signal: ctrl.signal }); data = await res.json(); } finally { clearTimeout(t); }
      if (!data || !data.ok || !Array.isArray(data.messages)) return 0;
      let n = 0;
      data.messages.forEach((m) => { if (ingest(m, { persist: false })) n++; });
      if (n) { persistNow(); scheduleRender(); }
      return n;
    } catch (e) { return 0; }
  }
  WCI.fetchHistory = fetchHistory;

  /* ------------------------------------------------------------------ *
   *  SEND OVERRIDE                                                      *
   * ------------------------------------------------------------------ */
  let origSend = null;
  function installSend() {
    if (typeof App === 'undefined' || !App || !App.send || App.send.__wci) return;
    origSend = App.send;
    const send = function () {
      let editing = false;
      try { editing = typeof EDITING !== 'undefined' && !!EDITING; } catch (e) {}
      if (typeof me !== 'function') return origSend.apply(this, arguments);
      const u = me();
      if (!u || !activeChat()) return origSend.apply(this, arguments);
      const cid = activeChat();
      const inp = $('msgInput');
      const comp = (typeof COMPOSE !== 'undefined' && COMPOSE[cid]) || {};
      const text = ((inp ? inp.value : comp.text) || '').trim();
      const media = comp.media || [];
      if (editing || media.length) return origSend.apply(this, arguments);  // media/edit keep legacy path (still local-first)
      if (!text) return;

      const otherId = cid.split('__').find((x) => x !== u.id);
      if (!otherId) return origSend.apply(this, arguments);

      const msg = {
        id: newId(), chatId: cid, from: u.id, to: otherId,
        createdAt: now(), status: ST.QUEUED, type: 'text', text,
        deleted: false, readBy: [], forwarded: false, queuedAt: now(),
        __instant: true
      };

      const db = appDb();
      if (!db) return origSend.apply(this, arguments);
      if (!Array.isArray(db.messages)) db.messages = [];
      db.messages.push(msg);
      pendingIds.add(msg.id);
      if (typeof COMPOSE !== 'undefined') COMPOSE[cid] = { text: '', media: [] };
      if (inp) { inp.value = ''; inp.style.height = 'auto'; }
      if (db.chatsMeta && db.chatsMeta[cid] && (db.chatsMeta[cid].deletedFor || []).includes(u.id)) {
        db.chatsMeta[cid].deletedFor = db.chatsMeta[cid].deletedFor.filter((x) => x !== u.id);
      }
      /* Paint first. The whole-database localStorage write and the IndexedDB
         enqueue happen after the bubble is on screen, so a big account can
         never make Send feel slow. */
      if (!drawMessage(cid, msg, otherId)) safeRender();
      enqueue(msg);

      /* never block the UI on storage, notifications or network */
      setTimeout(() => {
        persistNow();
        /* No in-app notification row for the recipient: the message itself is
           the notification (and the worker sends the lock-screen push). Adding
           one made the recipient download the whole state right after the
           message, which stalled the bubble. */
        try { if (typeof sync === 'function') sync(); } catch (e) {}
      }, 0);
    };
    send.__wci = true;
    App.send = send;
  }

  /* ------------------------------------------------------------------ *
   *  VIEW HOOKS — status icons, non-contact threads, cache-first open   *
   * ------------------------------------------------------------------ */
  function installHooks() {
    /* status ticks: clock / single / double / blue double */
    if (typeof messageHTML === 'function' && !messageHTML.__wci) {
      const orig = messageHTML;
      const patched = function (m, u, other) {
        let html = orig(m, u, other);
        if (!m || !u || m.from !== u.id) return html;
        const st = m.status || ST.SENT;
        const icon = st === ST.QUEUED
          ? (typeof ic === 'function' ? ic('clock', 12) : '◷')
          : (typeof ic === 'function' ? ic(st === ST.SENT ? 'check' : 'checks', 12) : '✓');
        const title = st === ST.QUEUED ? 'Waiting for connection' : st === ST.SEEN ? 'Read' : st === ST.DELIVERED ? 'Delivered' : 'Sent';
        return html.replace(/<span class="tick[^>]*>[\s\S]*?<\/span>/,
          '<span class="tick ' + (st === ST.SEEN ? 'seen' : st === ST.QUEUED ? 'queued' : '') + '" title="' + title + '">' + icon + '</span>');
      };
      patched.__wci = true;
      try { messageHTML = patched; window.messageHTML = patched; } catch (e) {}
    }

    /* a thread created by an incoming message must open even without a saved contact */
    if (typeof isContact === 'function' && !isContact.__wci) {
      const origContact = isContact;
      const patched = function (ownerId, otherId) {
        if (origContact(ownerId, otherId)) return true;
        const db = appDb();
        if (!db || !Array.isArray(db.messages)) return false;
        return db.messages.some((m) => m && ((m.from === ownerId && m.to === otherId) || (m.from === otherId && m.to === ownerId)));
      };
      patched.__wci = true;
      try { isContact = patched; window.isContact = patched; } catch (e) {}
    }

    /* after a chat renders: prefetch history + send read receipts */
    if (typeof afterRender === 'function' && !afterRender.__wci) {
      const origAfter = afterRender;
      const patched = function (parts, params) {
        try { origAfter.apply(this, arguments); } catch (e) {}
        try {
          if (!parts || parts[0] !== 'chat' || !parts[1]) return;
          const uid = meId(); if (!uid) return;
          const cid = [uid, parts[1]].sort().join('__');
          try { ACTIVE_CHAT = cid; } catch (e) {}
          /* Ack by message id, not by the local readBy flag: the legacy view
             code can set readBy before this hook runs, and that used to skip
             the network receipt entirely. ackRead de-duplicates per session. */
          const pending = (appDb().messages || [])
            .filter((m) => m && m.chatId === cid && m.from !== uid && !ackSent.has(m.id))
            .map((m) => { markReadLocal(m, uid); return m.id; });
          if (pending.length) { persistNow(); ackRead(cid, pending); }
          fetchHistory(parts[1], { force: !lastFetchAt[parts[1]] });
        } catch (e) {}
      };
      patched.__wci = true;
      try { afterRender = patched; window.afterRender = patched; } catch (e) {}
    }
  }

  /* Keep queued messages out of the generic state sync: they must travel
     through the outbox so offline/retry/status behaviour stays correct. */
  function installDiffGuard() {
    if (typeof diffDB !== 'function' || diffDB.__wci) return;
    const orig = diffDB;
    const patched = function (prev, next) {
      const ops = orig.apply(this, arguments) || [];
      /* Messages sent through the instant engine already travelled over
         /api/messages/send. Letting them leak into the generic state diff made
         the server broadcast a full-state change to the other device right
         after delivery, which triggered a whole-app refresh and stalled the
         incoming bubble. Keep them out of state sync for good. */
      return ops.filter((op) => !(op && op.col === 'messages' && op.item && (pendingIds.has(op.item.id) || op.item.__instant)));
    };
    patched.__wci = true;
    try { diffDB = patched; window.diffDB = patched; } catch (e) {}
  }

  /* Stop the state syncer from downloading the whole database for a revision
     that only carried messages we already applied over the realtime channel. */
  function patchRefresh() {
    if (typeof Remote === 'undefined' || !Remote || Remote.refresh.__wci) return;
    const orig = Remote.refresh;
    const patched = function (force) {
      if (!force && WCI.msgOnlyRev && Number(this.rev) === Number(WCI.msgOnlyRev)) {
        this.status = 'online';
        return Promise.resolve();
      }
      return orig.apply(this, arguments);
    };
    patched.__wci = true;
    Remote.refresh = patched;

    /* never lose queued messages when a full state arrives */
    const origApply = Remote.refresh;
    Remote.refresh = async function (force) {
      const r = await origApply.call(this, force);
      try {
        const db = appDb();
        if (db && Array.isArray(db.messages)) {
          const known = new Set(db.messages.map((m) => m && m.id));
          const rows = await idbAll('messages');
          let changed = false;
          rows.forEach((m) => {
            if (!m || //no id
                !m.id) return;
            if (known.has(m.id)) return;
            if (RANK[m.status] === 0) { db.messages.push(Object.assign({}, m)); changed = true; }
          });
          if (changed) { persistNow(); }
        }
      } catch (e) {}
      return r;
    };
  }

  /* ------------------------------------------------------------------ *
   *  BOOT                                                              *
   * ------------------------------------------------------------------ */
  let connectingTransport = false;
  async function ensureTransport() {
    if (connectingTransport) return;
    if (typeof Remote === 'undefined' || !Remote) return;
    if (Remote.enabled || !WCI.online()) return;
    connectingTransport = true;
    try {
      await Remote.init();
      if (Remote.enabled) { connectRealtime(); flush(); }
    } catch (e) {} finally { connectingTransport = false; }
  }

  function registerBackgroundSync() {
    try {
      if (!('serviceWorker' in navigator)) return;
      /* only when the page itself cannot keep the queue moving */
      if (!document.hidden) return;
      navigator.serviceWorker.ready.then((reg) => {
        if (reg.sync && reg.sync.register) reg.sync.register('wc-outbox').catch(() => {});
      }).catch(() => {});
    } catch (e) {}
  }

  let booted = false;
  async function boot() {
    if (booted) return;
    if (typeof DB_READY === 'undefined' || !DB_READY || !appDb() || !meId()) {
      return setTimeout(boot, 200);
    }
    booted = true;
    installDiffGuard();
    installSend();
    installHooks();
    patchRefresh();

    const added = await hydrateFromCache();
    try { (await idbAll('outbox')).forEach((r) => pendingIds.add(r.id)); } catch (e) {}
    if (added) { installHooks(); safeRender(); }

    /* publish the server base for the service worker outbox */
    try { if (typeof Remote !== 'undefined' && Remote.enabled) idbPut('meta', { k: 'server', v: Remote.base || location.origin }); } catch (e) {}

    connectRealtime();
    flush();
    drainReadQueue();
    registerBackgroundSync();

    /* the service worker drains the outbox while the tab is closed */
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
          const d = ev.data || {};
          if (d.type === 'wc-outbox-flushed' && Array.isArray(d.ids)) {
            d.ids.forEach((id) => markSent(id, null, ST.SENT));
            if (activeChat()) scheduleRender();
          }
        });
      }
    } catch (e) {}

    /* reconnect handling: instantly, no user action */
    window.addEventListener('online', () => {
      WCI.rtStatus = 'reconnecting';
      ensureTransport();
      connectRealtime();
      flush();
      drainReadQueue();
    });
    window.addEventListener('offline', () => { WCI.rtStatus = 'offline'; });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { registerBackgroundSync(); return; }
      ensureTransport();
      flush();
      drainReadQueue();
      if (!es) connectRealtime();
    });
    setInterval(() => { if (WCI.online()) { ensureTransport(); flush(); } }, 20000);

    /* if the app is running the legacy full-state sync, message events still
       arrive over the same stream; keep the subscription alive across routes */
    setInterval(() => { if (!es && !awClient) connectRealtime(); }, 30000);

    WCI.ready = true;
    try { console.info('[wci] instant chat ready · transport:', WCI.transport()); } catch (e) {}
  }

  /* status pill helpers exposed for the UI */
  WCI.statusLabel = function () {
    const t = WCI.transport();
    if (t === 'appwrite') return 'Appwrite realtime';
    if (t === 'whalechat-server') return WCI.rtStatus === 'offline' ? 'reconnecting' : 'realtime';
    return 'offline queue';
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 600);
})();
