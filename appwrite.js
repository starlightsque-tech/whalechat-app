/* =========================================================================
   WhaleChat · Appwrite backup & storage sync  (server side)

   Keeps the whole application database and the uploaded app files in an
   Appwrite project so a Render redeploy, a disk reset or a sleeping instance
   can never erase user accounts, balances or transactions.

   Environment:
     APPWRITE_ENDPOINT      https://cloud.appwrite.io/v1
     APPWRITE_PROJECT_ID    your project id
     APPWRITE_API_KEY       server API key (never exposed to the app)
     APPWRITE_BUCKET_ID     storage bucket for the snapshot (default whalechat)
     APPWRITE_DATABASE_ID   optional document mirror (default whalechat)
     APPWRITE_COLLECTION_ID optional collection (default snapshots)

   The module is a no-op when the env is missing, and every network call is
   bounded and caught: a backup failure must never take the app down.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ENDPOINT = String(process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1').replace(/\/+$/, '');
const PROJECT = String(process.env.APPWRITE_PROJECT_ID || '').trim();
const KEY = String(process.env.APPWRITE_API_KEY || '').trim();
const BUCKET = String(process.env.APPWRITE_BUCKET_ID || 'whalechat').trim();
const DATABASE = String(process.env.APPWRITE_DATABASE_ID || 'whalechat').trim();
const COLLECTION = String(process.env.APPWRITE_COLLECTION_ID || 'snapshots').trim();
const FILE_ID = 'whalechat-state';
const STATE_FILENAME = 'whalechat-state.json';

const state = {
  configured: false,
  lastAt: 0,
  lastOkAt: 0,
  lastError: '',
  lastBytes: 0,
  lastRestoreAt: 0,
  restored: false,
  uploads: 0,
  timer: null,
  busy: false
};

function configured() {
  return !!(PROJECT && KEY);
}

function headers(extra) {
  return Object.assign({
    'X-Appwrite-Project': PROJECT,
    'X-Appwrite-Key': KEY
  }, extra || {});
}

async function req(pathname, opts) {
  const url = ENDPOINT + pathname;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, json: null, text: '' };
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------------ bucket */
async function ensureBucket() {
  if (!configured()) return false;
  const got = await req('/storage/buckets/' + encodeURIComponent(BUCKET), { headers: headers() });
  if (got.ok) return true;
  const made = await req('/storage/buckets', {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      bucketId: BUCKET,
      name: 'WhaleChat backups',
      permissions: [],
      fileSecurity: false,
      enabled: true,
      maximumFileSize: 50000000,
      allowedFileExtensions: ['json', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'svg', 'pdf'],
      compression: 'none',
      encryption: true,
      antivirus: true
    })
  });
  /* 409 = already exists */
  return made.ok || made.status === 409;
}

async function ensureDatabase() {
  if (!configured()) return false;
  if (!DATABASE || DATABASE === 'none') return false;
  let got = await req('/databases/' + encodeURIComponent(DATABASE), { headers: headers() });
  if (!got.ok) {
    await req('/databases', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ databaseId: DATABASE, name: 'WhaleChat' })
    });
  }
  got = await req('/databases/' + encodeURIComponent(DATABASE) + '/collections/' + encodeURIComponent(COLLECTION), { headers: headers() });
  if (!got.ok) {
    await req('/databases/' + encodeURIComponent(DATABASE) + '/collections', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        collectionId: COLLECTION,
        name: 'State snapshots',
        permissions: [],
        documentSecurity: false,
        enabled: true
      })
    });
    /* attributes are created lazily; failures here are non-fatal because the
       storage bucket already holds the authoritative snapshot */
    await req('/databases/' + encodeURIComponent(DATABASE) + '/collections/' + encodeURIComponent(COLLECTION) + '/attributes/string', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ key: 'payload', size: 1048576, required: false, array: false })
    });
    await req('/databases/' + encodeURIComponent(DATABASE) + '/collections/' + encodeURIComponent(COLLECTION) + '/attributes/integer', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ key: 'rev', required: false, min: 0, max: 2147483647, array: false })
    });
  }
  return true;
}

/* ------------------------------------------------------- storage snapshot */
async function uploadSnapshot(db, rev, tag) {
  if (!configured() || !db) return { ok: false, error: 'not_configured' };
  const payload = JSON.stringify({ at: Date.now(), tag: tag || 'auto', rev: rev || 0, db });
  const bytes = Buffer.from(payload, 'utf8');
  const form = new FormData();
  form.append('fileId', FILE_ID);
  form.append('file', new Blob([bytes], { type: 'application/json' }), STATE_FILENAME);
  const base = '/storage/buckets/' + encodeURIComponent(BUCKET) + '/files';
  /* Appwrite PUT /files/{id} only updates metadata — recreate the snapshot so
     the bytes really change. */
  await req(base + '/' + FILE_ID, { method: 'DELETE', headers: headers() });
  let out = await req(base, { method: 'POST', headers: headers(), body: form });
  if (!out.ok) {
    state.lastError = 'upload ' + (out.status || '') + ' ' + (out.json && out.json.message ? out.json.message : out.error || '');
    return { ok: false, error: state.lastError };
  }
  state.lastOkAt = Date.now();
  state.lastBytes = bytes.length;
  state.lastError = '';
  /* optional document mirror (best effort) */
  try {
    if (await ensureDatabase()) {
      const docUrl = '/databases/' + encodeURIComponent(DATABASE) + '/collections/' + encodeURIComponent(COLLECTION) + '/documents/snapshot';
      const docBody = JSON.stringify({ documentId: 'snapshot', data: { payload: payload.slice(0, 1000000), rev: Number(rev) || 0 } });
      const put = await req(docUrl, { method: 'PUT', headers: headers({ 'content-type': 'application/json' }), body: docBody });
      if (!put.ok && put.status === 404) {
        await req('/databases/' + encodeURIComponent(DATABASE) + '/collections/' + encodeURIComponent(COLLECTION) + '/documents', {
          method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: docBody
        });
      }
    }
  } catch (e) { /* non-fatal */ }
  return { ok: true, bytes: bytes.length, at: state.lastOkAt };
}

function schedule(store, delayMs) {
  if (!configured() || !store || !store.db) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(function () {
    state.timer = null;
    backup(store, 'auto').catch(() => {});
  }, Math.max(1500, delayMs == null ? 15000 : delayMs));
  state.timer.unref && state.timer.unref();
}

async function backup(store, tag) {
  if (!configured() || !store || !store.db) return { ok: false, error: 'not_configured' };
  if (state.busy) return { ok: false, error: 'busy' };
  state.busy = true;
  state.lastAt = Date.now();
  try {
    if (!(await ensureBucket())) return { ok: false, error: 'bucket_unavailable' };
    return await uploadSnapshot(store.db, store.rev, tag);
  } catch (e) {
    state.lastError = e.message;
    return { ok: false, error: e.message };
  } finally { state.busy = false; }
}

/* ------------------------------------------------------------- restore */
async function downloadSnapshot() {
  if (!configured()) return null;
  const urls = [
    '/storage/buckets/' + encodeURIComponent(BUCKET) + '/files/' + FILE_ID + '/view?t=' + Date.now(),
    '/storage/buckets/' + encodeURIComponent(BUCKET) + '/files/' + FILE_ID + '/download'
  ];
  for (const u of urls) {
    const out = await req(u, { method: 'GET', headers: headers() });
    if (out.ok && out.text) {
      try { return JSON.parse(out.text); } catch (e) {}
    }
  }
  return null;
}

function mergeDb(local, remote) {
  if (!remote || !remote.db) return { db: local, changed: false };
  if (!local) return { db: remote.db, changed: true };
  let changed = false;
  const byId = (arr) => (Array.isArray(arr) ? arr : []);
  /* users: never delete, prefer the copy with the newer password/verified state */
  local.users = byId(local.users);
  byId(remote.users).forEach((ru) => {
    if (!ru || !ru.id) return;
    const found = local.users.find((u) => u && (u.id === ru.id ||
      String(u.username || '').toLowerCase() === String(ru.username || '').toLowerCase() ||
      String(u.email || '').toLowerCase() === String(ru.email || '').toLowerCase()));
    if (!found) { local.users.push(ru); changed = true; return; }
    if ((Number(ru.updatedAt) || 0) > (Number(found.updatedAt) || 0)) {
      if (ru.pass) found.pass = ru.pass;
      if (ru.pin) found.pin = ru.pin;
      if (ru.verified) found.verified = true;
      found.updatedAt = ru.updatedAt;
      changed = true;
    }
  });
  /* money-bearing collections: keep whichever side has more records */
  ['deposits', 'withdrawals', 'orders', 'trades', 'holdings', 'txs', 'notifications', 'products', 'vendors', 'chats', 'messages'].forEach((key) => {
    const a = byId(local[key]), b = byId(remote[key]);
    if (!b.length) return;
    const seen = new Set(a.map((x) => x && (x.id || x.tradeId || JSON.stringify(x).slice(0, 80))));
    b.forEach((x) => {
      const id = x && (x.id || x.tradeId || JSON.stringify(x).slice(0, 80));
      if (id && !seen.has(id)) { a.push(x); seen.add(id); changed = true; }
    });
    local[key] = a;
  });
  return { db: local, changed };
}

async function restore(store, log) {
  if (!configured() || !store) return { ok: false, error: 'not_configured' };
  const snap = await downloadSnapshot();
  if (!snap || !snap.db) {
    state.lastError = 'no_snapshot';
    return { ok: false, error: 'no_snapshot' };
  }
  const merged = mergeDb(store.db, snap);
  if (merged.changed) {
    store.db = merged.db;
    store.updatedAt = Date.now();
    state.restored = true;
    if (typeof store.persist === 'function') store.persist();
    if (log) log('[appwrite] restored snapshot from ' + new Date(snap.at || 0).toISOString());
  }
  state.lastRestoreAt = Date.now();
  return { ok: true, changed: merged.changed, at: snap.at || 0 };
}

/* --------------------------------------------------------- media upload */
async function uploadFiles(rootDir, opts) {
  if (!configured()) return { ok: false, error: 'not_configured' };
  const opts2 = opts || {};
  const max = Math.max(1, Number(opts2.max) || 25);
  const dirs = opts2.dirs || ['products', 'assets', 'bots', 'company/products'];
  let uploaded = 0;
  for (const rel of dirs) {
    const dir = path.join(rootDir, rel);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (uploaded >= max) break;
      if (/\.(b64|part\d+|apk)$/i.test(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
      const id = Buffer.from(rel + '/' + name).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 36) || ('f' + uploaded);
      const form = new FormData();
      form.append('fileId', id);
      form.append('file', new Blob([fs.readFileSync(full)]), name);
      const out = await req('/storage/buckets/' + encodeURIComponent(BUCKET) + '/files', {
        method: 'POST', headers: headers(), body: form
      });
      if (out.ok || out.status === 409) uploaded++;
    }
  }
  state.uploads += uploaded;
  return { ok: true, uploaded };
}

function status() {
  return {
    ok: true,
    configured: configured(),
    endpoint: ENDPOINT,
    project: PROJECT ? PROJECT.slice(0, 4) + '…' : '',
    bucket: BUCKET,
    database: DATABASE,
    lastAt: state.lastAt,
    lastOkAt: state.lastOkAt,
    lastBytes: state.lastBytes,
    lastRestoreAt: state.lastRestoreAt,
    restored: state.restored,
    uploads: state.uploads,
    lastError: state.lastError
  };
}

module.exports = { configured, status, schedule, backup, restore, uploadSnapshot, uploadFiles, ensureBucket, ensureDatabase };
