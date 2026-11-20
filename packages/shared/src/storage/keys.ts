/** Every persisted cache key in one place (namespaced by the adapter). */
export const StorageKeys = {
  schemaVersion: 'meta:schemaVersion',
  session: 'session:current',
  profile: 'cache:profile',
  wallet: 'cache:wallet',
  conversations: 'cache:conversations',
  messages: (conversationId: string) => `cache:messages:${conversationId}`,
  products: 'cache:products',
  cart: 'cache:cart',
  orders: 'cache:orders',
  assets: 'cache:assets',
  quotes: 'cache:quotes',
  candles: (symbol: string) => `cache:candles:${symbol}`,
  portfolio: 'cache:portfolio',
  trades: 'cache:trades',
  ledger: 'cache:ledger',
  realtimeCursor: 'sync:realtime:cursor',
  outbox: 'sync:outbox',
  lastSync: 'sync:lastSync',
  failedOps: 'sync:failedOps',
} as const;

export const STORAGE_SCHEMA_VERSION = 1;
