#!/usr/bin/env node
/* =========================================================================
   Create / update the Appwrite database, collections and attributes used by
   the offline reconciliation engine and the portfolio mirror.

   Env:
     APPWRITE_ENDPOINT     default https://nyc.cloud.appwrite.io/v1
     APPWRITE_PROJECT_ID   default 6aff3eda000983f5a975
     APPWRITE_API_KEY      server key with databases.* scopes  (required)

   Usage: APPWRITE_API_KEY=... npm run deploy:appwrite:db
   Idempotent: existing databases, collections and attributes are left alone.
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (e) {}

const cfgMod = await import(path.join(ROOT, 'server-config.js')).then((m) => m.default || m).catch(() => null);
const DEFAULTS = cfgMod ? cfgMod.DEFAULTS : null;

const ENDPOINT = String(process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1').replace(/\/+$/, '');
const PROJECT = String(process.env.APPWRITE_PROJECT_ID || '6aff3eda000983f5a975').trim();
const KEY = String(process.env.APPWRITE_API_KEY || '').trim();
let DB = String(process.env.APPWRITE_DATABASE_ID || '').trim();

if (!KEY) {
  console.error('Missing APPWRITE_API_KEY (databases.* scope).');
  process.exit(2);
}

const H = { 'X-Appwrite-Project': PROJECT, 'X-Appwrite-Key': KEY, 'content-type': 'application/json', 'X-Appwrite-Response-Format': '1.9.5' };

async function req(pathname, opts = {}) {
  const res = await fetch(ENDPOINT + pathname, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: res.ok, status: res.status, json, text };
}

const COLLECTIONS = [
  {
    id: 'offline_orders',
    name: 'Offline orders',
    attrs: [
      ['clientOrderId', 'string', 64, true],
      ['userId', 'string', 64, true],
      ['ticker', 'string', 24, true],
      ['assetType', 'string', 16, false],
      ['side', 'string', 8, false],
      ['orderType', 'string', 16, false],
      ['quantity', 'double', null, false],
      ['notionalUsd', 'double', null, false],
      ['offlineSimulatedPrice', 'double', null, false],
      ['executedLivePrice', 'double', null, false],
      ['offlineTimestamp', 'integer', null, false],
      ['syncedAt', 'integer', null, false],
      ['syncStatus', 'string', 32, false]
    ],
    indexes: [{ key: 'idx_client_order', type: 'unique', attributes: ['clientOrderId'] }, { key: 'idx_user', type: 'key', attributes: ['userId'] }]
  },
  {
    id: 'orders',
    name: 'Orders',
    attrs: [
      ['clientOrderId', 'string', 64, false],
      ['userId', 'string', 64, true],
      ['ticker', 'string', 24, false],
      ['side', 'string', 8, false],
      ['orderType', 'string', 16, false],
      ['quantity', 'double', null, false],
      ['notionalUsd', 'double', null, false],
      ['priceUsd', 'double', null, false],
      ['status', 'string', 32, false],
      ['createdAt', 'integer', null, false]
    ],
    indexes: [{ key: 'idx_user_orders', type: 'key', attributes: ['userId'] }]
  },
  {
    id: 'portfolios',
    name: 'Portfolios',
    attrs: [
      ['userId', 'string', 64, true],
      ['cashUsd', 'double', null, false],
      ['reservedUsd', 'double', null, false],
      ['updatedAt', 'integer', null, false],
      ['holdingsJson', 'string', 65536, false]
    ],
    indexes: [{ key: 'idx_portfolio_user', type: 'unique', attributes: ['userId'] }]
  },
  {
    id: 'sync_log',
    name: 'Sync log',
    attrs: [
      ['userId', 'string', 64, false],
      ['kind', 'string', 32, false],
      ['count', 'integer', null, false],
      ['detail', 'string', 65536, false],
      ['at', 'integer', null, false]
    ],
    indexes: []
  }
];

async function ensureDatabase() {
  /* Reuse the project's existing database: the free plan allows a single
     database, so creating another one is refused by the platform. */
  if (DB) {
    const got = await req('/databases/' + DB);
    if (got.ok) { console.log('[db] exists', DB); return; }
  }
  const list = await req('/databases');
  const all = (list.ok && list.json && list.json.databases) || [];
  if (all.length) {
    DB = all[0].$id;
    console.log('[db] reusing project database', DB, '(' + all[0].name + ')');
  } else {
    const made = await req('/databases', { method: 'POST', body: JSON.stringify({ databaseId: 'whalechat', name: 'WhaleChat' }) });
    if (made.ok || made.status === 409) { DB = 'whalechat'; console.log('[db] created', DB); }
    else throw new Error('database create failed: ' + made.status + ' ' + made.text.slice(0, 240));
  }
}

async function existingCollections() {
  const list = await req('/databases/' + DB + '/collections?limit=100');
  if (!list.ok) return new Set();
  return new Set(((list.json && list.json.collections) || []).map((c) => c.$id));
}

async function ensureCollection(c) {
  const got = await req('/databases/' + DB + '/collections/' + c.id);
  if (!got.ok) {
    const made = await req('/databases/' + DB + '/collections', {
      method: 'POST',
      body: JSON.stringify({ collectionId: c.id, name: c.name, permissions: ['read("users")', 'create("users")', 'update("users")'], documentSecurity: false })
    });
    if (made.ok) console.log('[col] created', c.id);
    else if (made.status !== 409) console.log('[col] failed', c.id, made.status, made.text.slice(0, 160));
  } else console.log('[col] exists', c.id);

  for (const [key, type, size, required] of c.attrs) {
    const body = { key, type, required };
    if (type === 'string') body.size = size;
    if (type === 'integer') body.min = -9007199254740991, body.max = 9007199254740991;
    if (type === 'double') body.min = -1e15, body.max = 1e15;
    const made = await req('/databases/' + DB + '/collections/' + c.id + '/attributes/' + (type === 'string' ? 'string' : type === 'integer' ? 'integer' : 'float'), {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (made.ok) console.log('   +' + key);
    else if (made.status === 409) { /* exists */ }
    else console.log('   !' + key, made.status, made.text.slice(0, 120));
  }

  for (const idx of c.indexes) {
    const made = await req('/databases/' + DB + '/collections/' + c.id + '/indexes', {
      method: 'POST',
      body: JSON.stringify({ key: idx.key, type: idx.type, attributes: idx.attributes })
    });
    if (made.ok) console.log('   ~index', idx.key);
  }
}

console.log('[appwrite]', ENDPOINT, 'project', PROJECT);
await ensureDatabase();
console.log('[appwrite] database', DB);
const have = await existingCollections();
for (const c of COLLECTIONS) {
  if (have.has(c.id)) { console.log('[col] exists', c.id); continue; }
  await ensureCollection(c);
}
const health = await req('/databases/' + DB + '/collections/offline_orders/documents?limit=1');
console.log('[appwrite] offline_orders readable:', health.ok ? 'yes' : 'no (' + health.status + ')');
