/**
 * Appwrite collection contract for the three core domains.
 *
 * `scripts/provision-monorepo-appwrite.mjs` creates/updates exactly these
 * collections, attributes and indexes (idempotent — safe to re-run).
 */
export type AppwriteAttributeType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'datetime'
  | 'email'
  | 'url';

export interface AppwriteAttributeSchema {
  key: string;
  type: AppwriteAttributeType;
  required: boolean;
  size?: number;
  array?: boolean;
  default?: string | number | boolean;
}

export interface AppwriteIndexSchema {
  key: string;
  type: 'key' | 'unique' | 'fulltext';
  attributes: string[];
  orders?: Array<'ASC' | 'DESC'>;
}

export interface AppwriteCollectionSchema {
  id: string;
  name: string;
  description: string;
  attributes: AppwriteAttributeSchema[];
  indexes: AppwriteIndexSchema[];
}

const id: AppwriteAttributeSchema = { key: 'id', type: 'string', required: true, size: 128 };
const userId: AppwriteAttributeSchema = { key: 'userId', type: 'string', required: true, size: 64 };
const createdAt: AppwriteAttributeSchema = { key: 'createdAt', type: 'datetime', required: true };
const updatedAt: AppwriteAttributeSchema = { key: 'updatedAt', type: 'datetime', required: true };

export const usersCollection: AppwriteCollectionSchema = {
  id: 'users',
  name: 'Users',
  description: 'Public profile mirrored from Appwrite Auth, plus role and verification state.',
  attributes: [
    id,
    { key: 'displayName', type: 'string', required: true, size: 128 },
    { key: 'email', type: 'email', required: true },
    { key: 'phone', type: 'string', required: false, size: 32 },
    { key: 'phoneVerified', type: 'boolean', required: false, default: false },
    { key: 'avatarUrl', type: 'url', required: false, size: 2048 },
    { key: 'role', type: 'string', required: true, size: 16, default: 'user' },
    { key: 'status', type: 'string', required: true, size: 16, default: 'active' },
    createdAt,
    updatedAt,
  ],
  indexes: [
    { key: 'idx_email_unique', type: 'unique', attributes: ['email'] },
    { key: 'idx_role', type: 'key', attributes: ['role'] },
  ],
};

export const walletsCollection: AppwriteCollectionSchema = {
  id: 'wallets',
  name: 'Wallets',
  description: 'Authoritative balances in integer minor units. Locked is server-side escrow/hold.',
  attributes: [
    id,
    userId,
    { key: 'currency', type: 'string', required: true, size: 8 },
    { key: 'availableMinor', type: 'integer', required: true },
    { key: 'lockedMinor', type: 'integer', required: false, default: 0 },
    { key: 'version', type: 'integer', required: true, default: 0 },
    updatedAt,
  ],
  indexes: [
    { key: 'idx_user_currency_unique', type: 'unique', attributes: ['userId', 'currency'] },
    { key: 'idx_user', type: 'key', attributes: ['userId'] },
  ],
};

export const conversationsCollection: AppwriteCollectionSchema = {
  id: 'conversations',
  name: 'Conversations',
  description: '1:1 / group threads. updatedAt doubles as the realtime resync cursor.',
  attributes: [
    id,
    { key: 'kind', type: 'string', required: true, size: 16, default: 'direct' },
    { key: 'title', type: 'string', required: false, size: 200 },
    { key: 'participantIds', type: 'string', required: true, size: 64, array: true },
    { key: 'lastMessagePreview', type: 'string', required: false, size: 300 },
    { key: 'lastMessageAt', type: 'datetime', required: false },
    updatedAt,
  ],
  indexes: [
    // Appwrite cannot index array attributes; participant lookup uses contains().
    { key: 'idx_updated', type: 'key', attributes: ['updatedAt'], orders: ['DESC'] },
  ],
};

export const messagesCollection: AppwriteCollectionSchema = {
  id: 'messages',
  name: 'Messages',
  description: 'Message log with per-device idempotency and read receipts.',
  attributes: [
    id,
    { key: 'conversationId', type: 'string', required: true, size: 64 },
    { key: 'senderId', type: 'string', required: true, size: 64 },
    { key: 'body', type: 'string', required: false, size: 8192 },
    { key: 'attachments', type: 'string', required: false, size: 4096, array: true },
    { key: 'status', type: 'string', required: true, size: 16, default: 'sent' },
    { key: 'clientId', type: 'string', required: false, size: 64 },
    { key: 'readBy', type: 'string', required: false, size: 64, array: true },
    { key: 'replyToId', type: 'string', required: false, size: 64 },
    { key: 'idempotencyKey', type: 'string', required: true, size: 64 },
    createdAt,
    updatedAt,
    { key: 'deletedAt', type: 'datetime', required: false },
  ],
  indexes: [
    { key: 'idx_idempotency_unique', type: 'unique', attributes: ['idempotencyKey'] },
    { key: 'idx_conversation_created', type: 'key', attributes: ['conversationId', 'createdAt'], orders: ['ASC', 'DESC'] },
  ],
};

export const productsCollection: AppwriteCollectionSchema = {
  id: 'products',
  name: 'Products',
  description: 'Marketplace catalog. Prices are integer minor units.',
  attributes: [
    id,
    { key: 'sellerId', type: 'string', required: true, size: 64 },
    { key: 'title', type: 'string', required: true, size: 200 },
    { key: 'description', type: 'string', required: false, size: 8192 },
    { key: 'priceMinor', type: 'integer', required: true },
    { key: 'currency', type: 'string', required: true, size: 8, default: 'USD' },
    { key: 'compareAtMinor', type: 'integer', required: false },
    { key: 'imageUrl', type: 'string', required: false, size: 2048 },
    { key: 'category', type: 'string', required: true, size: 64 },
    { key: 'stock', type: 'integer', required: true, default: 0 },
    { key: 'rating', type: 'float', required: false, default: 0 },
    { key: 'tags', type: 'string', required: false, size: 64, array: true },
    { key: 'active', type: 'boolean', required: true, default: true },
    updatedAt,
  ],
  indexes: [
    { key: 'idx_active_category', type: 'key', attributes: ['active', 'category'] },
    { key: 'idx_updated', type: 'key', attributes: ['updatedAt'], orders: ['DESC'] },
  ],
};

export const ordersCollection: AppwriteCollectionSchema = {
  id: 'orders',
  name: 'Orders',
  description: 'Escrow orders. idempotencyKey has a UNIQUE index: retries cannot double-charge.',
  attributes: [
    id,
    userId,
    { key: 'items', type: 'string', required: true, size: 16384 },
    { key: 'subtotalMinor', type: 'integer', required: true },
    { key: 'shippingMinor', type: 'integer', required: true, default: 0 },
    { key: 'totalMinor', type: 'integer', required: true },
    { key: 'currency', type: 'string', required: true, size: 8 },
    { key: 'status', type: 'string', required: true, size: 24 },
    { key: 'idempotencyKey', type: 'string', required: true, size: 64 },
    { key: 'escrowHeld', type: 'boolean', required: true, default: false },
    { key: 'escrowReleaseAfter', type: 'datetime', required: false },
    { key: 'escrowReleasedAt', type: 'datetime', required: false },
    createdAt,
    updatedAt,
  ],
  indexes: [
    { key: 'idx_idempotency_unique', type: 'unique', attributes: ['idempotencyKey'] },
    { key: 'idx_user_created', type: 'key', attributes: ['userId', 'createdAt'], orders: ['ASC', 'DESC'] },
    { key: 'idx_status', type: 'key', attributes: ['status'] },
  ],
};

export const tradesCollection: AppwriteCollectionSchema = {
  id: 'trades',
  name: 'Trades',
  description: 'Equity/crypto/FX orders. Unique idempotencyKey enforces at-most-once execution.',
  attributes: [
    id,
    userId,
    { key: 'symbol', type: 'string', required: true, size: 16 },
    { key: 'side', type: 'string', required: true, size: 8 },
    { key: 'quantity', type: 'float', required: true },
    { key: 'limitPrice', type: 'float', required: false },
    { key: 'filledPrice', type: 'float', required: false },
    { key: 'status', type: 'string', required: true, size: 24 },
    { key: 'feesMinor', type: 'integer', required: true, default: 0 },
    { key: 'notionalMinor', type: 'integer', required: true },
    { key: 'currency', type: 'string', required: true, size: 8, default: 'USD' },
    { key: 'idempotencyKey', type: 'string', required: true, size: 64 },
    { key: 'offlineExecutionPrice', type: 'float', required: false },
    createdAt,
    updatedAt,
  ],
  indexes: [
    { key: 'idx_idempotency_unique', type: 'unique', attributes: ['idempotencyKey'] },
    { key: 'idx_user_created', type: 'key', attributes: ['userId', 'createdAt'], orders: ['ASC', 'DESC'] },
    { key: 'idx_symbol', type: 'key', attributes: ['symbol'] },
  ],
};

export const ledgerCollection: AppwriteCollectionSchema = {
  id: 'ledger_transactions',
  name: 'Ledger transactions',
  description: 'Immutable double-entry ledger. Every row is tied to one idempotencyKey.',
  attributes: [
    id,
    userId,
    { key: 'type', type: 'string', required: true, size: 24 },
    { key: 'amountMinor', type: 'integer', required: true },
    { key: 'currency', type: 'string', required: true, size: 8 },
    { key: 'balanceAfterMinor', type: 'integer', required: true },
    { key: 'referenceId', type: 'string', required: false, size: 64 },
    { key: 'idempotencyKey', type: 'string', required: true, size: 64 },
    { key: 'description', type: 'string', required: false, size: 500 },
    createdAt,
  ],
  indexes: [
    { key: 'idx_idempotency_unique', type: 'unique', attributes: ['idempotencyKey'] },
    { key: 'idx_user_created', type: 'key', attributes: ['userId', 'createdAt'], orders: ['ASC', 'DESC'] },
  ],
};

export const WHALECHAT_COLLECTIONS: AppwriteCollectionSchema[] = [
  usersCollection,
  walletsCollection,
  conversationsCollection,
  messagesCollection,
  productsCollection,
  ordersCollection,
  tradesCollection,
  ledgerCollection,
];
