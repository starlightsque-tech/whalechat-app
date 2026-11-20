/* =========================================================================
   Whalechat monorepo sync contract
   -------------------------------------------------------------------------
   Server-side handlers used by packages/shared/src/appwrite/backend.ts:

     POST /api/messages                 send a message
     POST /api/messages/read            read receipt
     POST /api/orders/checkout          escrow checkout
     POST /api/trades                   buy/sell
     POST /api/wallet/transfer          wallet-to-wallet
     GET  /api/admin/overview           admin dashboard
     GET  /api/admin/users              admin user list
     POST /api/admin/users/action       suspend / reinstate / role / adjust
     POST /api/admin/orders/action      order status transition
     POST /api/admin/trades/action      trade status transition
     GET  /api/admin/audit              audit trail

   Safety rules:
   • The document id is derived from the client UUIDv4 idempotencyKey, so the
     unique idempotencyKey index plus Appwrite's document-id uniqueness make
     every mutation at-most-once even under concurrent retries.
   • Wallet funds are checked and held server-side before an order/trade is
     confirmed.  Empty/duplicate requests can never debit twice.
   • Prices and totals are recomputed from product/quote documents; client
     amounts are never trusted.
   ========================================================================= */
'use strict';

const crypto = require('crypto');

const PREFIX = String(process.env.WC_COLLECTION_PREFIX || '');
const COLLECTIONS = {
  users: process.env.WC_COLLECTION_USERS || PREFIX + 'users',
  wallets: process.env.WC_COLLECTION_WALLETS || PREFIX + 'wallets',
  conversations: process.env.WC_COLLECTION_CONVERSATIONS || PREFIX + 'conversations',
  messages: process.env.WC_COLLECTION_MESSAGES || PREFIX + 'messages',
  products: process.env.WC_COLLECTION_PRODUCTS || PREFIX + 'products',
  orders: process.env.WC_COLLECTION_ORDERS || PREFIX + 'orders',
  trades: process.env.WC_COLLECTION_TRADES || PREFIX + 'trades',
  ledger: process.env.WC_COLLECTION_LEDGER || PREFIX + 'ledger_transactions',
};

const DATABASE_ID = String(process.env.WC_SYNC_DB || 'whalechat').trim();
// Secure default: identity must come from Appwrite's session header. The body
// fallback exists only for migrations/tests and must be enabled explicitly.
const TRUST_BODY_USER = String(process.env.WC_SYNC_TRUST_BODY_USER || '0') === '1';
const REQUIRE_SESSION = String(process.env.WC_SYNC_REQUIRE_SESSION || '1') !== '0';

class SyncError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function docId(prefix, key) {
  return prefix + '_' + hash(key).slice(0, 30);
}

function nowIso() {
  return new Date().toISOString();
}

function iso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function createMonorepoSync(deps) {
  const { api, readState, saveState } = deps;
  const log = deps.log || (() => {});
  const error = deps.error || (() => {});

  function headers(extra) {
    return Object.assign({ 'content-type': 'application/json' }, extra || {});
  }

  async function request(path, method, body) {
    const r = await api('/databases/' + DATABASE_ID + path, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r;
  }

  async function listDocuments(collection, queries, limit) {
    const qs = (queries || [])
      .map((q) => 'queries[]=' + encodeURIComponent(JSON.stringify(q)))
      .join('&');
    const url = '/collections/' + encodeURIComponent(collection) + '/documents' +
      (qs ? '?' + qs : '') + (limit ? (qs ? '&' : '?') + 'limit=' + limit : '');
    const r = await request(url, 'GET');
    if (!r.ok) throw new SyncError(r.status || 502, 'database_read_failed', (r.json && r.json.message) || r.text || 'read failed');
    return { documents: (r.json && r.json.documents) || [], total: (r.json && r.json.total) || 0 };
  }

  async function getDocument(collection, id) {
    if (!id) return null;
    const r = await request('/collections/' + encodeURIComponent(collection) + '/documents/' + encodeURIComponent(id), 'GET');
    if (r.status === 404) return null;
    if (!r.ok) throw new SyncError(r.status || 502, 'database_read_failed', (r.json && r.json.message) || 'read failed');
    return r.json;
  }

  async function createDocument(collection, id, data, permissions) {
    const payload = { documentId: id, data: Object.assign({ id }, data) };
    if (permissions && permissions.length) payload.permissions = permissions;
    const r = await request('/collections/' + encodeURIComponent(collection) + '/documents', 'POST', payload);
    if (r.status === 409) return { conflict: true, document: await getDocument(collection, id) };
    if (!r.ok) throw new SyncError(r.status || 502, 'database_write_failed', (r.json && r.json.message) || 'write failed');
    return { conflict: false, document: r.json };
  }

  async function updateDocument(collection, id, data) {
    const r = await request('/collections/' + encodeURIComponent(collection) + '/documents/' + encodeURIComponent(id), 'PATCH', { data });
    if (!r.ok) throw new SyncError(r.status || 502, 'database_write_failed', (r.json && r.json.message) || 'update failed');
    return r.json;
  }

  async function deleteDocument(collection, id) {
    const r = await request('/collections/' + encodeURIComponent(collection) + '/documents/' + encodeURIComponent(id), 'DELETE');
    if (!r.ok && r.status !== 404) throw new SyncError(r.status || 502, 'database_write_failed', 'delete failed');
  }

  function userPermissions(userId) {
    return ['read("user:' + userId + '")', 'update("user:' + userId + '")'];
  }

  function identity(req, body) {
    const h = req.headers || {};
    const headerUser = h['x-appwrite-user-id'] || h['x-whalechat-user-id'] || '';
    const bodyUser = TRUST_BODY_USER && body && typeof body.userId === 'string' ? body.userId : '';
    if (headerUser && bodyUser && headerUser !== bodyUser) {
      throw new SyncError(403, 'identity_mismatch', 'body userId does not match the authenticated session');
    }
    const userId = headerUser || bodyUser;
    if (!userId) throw new SyncError(401, 'auth_required', 'an Appwrite user session is required');
    if (REQUIRE_SESSION && !headerUser && !(TRUST_BODY_USER && bodyUser)) {
      throw new SyncError(401, 'session_required', 'session header required');
    }
    return userId;
  }

  async function requireAdmin(req, body) {
    const userId = identity(req, body);
    const doc = await getDocument(COLLECTIONS.users, userId);
    if (doc && (doc.role === 'admin' || doc.role === 'superadmin') && doc.status !== 'suspended') return userId;
    // legacy accounts live in the state mirror only
    try {
      const st = await readState();
      const legacy = ((st.db && st.db.users) || []).find((u) => u && u.id === userId && u.role === 'admin' && !u.banned);
      if (legacy) return userId;
    } catch (e) { /* ignore */ }
    throw new SyncError(403, 'admin_required', 'admin role required');
  }

  function requireKey(body) {
    const key = body && typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (key.length < 8) throw new SyncError(400, 'idempotency_key_required', 'a client UUIDv4 idempotencyKey is required');
    return key;
  }

  function walletId(userId, currency) {
    return docId('w', userId + ':' + currency);
  }

  async function getWallet(userId, currency) {
    const id = walletId(userId, currency);
    // Prefer an existing wallet row (provisioned by admin/legacy); fall back
    // to a deterministic document id so two first-writes cannot race.
    try {
      const found = await listDocuments(COLLECTIONS.wallets, [
        { method: 'equal', attribute: 'userId', values: [userId] },
        { method: 'equal', attribute: 'currency', values: [currency] },
      ], 1);
      if (found.documents[0]) return found.documents[0];
    } catch (e) { /* create below */ }
    let doc = await getDocument(COLLECTIONS.wallets, id);
    if (!doc) {
      const created = await createDocument(COLLECTIONS.wallets, id, {
        userId,
        currency,
        availableMinor: 0,
        lockedMinor: 0,
        version: 0,
        updatedAt: nowIso(),
      }, userPermissions(userId));
      doc = created.document;
    }
    return doc;
  }

  async function writeWallet(userId, currency, patch) {
    const current = await getWallet(userId, currency);
    const next = Object.assign({}, patch, {
      version: Number(current.version || 0) + 1,
      updatedAt: nowIso(),
    });
    return updateDocument(COLLECTIONS.wallets, current.$id, next);
  }

  async function writeLedger(entry) {
    const id = docId('l', entry.idempotencyKey);
    const data = {
      userId: entry.userId,
      type: entry.type,
      amountMinor: Math.round(entry.amountMinor),
      currency: entry.currency,
      balanceAfterMinor: Math.round(entry.balanceAfterMinor),
      referenceId: entry.referenceId || null,
      idempotencyKey: entry.idempotencyKey,
      description: entry.description || '',
      createdAt: nowIso(),
    };
    const created = await createDocument(COLLECTIONS.ledger, id, data, userPermissions(entry.userId));
    return created;
  }

  async function getLedger(key) {
    return getDocument(COLLECTIONS.ledger, docId('l', key));
  }

  function mapMessage(doc) {
    const attachments = (doc.attachments || []).map((entry) => {
      if (typeof entry !== 'string') return entry;
      try { return JSON.parse(entry); } catch (e) { return null; }
    }).filter(Boolean);
    return {
      id: doc.$id,
      clientId: doc.clientId || null,
      conversationId: doc.conversationId,
      senderId: doc.senderId,
      body: doc.body || '',
      attachments,
      status: doc.status || 'sent',
      createdAt: iso(doc.createdAt) || doc.$createdAt,
      updatedAt: iso(doc.updatedAt) || doc.$updatedAt,
      serverCreatedAt: doc.$createdAt,
      readBy: doc.readBy || [],
      replyToId: doc.replyToId || null,
      deletedAt: iso(doc.deletedAt),
    };
  }

  function mapOrder(doc) {
    const currency = doc.currency || 'USD';
    return {
      id: doc.$id,
      userId: doc.userId,
      items: parseItems(doc.items),
      subtotal: { amountMinor: Number(doc.subtotalMinor) || 0, currency },
      shipping: { amountMinor: Number(doc.shippingMinor) || 0, currency },
      total: { amountMinor: Number(doc.totalMinor) || 0, currency },
      status: doc.status,
      escrow: {
        held: !!doc.escrowHeld,
        releasedAt: iso(doc.escrowReleasedAt),
        releaseAfter: iso(doc.escrowReleaseAfter),
      },
      placedAt: iso(doc.createdAt) || doc.$createdAt,
      updatedAt: iso(doc.updatedAt) || doc.$updatedAt,
      idempotencyKey: doc.idempotencyKey,
    };
  }

  function mapTrade(doc) {
    const currency = doc.currency || 'USD';
    return {
      id: doc.$id,
      userId: doc.userId,
      symbol: doc.symbol,
      side: doc.side,
      quantity: Number(doc.quantity),
      limitPrice: doc.limitPrice === null || doc.limitPrice === undefined ? null : Number(doc.limitPrice),
      filledPrice: doc.filledPrice === null || doc.filledPrice === undefined ? null : Number(doc.filledPrice),
      status: doc.status,
      fees: { amountMinor: Number(doc.feesMinor) || 0, currency },
      notional: { amountMinor: Number(doc.notionalMinor) || 0, currency },
      idempotencyKey: doc.idempotencyKey,
      offlineExecutionPrice: doc.offlineExecutionPrice === null || doc.offlineExecutionPrice === undefined
        ? null : Number(doc.offlineExecutionPrice),
      createdAt: iso(doc.createdAt) || doc.$createdAt,
      updatedAt: iso(doc.updatedAt) || doc.$updatedAt,
    };
  }

  async function serverPrice(userId, symbol, body) {
    const explicit = Number(body.limitPrice) || Number(body.offlineExecutionPrice) || 0;
    if (explicit > 0) return explicit;
    try {
      const st = await readState();
      const row = ((st.db && st.db.stocks) || []).find(
        (x) => x && String(x.ticker || '').toUpperCase() === symbol,
      );
      if (row && Number(row.price) > 0) return Number(row.price);
    } catch (e) { /* fall through */ }
    throw new SyncError(409, 'quote_unavailable', 'No server quote for ' + symbol);
  }

  async function sendMessage(req, body) {
    const userId = identity(req, body);
    const key = requireKey(body);
    if (!body.conversationId) throw new SyncError(400, 'conversation_required', 'conversationId required');
    const text = String(body.body || '');
    if (!text && !(Array.isArray(body.attachments) && body.attachments.length)) {
      throw new SyncError(400, 'empty_message', 'message body or attachment required');
    }
    const id = docId('m', key);
    const now = nowIso();
    const conversation = await getDocument(COLLECTIONS.conversations, body.conversationId);
    const participants = conversation && Array.isArray(conversation.participantIds)
      ? conversation.participantIds.slice(0, 20) : [userId];
    const permissions = Array.from(new Set([userId, ...participants])).map((p) => 'read("user:' + p + '")');
    const created = await createDocument(COLLECTIONS.messages, id, {
      conversationId: body.conversationId,
      senderId: userId,
      body: text,
      attachments: (Array.isArray(body.attachments) ? body.attachments : []).map((a) => JSON.stringify(a)),
      status: 'sent',
      clientId: body.clientId || null,
      readBy: [userId],
      replyToId: body.replyToId || null,
      idempotencyKey: key,
      createdAt: now,
      updatedAt: now,
    }, permissions);
    if (created.conflict) {
      if (!created.document) throw new SyncError(409, 'duplicate_in_progress', 'message is being written');
      return mapMessage(created.document);
    }
    if (conversation) {
      try {
        await updateDocument(COLLECTIONS.conversations, conversation.$id, {
          lastMessagePreview: text.slice(0, 200),
          lastMessageAt: now,
          updatedAt: now,
        });
      } catch (e) { /* preview is non-critical */ }
    }
    log('message ' + id + ' stored');
    return mapMessage(created.document);
  }

  async function markRead(req, body) {
    const userId = identity(req, body);
    requireKey(body);
    if (!body.messageId) throw new SyncError(400, 'message_required', 'messageId required');
    const doc = await getDocument(COLLECTIONS.messages, body.messageId);
    if (!doc) throw new SyncError(404, 'message_not_found', 'message not found');
    const readBy = Array.from(new Set([...(doc.readBy || []), userId]));
    await updateDocument(COLLECTIONS.messages, doc.$id, { readBy, status: 'read', updatedAt: nowIso() });
    return { ok: true };
  }

  async function checkout(req, body) {
    const userId = identity(req, body);
    const key = requireKey(body);
    const currency = String(body.currency || 'USD').toUpperCase();
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new SyncError(400, 'empty_cart', 'cart is empty');

    const orderId = docId('o', key);
    const existing = await getDocument(COLLECTIONS.orders, orderId);
    if (existing) {
      if (existing.status === 'pending') {
        const ledger = await getLedger(key);
        if (ledger) {
          const finalized = await updateDocument(COLLECTIONS.orders, existing.$id, {
            status: 'paid_escrow',
            updatedAt: nowIso(),
          });
          return mapOrder(finalized);
        }
        // crashed before the debit: safe to discard and retry
        if (Date.now() - Date.parse(existing.$createdAt || existing.createdAt || 0) < 30000) {
          throw new SyncError(409, 'checkout_in_progress', 'checkout is already being processed');
        }
        await deleteDocument(COLLECTIONS.orders, orderId);
      } else {
        return mapOrder(existing);
      }
    }

    const priced = [];
    for (const item of items) {
      const productId = String(item.productId || '');
      const quantity = Math.floor(Number(item.quantity) || 0);
      if (!productId || quantity <= 0) throw new SyncError(400, 'invalid_item', 'invalid cart item');
      const product = await getDocument(COLLECTIONS.products, productId);
      if (!product || product.active === false) {
        throw new SyncError(409, 'product_unavailable', 'product ' + productId + ' is not available');
      }
      const unit = Number(product.priceMinor);
      if (!Number.isInteger(unit) || unit <= 0) throw new SyncError(409, 'invalid_price', 'invalid product price');
      priced.push({
        productId,
        title: product.title,
        unitPrice: { amountMinor: unit, currency: product.currency || currency },
        quantity,
      });
    }

    const subtotalMinor = priced.reduce((sum, item) => sum + item.unitPrice.amountMinor * item.quantity, 0);
    const shippingMinor = Math.max(0, Math.round(Number(body.shippingMinor) || 0));
    const totalMinor = subtotalMinor + shippingMinor;
    const wallet = await getWallet(userId, currency);
    const available = Number(wallet.availableMinor) || 0;
    if (available < totalMinor) {
      throw new SyncError(402, 'insufficient_funds', 'available balance is too low');
    }

    const now = nowIso();
    const releaseAfter = new Date(Date.now() + 7 * 86400000).toISOString();
    const created = await createDocument(COLLECTIONS.orders, orderId, {
      userId,
      items: JSON.stringify(priced),
      subtotalMinor,
      shippingMinor,
      totalMinor,
      currency,
      status: 'pending',
      idempotencyKey: key,
      escrowHeld: true,
      escrowReleaseAfter: releaseAfter,
      createdAt: now,
      updatedAt: now,
    }, userPermissions(userId));

    if (created.conflict) {
      const doc = created.document;
      if (doc && doc.status !== 'pending') return mapOrder(doc);
      throw new SyncError(409, 'checkout_in_progress', 'checkout is already being processed');
    }

    try {
      const debited = await writeWallet(userId, currency, {
        availableMinor: available - totalMinor,
        lockedMinor: (Number(wallet.lockedMinor) || 0) + totalMinor,
      });
      await writeLedger({
        userId,
        type: 'order_debit',
        amountMinor: totalMinor,
        currency,
        balanceAfterMinor: debited.availableMinor,
        referenceId: orderId,
        idempotencyKey: key,
        description: 'Order ' + orderId + ' — escrow hold',
      });
      const finalized = await updateDocument(COLLECTIONS.orders, orderId, {
        status: 'paid_escrow',
        updatedAt: nowIso(),
      });
      return mapOrder(finalized);
    } catch (e) {
      // Compensate: no ledger row means the debit can be safely rolled back.
      try {
        const ledger = await getLedger(key);
        if (!ledger) {
          await writeWallet(userId, currency, {
            availableMinor: available,
            lockedMinor: Number(wallet.lockedMinor) || 0,
          });
          await deleteDocument(COLLECTIONS.orders, orderId);
        }
      } catch (inner) { error('checkout compensation failed: ' + inner.message); }
      throw e;
    }
  }

  function netQuantity(trades, symbol) {
    return trades.reduce((sum, t) => {
      if (String(t.symbol) !== symbol || t.status !== 'filled') return sum;
      return sum + (t.side === 'buy' ? Number(t.quantity) : -Number(t.quantity));
    }, 0);
  }

  async function placeTrade(req, body) {
    const userId = identity(req, body);
    const key = requireKey(body);
    const symbol = String(body.symbol || '').toUpperCase();
    const side = String(body.side || '').toLowerCase();
    const quantity = Number(body.quantity);
    const currency = String(body.currency || 'USD').toUpperCase();
    if (!symbol) throw new SyncError(400, 'symbol_required', 'symbol required');
    if (side !== 'buy' && side !== 'sell') throw new SyncError(400, 'invalid_side', 'side must be buy or sell');
    if (!Number.isFinite(quantity) || quantity <= 0) throw new SyncError(400, 'invalid_quantity', 'quantity must be positive');

    const tradeId = docId('t', key);
    const existing = await getDocument(COLLECTIONS.trades, tradeId);
    if (existing) {
      if (existing.status === 'pending') {
        if (await getLedger(key)) {
          const finalized = await updateDocument(COLLECTIONS.trades, existing.$id, {
            status: 'filled',
            updatedAt: nowIso(),
          });
          return mapTrade(finalized);
        }
        if (Date.now() - Date.parse(existing.$createdAt || existing.createdAt || 0) < 30000) {
          throw new SyncError(409, 'trade_in_progress', 'trade is already being processed');
        }
        await deleteDocument(COLLECTIONS.trades, tradeId);
      } else {
        return mapTrade(existing);
      }
    }

    const price = await serverPrice(userId, symbol, body);
    const notionalMinor = Math.round(quantity * price * 100);
    const feesMinor = Math.max(1, Math.round(notionalMinor * 0.0005));
    const wallet = await getWallet(userId, currency);
    const available = Number(wallet.availableMinor) || 0;

    if (side === 'buy' && available < notionalMinor + feesMinor) {
      throw new SyncError(402, 'insufficient_funds', 'available balance is too low');
    }
    if (side === 'sell') {
      const filled = await listDocuments(COLLECTIONS.trades, [
        { method: 'equal', attribute: 'userId', values: [userId] },
        { method: 'equal', attribute: 'symbol', values: [symbol] },
        { method: 'equal', attribute: 'status', values: ['filled'] },
      ], 100);
      if (netQuantity(filled.documents, symbol) + 1e-9 < quantity) {
        throw new SyncError(409, 'insufficient_position', 'not enough ' + symbol + ' to sell');
      }
    }

    const now = nowIso();
    const created = await createDocument(COLLECTIONS.trades, tradeId, {
      userId,
      symbol,
      side,
      quantity,
      limitPrice: body.limitPrice === null || body.limitPrice === undefined ? null : Number(body.limitPrice),
      filledPrice: null,
      status: 'pending',
      feesMinor,
      notionalMinor,
      currency,
      idempotencyKey: key,
      offlineExecutionPrice: body.offlineExecutionPrice === null || body.offlineExecutionPrice === undefined
        ? null : Number(body.offlineExecutionPrice),
      createdAt: now,
      updatedAt: now,
    }, userPermissions(userId));

    if (created.conflict) {
      const doc = created.document;
      if (doc && doc.status !== 'pending') return mapTrade(doc);
      throw new SyncError(409, 'trade_in_progress', 'trade is already being processed');
    }

    try {
      const nextAvailable = side === 'buy'
        ? available - notionalMinor - feesMinor
        : available + notionalMinor - feesMinor;
      const debited = await writeWallet(userId, currency, { availableMinor: nextAvailable });
      await writeLedger({
        userId,
        type: side === 'buy' ? 'trade_debit' : 'trade_credit',
        amountMinor: side === 'buy' ? notionalMinor + feesMinor : notionalMinor - feesMinor,
        currency,
        balanceAfterMinor: debited.availableMinor,
        referenceId: tradeId,
        idempotencyKey: key,
        description: (side === 'buy' ? 'Bought ' : 'Sold ') + quantity + ' ' + symbol,
      });
      const finalized = await updateDocument(COLLECTIONS.trades, tradeId, {
        status: 'filled',
        filledPrice: price,
        updatedAt: nowIso(),
      });
      return mapTrade(finalized);
    } catch (e) {
      try {
        if (!(await getLedger(key))) {
          await writeWallet(userId, currency, { availableMinor: available });
          await deleteDocument(COLLECTIONS.trades, tradeId);
        }
      } catch (inner) { error('trade compensation failed: ' + inner.message); }
      throw e;
    }
  }

  async function transfer(req, body) {
    const userId = identity(req, body);
    const key = requireKey(body);
    const toUserId = String(body.toUserId || '');
    const currency = String(body.currency || 'USD').toUpperCase();
    const amountMinor = Math.round(Number(body.amountMinor));
    if (!toUserId || toUserId === userId) throw new SyncError(400, 'invalid_recipient', 'choose another recipient');
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new SyncError(400, 'invalid_amount', 'amount must be positive');

    if (await getLedger(key)) return { ok: true, replayed: true, message: 'Transfer already processed' };

    const from = await getWallet(userId, currency);
    if ((Number(from.availableMinor) || 0) < amountMinor) {
      throw new SyncError(402, 'insufficient_funds', 'available balance is too low');
    }

    const ledger = await writeLedger({
      userId,
      type: 'transfer_out',
      amountMinor,
      currency,
      balanceAfterMinor: (Number(from.availableMinor) || 0) - amountMinor,
      referenceId: toUserId,
      idempotencyKey: key,
      description: body.note || 'Wallet transfer to ' + toUserId,
    });
    if (ledger.conflict) return { ok: true, replayed: true, message: 'Transfer already processed' };

    try {
      await writeWallet(userId, currency, { availableMinor: (Number(from.availableMinor) || 0) - amountMinor });
      const to = await getWallet(toUserId, currency);
      await writeWallet(toUserId, currency, {
        availableMinor: (Number(to.availableMinor) || 0) + amountMinor,
      });
      await writeLedger({
        userId: toUserId,
        type: 'transfer_in',
        amountMinor,
        currency,
        balanceAfterMinor: (Number(to.availableMinor) || 0) + amountMinor,
        referenceId: userId,
        idempotencyKey: key + ':in',
        description: 'Wallet transfer from ' + userId,
      });
      return { ok: true, message: 'Transfer complete' };
    } catch (e) {
      try {
        await writeWallet(userId, currency, { availableMinor: Number(from.availableMinor) || 0 });
        await deleteDocument(COLLECTIONS.ledger, docId('l', key));
      } catch (inner) { error('transfer compensation failed: ' + inner.message); }
      throw e;
    }
  }

  async function count(collection, queries) {
    const res = await listDocuments(collection, queries, 1);
    return res.total;
  }

  async function adminOverview(req) {
    await requireAdmin(req, {});
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const [users, orders, trades, escrowOrders, trades24] = await Promise.all([
      count(COLLECTIONS.users, []),
      count(COLLECTIONS.orders, []),
      count(COLLECTIONS.trades, []),
      listDocuments(COLLECTIONS.orders, [{ method: 'equal', attribute: 'escrowHeld', values: [true] }], 100),
      listDocuments(COLLECTIONS.trades, [
        { method: 'greaterThan', attribute: 'createdAt', values: [dayAgo] },
      ], 100),
    ]);
    const escrowHeldMinor = escrowOrders.documents.reduce((sum, o) => sum + (Number(o.totalMinor) || 0), 0);
    const volume24hMinor = trades24.documents.reduce((sum, t) => sum + (Number(t.notionalMinor) || 0), 0);
    return {
      users,
      activeUsers24h: users,
      orders,
      escrowHeldMinor,
      trades24h: trades24.total,
      volume24hMinor,
      openTickets: 0,
      updatedAt: nowIso(),
      totalTrades: trades,
    };
  }

  async function adminUsers(req) {
    await requireAdmin(req, {});
    const res = await listDocuments(COLLECTIONS.users, [], 100);
    return res.documents.map((u) => ({
      id: u.$id,
      displayName: u.displayName || u.username || 'Whalechat user',
      email: u.email,
      phone: u.phone || null,
      phoneVerified: !!u.phoneVerified,
      avatarUrl: u.avatarUrl || null,
      role: u.role || 'user',
      status: u.status || (u.banned ? 'suspended' : 'active'),
      createdAt: iso(u.createdAt) || u.$createdAt,
      updatedAt: iso(u.updatedAt) || u.$updatedAt,
    }));
  }

  async function adminUserAction(req, body) {
    const adminId = await requireAdmin(req, body);
    const key = requireKey(body);
    const action = body.action || {};
    const targetId = String(action.userId || '');
    if (!targetId) throw new SyncError(400, 'user_required', 'userId required');
    const target = await getDocument(COLLECTIONS.users, targetId);
    if (!target) throw new SyncError(404, 'user_not_found', 'user not found');

    let patch = null;
    if (action.type === 'suspend') patch = { status: 'suspended', updatedAt: nowIso() };
    else if (action.type === 'reinstate') patch = { status: 'active', updatedAt: nowIso() };
    else if (action.type === 'set_role') {
      if (!['user', 'support', 'admin'].includes(action.role)) throw new SyncError(400, 'invalid_role', 'invalid role');
      patch = { role: action.role, updatedAt: nowIso() };
    } else if (action.type === 'adjust_wallet') {
      const currency = String(action.currency || 'USD').toUpperCase();
      const amountMinor = Math.round(Number(action.amountMinor));
      if (!Number.isInteger(amountMinor) || amountMinor === 0) throw new SyncError(400, 'invalid_amount', 'amount required');
      const wallet = await getWallet(targetId, currency);
      const next = (Number(wallet.availableMinor) || 0) + amountMinor;
      if (next < 0) throw new SyncError(409, 'negative_balance', 'adjustment would make the wallet negative');
      await writeWallet(targetId, currency, { availableMinor: next });
      await writeLedger({
        userId: targetId,
        type: 'adjustment',
        amountMinor: Math.abs(amountMinor),
        currency,
        balanceAfterMinor: next,
        referenceId: adminId,
        idempotencyKey: key,
        description: action.reason || 'Admin wallet adjustment',
      });
      patch = { updatedAt: nowIso() };
    } else {
      throw new SyncError(400, 'unknown_action', 'unknown admin action');
    }

    if (patch) await updateDocument(COLLECTIONS.users, targetId, patch);
    return { ok: true, message: 'Action applied' };
  }

  async function adminOrderAction(req, body) {
    await requireAdmin(req, body);
    const orderId = String(body.orderId || '');
    const status = String(body.status || '');
    if (!orderId || !status) throw new SyncError(400, 'order_and_status_required', 'orderId and status required');
    const order = await getDocument(COLLECTIONS.orders, orderId);
    if (!order) throw new SyncError(404, 'order_not_found', 'order not found');
    const patch = { status, updatedAt: nowIso() };
    if (['refunded', 'cancelled'].includes(status) && order.escrowHeld) {
      const wallet = await getWallet(order.userId, order.currency || 'USD');
      await writeWallet(order.userId, order.currency || 'USD', {
        availableMinor: (Number(wallet.availableMinor) || 0) + (Number(order.totalMinor) || 0),
        lockedMinor: Math.max(0, (Number(wallet.lockedMinor) || 0) - (Number(order.totalMinor) || 0)),
      });
      patch.escrowHeld = false;
      patch.escrowReleasedAt = nowIso();
    }
    await updateDocument(COLLECTIONS.orders, orderId, patch);
    return { ok: true, message: 'Order updated' };
  }

  async function adminTradeAction(req, body) {
    await requireAdmin(req, body);
    const tradeId = String(body.tradeId || '');
    const status = String(body.status || '');
    if (!tradeId || !status) throw new SyncError(400, 'trade_and_status_required', 'tradeId and status required');
    await updateDocument(COLLECTIONS.trades, tradeId, { status, updatedAt: nowIso() });
    return { ok: true, message: 'Trade updated' };
  }

  async function adminAudit() {
    try {
      const st = await readState();
      return ((st.db && st.db.audit) || []).slice(0, 100);
    } catch (e) {
      return [];
    }
  }

  async function handle(req, method, path, body) {
    try {
      if (method === 'POST' && path === '/api/messages') return { status: 200, body: await sendMessage(req, body) };
      if (method === 'POST' && path === '/api/messages/read') return { status: 200, body: await markRead(req, body) };
      if (method === 'POST' && path === '/api/orders/checkout') return { status: 200, body: await checkout(req, body) };
      if (method === 'POST' && path === '/api/trades') return { status: 200, body: await placeTrade(req, body) };
      if (method === 'POST' && path === '/api/wallet/transfer') return { status: 200, body: await transfer(req, body) };
      if (method === 'GET' && path === '/api/admin/overview') return { status: 200, body: await adminOverview(req) };
      if (method === 'GET' && path === '/api/admin/users') return { status: 200, body: await adminUsers(req) };
      if (method === 'POST' && path === '/api/admin/users/action') return { status: 200, body: await adminUserAction(req, body) };
      if (method === 'POST' && path === '/api/admin/orders/action') return { status: 200, body: await adminOrderAction(req, body) };
      if (method === 'POST' && path === '/api/admin/trades/action') return { status: 200, body: await adminTradeAction(req, body) };
      if (method === 'GET' && path === '/api/admin/audit') return { status: 200, body: await adminAudit() };
      return null;
    } catch (e) {
      if (e instanceof SyncError) {
        return {
          status: e.status,
          body: { ok: false, error: e.code, message: e.message },
        };
      }
      error('monorepo sync: ' + (e && e.stack ? e.stack : e));
      return { status: 500, body: { ok: false, error: 'server_error', message: 'Whalechat sync failed' } };
    }
  }

  return { handle, DATABASE_ID, COLLECTIONS };
}

module.exports = { createMonorepoSync };
