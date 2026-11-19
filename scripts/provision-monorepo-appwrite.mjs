#!/usr/bin/env node
/**
 * Provision the Whalechat monorepo Appwrite schema (idempotent).
 *
 *   APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1 \
 *   APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... \
 *   node scripts/provision-monorepo-appwrite.mjs
 *
 * Creates the database, collections, attributes and the UNIQUE
 * idempotencyKey indexes that make trades/orders at-most-once.
 * Use --dry-run to print the plan without an API key.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

const endpoint = (process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1').replace(/\/$/, '');
const projectId = process.env.APPWRITE_PROJECT_ID || '';
const apiKey = process.env.APPWRITE_API_KEY || '';
const databaseId = process.env.APPWRITE_DATABASE_ID || 'whalechat';

async function loadSchema() {
  const source = await readFile(path.join(ROOT, 'packages/shared/src/appwrite/schema.ts'), 'utf8');
  // A tiny export-list check so a missing collection fails the provisioner
  // instead of silently creating a partial schema.
  const required = ['users', 'wallets', 'conversations', 'messages', 'products', 'orders', 'trades', 'ledger_transactions'];
  const missing = required.filter((id) => !source.includes(`id: '${id}'`));
  if (missing.length) throw new Error(`Schema is missing collections: ${missing.join(', ')}`);
  const module = await import(pathToFileUrl(path.join(ROOT, 'packages/shared/dist/appwrite/schema.js')));
  return module.WHALECHAT_COLLECTIONS;
}

function pathToFileUrl(p) {
  return new URL(`file://${p}`).href;
}

async function api(method, route, body) {
  const res = await fetch(`${endpoint}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-appwrite-project': projectId,
      'x-appwrite-key': apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: text };
  }
  return { ok: res.ok, status: res.status, json };
}

function attrBody(attr) {
  const body = {
    key: attr.key,
    required: Boolean(attr.required),
    array: Boolean(attr.array),
  };
  if (attr.type === 'string' || attr.type === 'email' || attr.type === 'url') body.size = attr.size ?? 255;
  if (attr.type === 'integer' || attr.type === 'float') {
    body.min = attr.min ?? (attr.type === 'integer' ? -2147483648 : -1e12);
    body.max = attr.max ?? (attr.type === 'integer' ? 2147483647 : 1e12);
  }
  if (attr.default !== undefined) body.default = attr.default;
  return body;
}

function attrRoute(type) {
  return type === 'email' ? 'email' : type === 'url' ? 'url' : type;
}

async function ensureDatabase() {
  const created = await api('POST', '/databases', { databaseId, name: 'Whalechat' });
  if (created.ok) return console.log(`+ database ${databaseId}`);
  if (created.status === 409) return console.log(`= database ${databaseId}`);
  throw new Error(`create database failed: ${created.status} ${created.json?.message ?? ''}`);
}

async function listIds(route) {
  const res = await api('GET', route);
  if (!res.ok) return new Set();
  return new Set((res.json?.collections ?? res.json?.attributes ?? res.json?.indexes ?? []).map((x) => x.$id ?? x.key));
}

async function ensureCollection(collection) {
  const existing = await listIds(`/databases/${databaseId}/collections`);
  if (!existing.has(collection.id)) {
    const created = await api('POST', `/databases/${databaseId}/collections`, {
      collectionId: collection.id,
      name: collection.name,
      permissions: ['read("users")', 'create("users")', 'update("users")', 'delete("users")'],
      documentSecurity: true,
    });
    if (!created.ok && created.status !== 409) {
      throw new Error(`create ${collection.id} failed: ${created.status} ${created.json?.message ?? ''}`);
    }
    console.log(`${created.ok ? '+' : '='} collection ${collection.id}`);
  } else {
    console.log(`= collection ${collection.id}`);
  }

  const attrIds = await listIds(`/databases/${databaseId}/collections/${collection.id}/attributes`);
  for (const attr of collection.attributes) {
    if (attrIds.has(attr.key)) continue;
    const res = await api(
      'POST',
      `/databases/${databaseId}/collections/${collection.id}/attributes/${attrRoute(attr.type)}`,
      attrBody(attr),
    );
    if (!res.ok && res.status !== 409) {
      throw new Error(`attribute ${collection.id}.${attr.key} failed: ${res.status} ${res.json?.message ?? ''}`);
    }
    console.log(`  + ${collection.id}.${attr.key} (${attr.type})`);
  }

  const indexIds = await listIds(`/databases/${databaseId}/collections/${collection.id}/indexes`);
  for (const index of collection.indexes) {
    if (indexIds.has(index.key)) continue;
    const res = await api('POST', `/databases/${databaseId}/collections/${collection.id}/indexes`, {
      key: index.key,
      type: index.type,
      attributes: index.attributes,
      orders: index.orders ?? index.attributes.map(() => 'ASC'),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`index ${collection.id}.${index.key} failed: ${res.status} ${res.json?.message ?? ''}`);
    }
    console.log(`  + ${collection.id}.${index.key} (${index.type})`);
  }
}

async function main() {
  const collections = await loadSchema();
  console.log(`Whalechat schema: ${collections.length} collections → ${endpoint} / ${databaseId}`);

  if (DRY || !apiKey || !projectId) {
    console.log(`\n${DRY ? 'DRY RUN' : 'MISSING APPWRITE_API_KEY / APPWRITE_PROJECT_ID'} — plan only:\n`);
    for (const collection of collections) {
      console.log(`• ${collection.id}: ${collection.attributes.length} attributes, ${collection.indexes.length} indexes`);
      for (const index of collection.indexes) console.log(`    ${index.type} ${index.key} (${index.attributes.join(', ')})`);
    }
    return;
  }

  await ensureDatabase();
  for (const collection of collections) await ensureCollection(collection);
  console.log('\nDone. Unique idempotency indexes now enforce at-most-once trades/orders/messages.');
}

main().catch((error) => {
  console.error(`\n[provision] ${error.message}`);
  process.exit(1);
});
