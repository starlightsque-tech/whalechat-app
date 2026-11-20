import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Tests exercise the explicit body-user compatibility path; production keeps
// the secure default (session header required).
process.env.WC_SYNC_TRUST_BODY_USER = '1';
const { createMonorepoSync } = require('../monorepo-sync.js');

/** Minimal in-memory Appwrite Databases REST double. */
function fakeApi() {
  const collections = new Map();
  const db = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  let clock = 0;
  const iso = () => new Date(1700000000000 + (clock += 1000)).toISOString();

  return {
    seed(collection, id, data) {
      db(collection).set(id, { $id: id, $createdAt: iso(), $updatedAt: iso(), ...data });
    },
    get(collection, id) {
      return db(collection).get(id) || null;
    },
    all(collection) {
      return [...db(collection).values()];
    },
    async api(path, opts = {}) {
      const method = (opts.method || 'GET').toUpperCase();
      const [rawPath, rawQuery = ''] = path.split('?');
      const parts = rawPath.split('/').filter(Boolean); // databases/db/collections/col/documents/id
      if (parts[0] !== 'databases' || parts[2] !== 'collections' || parts[4] !== 'documents') {
        return { ok: false, status: 404, json: { message: 'not found' }, text: '' };
      }
      const collection = parts[3];
      const id = parts[5];
      const qs = new URLSearchParams(rawQuery);
      const docs = db(collection);

      if (method === 'GET' && !id) {
        let rows = [...docs.values()];
        for (const raw of qs.getAll('queries[]')) {
          const q = JSON.parse(raw);
          if (q.method === 'equal') rows = rows.filter((d) => q.values.includes(d[q.attribute]));
          if (q.method === 'greaterThan') rows = rows.filter((d) => String(d[q.attribute]) > String(q.values[0]));
        }
        const limit = Number(qs.get('limit') || 25);
        return { ok: true, status: 200, json: { total: rows.length, documents: rows.slice(0, limit) }, text: '' };
      }
      if (method === 'GET') {
        const doc = docs.get(id);
        return doc
          ? { ok: true, status: 200, json: doc, text: '' }
          : { ok: false, status: 404, json: { message: 'not found' }, text: '' };
      }
      if (method === 'POST') {
        const body = JSON.parse(opts.body || '{}');
        if (docs.has(body.documentId)) {
          return { ok: false, status: 409, json: { message: 'document already exists' }, text: '' };
        }
        const now = iso();
        const doc = { $id: body.documentId, $createdAt: now, $updatedAt: now, ...body.data };
        docs.set(body.documentId, doc);
        return { ok: true, status: 201, json: doc, text: '' };
      }
      if (method === 'PATCH') {
        const doc = docs.get(id);
        if (!doc) return { ok: false, status: 404, json: { message: 'not found' }, text: '' };
        const body = JSON.parse(opts.body || '{}');
        Object.assign(doc, body.data || {}, { $updatedAt: iso() });
        return { ok: true, status: 200, json: doc, text: '' };
      }
      if (method === 'DELETE') {
        docs.delete(id);
        return { ok: true, status: 204, json: null, text: '' };
      }
      return { ok: false, status: 405, json: { message: 'method' }, text: '' };
    },
  };
}

function setup() {
  const fake = fakeApi();
  const sync = createMonorepoSync({
    api: fake.api,
    readState: async () => ({ db: { stocks: [{ ticker: 'AAPL', price: 100 }], users: [], audit: [] } }),
    saveState: async () => true,
  });
  const call = (path, body, method = 'POST') =>
    sync.handle({ headers: {} }, method, path, body);
  return { fake, sync, call };
}

test('message send is idempotent under replay', async () => {
  const { fake, call } = setup();
  const body = { userId: 'u1', conversationId: 'c1', body: 'hello', idempotencyKey: '11111111-1111-4111-8111-111111111111' };
  const first = await call('/api/messages', body);
  const second = await call('/api/messages', body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.id, second.body.id);
  assert.equal(fake.all('messages').length, 1);
  assert.equal(fake.all('messages')[0].idempotencyKey, body.idempotencyKey);
});

test('checkout holds funds once and replays the same order', async () => {
  const { fake, call } = setup();
  fake.seed('products', 'p1', { title: 'Headphones', priceMinor: 1000, currency: 'USD', active: true });
  fake.seed('wallets', 'w_seed', { userId: 'u1', currency: 'USD', availableMinor: 5000, lockedMinor: 0, version: 1, updatedAt: new Date().toISOString(), id: 'w_seed' });

  const body = {
    userId: 'u1', currency: 'USD', shippingMinor: 0, idempotencyKey: '22222222-2222-4222-8222-222222222222',
    items: [{ productId: 'p1', quantity: 2, unitPrice: { amountMinor: 1, currency: 'USD' }, title: 'spoof' }],
  };
  const first = await call('/api/orders/checkout', body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.total.amountMinor, 2000);
  assert.equal(first.body.status, 'paid_escrow');
  const wallet = fake.all('wallets')[0];
  assert.equal(wallet.availableMinor, 3000);
  assert.equal(wallet.lockedMinor, 2000);

  const replay = await call('/api/orders/checkout', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(fake.all('orders').length, 1);
  assert.equal(fake.all('wallets')[0].availableMinor, 3000);
  assert.equal(fake.all('ledger_transactions').length, 1);
});

test('concurrent checkout cannot double debit', async () => {
  const { fake, call, sync } = setup();
  fake.seed('products', 'p1', { title: 'Item', priceMinor: 2500, currency: 'USD', active: true });
  fake.seed('wallets', 'w_seed', { userId: 'u1', currency: 'USD', availableMinor: 5000, lockedMinor: 0, version: 1, updatedAt: new Date().toISOString(), id: 'w_seed' });
  const body = { userId: 'u1', currency: 'USD', shippingMinor: 0, idempotencyKey: '33333333-3333-4333-8333-333333333333', items: [{ productId: 'p1', quantity: 1 }] };
  const results = await Promise.all([
    sync.handle({ headers: {} }, 'POST', '/api/orders/checkout', body),
    sync.handle({ headers: {} }, 'POST', '/api/orders/checkout', body),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(fake.all('wallets')[0].availableMinor, 2500);
  assert.equal(fake.all('orders').length, 1);
});

test('buy trade checks server price and debits fees once', async () => {
  const { fake, call } = setup();
  fake.seed('wallets', 'w_seed', { userId: 'u1', currency: 'USD', availableMinor: 50000, lockedMinor: 0, version: 1, updatedAt: new Date().toISOString(), id: 'w_seed' });
  const body = { userId: 'u1', symbol: 'AAPL', side: 'buy', quantity: 2, currency: 'USD', idempotencyKey: '44444444-4444-4444-8444-444444444444' };
  const first = await call('/api/trades', body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.filledPrice, 100);
  assert.equal(first.body.notional.amountMinor, 20000);
  assert.equal(first.body.fees.amountMinor, 10);
  assert.equal(fake.all('wallets')[0].availableMinor, 29990);
  const replay = await call('/api/trades', body);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(fake.all('wallets')[0].availableMinor, 29990);
});

test('wallet transfer is idempotent and credits the recipient once', async () => {
  const { fake, call } = setup();
  fake.seed('wallets', 'w_from', { userId: 'u1', currency: 'USD', availableMinor: 10000, lockedMinor: 0, version: 1, updatedAt: new Date().toISOString(), id: 'w_from' });
  const body = { userId: 'u1', toUserId: 'u2', currency: 'USD', amountMinor: 2500, idempotencyKey: '55555555-5555-4555-8555-555555555555' };
  const first = await call('/api/wallet/transfer', body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await call('/api/wallet/transfer', body);
  assert.equal(replay.status, 200);
  const wallets = fake.all('wallets');
  assert.equal(wallets.find((w) => w.userId === 'u1').availableMinor, 7500);
  assert.equal(wallets.find((w) => w.userId === 'u2').availableMinor, 2500);
});

test('admin actions require the admin role', async () => {
  const { fake, call } = setup();
  fake.seed('users', 'u1', { displayName: 'User', email: 'u@x.com', role: 'user', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const denied = await call('/api/admin/users/action', {
    userId: 'u1', idempotencyKey: '66666666-6666-4666-8666-666666666666',
    action: { type: 'suspend', userId: 'u1' },
  });
  assert.equal(denied.status, 403);

  fake.seed('users', 'admin1', { displayName: 'Admin', email: 'a@x.com', role: 'admin', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const allowed = await call('/api/admin/users/action', {
    userId: 'admin1', idempotencyKey: '77777777-7777-4777-8777-777777777777',
    action: { type: 'suspend', userId: 'u1', reason: 'test' },
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(fake.get('users', 'u1').status, 'suspended');
});

test('an identity mismatch between session and body is rejected', async () => {
  const { sync } = setup();
  const result = await sync.handle(
    { headers: { 'x-appwrite-user-id': 'u2' } },
    'POST',
    '/api/messages',
    { userId: 'u1', conversationId: 'c1', body: 'x', idempotencyKey: '88888888-8888-4888-8888-888888888888' },
  );
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'identity_mismatch');
});
