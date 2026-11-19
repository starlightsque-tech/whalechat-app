import { z } from 'zod';
import type { StorageAdapter } from '../storage/adapter.js';
import { StorageKeys, STORAGE_SCHEMA_VERSION } from '../storage/keys.js';
import type { WhalechatStoreApi } from '../state/store.js';
import {
  AssetSchema,
  CartItemSchema,
  ConversationSchema,
  CandleSchema,
  LedgerTransactionSchema,
  MessageSchema,
  OrderSchema,
  PortfolioSchema,
  ProductSchema,
  QuoteSchema,
  TradeSchema,
  UserProfileSchema,
  WalletSchema,
} from '../types/index.js';
import type { Reservation } from './financial.js';

const ReservationArraySchema = z.array(
  z.object({
    walletId: z.string(),
    currency: z.string(),
    amountMinor: z.number().int(),
    ref: z.string(),
    status: z.enum(['held', 'committed', 'released']),
    createdAt: z.string(),
  }),
);

/** Boot from cache first: the UI must render instantly, even offline. */
export async function hydrateStore(storage: StorageAdapter, store: WhalechatStoreApi): Promise<void> {
  const read = async <T>(key: string, schema: z.ZodTypeAny): Promise<T | null> => {
    try {
      const raw = await storage.get<unknown>(key);
      if (raw === null) return null;
      const parsed = schema.safeParse(raw);
      return parsed.success ? (parsed.data as T) : null;
    } catch {
      return null;
    }
  };

  const profile = await read<import('../types/user.js').UserProfile>(StorageKeys.profile, UserProfileSchema);
  const wallet = await read<import('../types/user.js').Wallet>(StorageKeys.wallet, WalletSchema);
  const conversations = await read<import('../types/chat.js').Conversation[]>(StorageKeys.conversations, z.array(ConversationSchema));
  const products = await read<import('../types/shop.js').Product[]>(StorageKeys.products, z.array(ProductSchema));
  const cart = await read<import('../types/shop.js').CartItem[]>(StorageKeys.cart, z.array(CartItemSchema));
  const orders = await read<import('../types/shop.js').Order[]>(StorageKeys.orders, z.array(OrderSchema));
  const assets = await read<import('../types/trade.js').Asset[]>(StorageKeys.assets, z.array(AssetSchema));
  const quotes = await read<Record<string, import('../types/trade.js').Quote>>(StorageKeys.quotes, z.record(z.string(), QuoteSchema));
  const trades = await read<import('../types/trade.js').Trade[]>(StorageKeys.trades, z.array(TradeSchema));
  const portfolio = await read<import('../types/trade.js').Portfolio>(StorageKeys.portfolio, PortfolioSchema);
  const ledger = await read<import('../types/user.js').LedgerTransaction[]>(StorageKeys.ledger, z.array(LedgerTransactionSchema));
  const reservations = await read<Reservation[]>(StorageKeys.outbox + ':reservations', ReservationArraySchema);
  const lastSync = await storage.get<string>(StorageKeys.lastSync).catch(() => null);

  const messages: Record<string, import('../types/chat.js').Message[]> = {};
  const candles: Record<string, import('../types/trade.js').Candle[]> = {};
  for (const conversation of conversations ?? []) {
    const cached = await read<import('../types/chat.js').Message[]>(StorageKeys.messages(conversation.id), z.array(MessageSchema));
    if (cached) messages[conversation.id] = cached;
  }
  for (const asset of assets ?? []) {
    const cached = await read<import('../types/trade.js').Candle[]>(StorageKeys.candles(asset.symbol), z.array(CandleSchema));
    if (cached) candles[asset.symbol] = cached;
  }

  store.getState().hydrate({
    ...(profile ? { profile } : {}),
    ...(wallet ? { wallets: { [wallet.id]: wallet } } : {}),
    ...(conversations ? { conversations } : {}),
    ...(products ? { products } : {}),
    ...(cart ? { cart } : {}),
    ...(orders ? { orders } : {}),
    ...(assets ? { assets } : {}),
    ...(quotes ? { quotes } : {}),
    ...(trades ? { trades } : {}),
    ...(portfolio ? { portfolio } : {}),
    ...(ledger ? { ledger } : {}),
    ...(reservations ? { reservations } : {}),
    messages,
    candles,
    connection: {
      ...store.getState().connection,
      lastSyncedAt: lastSync ?? null,
    },
  });
}

/**
 * Debounced cache writer. Cache writes are best-effort and must never be on
 * the critical path of a mutation — the outbox row is written first.
 */
export function attachPersistence(storage: StorageAdapter, store: WhalechatStoreApi, debounceMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const flush = async (): Promise<void> => {
    const state = store.getState();
    const entries: Array<[string, unknown]> = [
      [StorageKeys.profile, state.profile],
      [StorageKeys.wallet, Object.values(state.wallets)[0] ?? null],
      [StorageKeys.conversations, state.conversations],
      [StorageKeys.products, state.products],
      [StorageKeys.cart, state.cart],
      [StorageKeys.orders, state.orders],
      [StorageKeys.assets, state.assets],
      [StorageKeys.quotes, state.quotes],
      [StorageKeys.trades, state.trades],
      [StorageKeys.portfolio, state.portfolio],
      [StorageKeys.ledger, state.ledger],
      [StorageKeys.outbox + ':reservations', state.reservations],
      [StorageKeys.schemaVersion, STORAGE_SCHEMA_VERSION],
    ];
    if (state.connection.lastSyncedAt) entries.push([StorageKeys.lastSync, state.connection.lastSyncedAt]);

    const messages = Object.entries(state.messages);
    const candles = Object.entries(state.candles);
    for (const [conversationId, list] of messages.slice(0, 40)) {
      entries.push([StorageKeys.messages(conversationId), list.slice(-300)]);
    }
    for (const [symbol, list] of candles.slice(0, 40)) {
      entries.push([StorageKeys.candles(symbol), list.slice(-500)]);
    }

    try {
      if (storage.setMany) await storage.setMany(entries);
      else for (const [key, value] of entries) await storage.set(key, value);
    } catch {
      /* a full disk or revoked quota must not break the app */
    }
    dirty = false;
  };

  const unsubscribe = store.subscribe(() => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (dirty) void flush();
    }, debounceMs);
  });

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    if (dirty) void flush();
  };
}
