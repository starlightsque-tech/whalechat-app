import { z } from 'zod';
import { StorageKeys, STORAGE_SCHEMA_VERSION } from '../storage/keys.js';
import { AssetSchema, CartItemSchema, ConversationSchema, CandleSchema, LedgerTransactionSchema, MessageSchema, OrderSchema, PortfolioSchema, ProductSchema, QuoteSchema, TradeSchema, UserProfileSchema, WalletSchema, } from '../types/index.js';
const ReservationArraySchema = z.array(z.object({
    walletId: z.string(),
    currency: z.string(),
    amountMinor: z.number().int(),
    ref: z.string(),
    status: z.enum(['held', 'committed', 'released']),
    createdAt: z.string(),
}));
/** Boot from cache first: the UI must render instantly, even offline. */
export async function hydrateStore(storage, store) {
    const read = async (key, schema) => {
        try {
            const raw = await storage.get(key);
            if (raw === null)
                return null;
            const parsed = schema.safeParse(raw);
            return parsed.success ? parsed.data : null;
        }
        catch {
            return null;
        }
    };
    const profile = await read(StorageKeys.profile, UserProfileSchema);
    const wallet = await read(StorageKeys.wallet, WalletSchema);
    const conversations = await read(StorageKeys.conversations, z.array(ConversationSchema));
    const products = await read(StorageKeys.products, z.array(ProductSchema));
    const cart = await read(StorageKeys.cart, z.array(CartItemSchema));
    const orders = await read(StorageKeys.orders, z.array(OrderSchema));
    const assets = await read(StorageKeys.assets, z.array(AssetSchema));
    const quotes = await read(StorageKeys.quotes, z.record(z.string(), QuoteSchema));
    const trades = await read(StorageKeys.trades, z.array(TradeSchema));
    const portfolio = await read(StorageKeys.portfolio, PortfolioSchema);
    const ledger = await read(StorageKeys.ledger, z.array(LedgerTransactionSchema));
    const reservations = await read(StorageKeys.outbox + ':reservations', ReservationArraySchema);
    const lastSync = await storage.get(StorageKeys.lastSync).catch(() => null);
    const messages = {};
    const candles = {};
    for (const conversation of conversations ?? []) {
        const cached = await read(StorageKeys.messages(conversation.id), z.array(MessageSchema));
        if (cached)
            messages[conversation.id] = cached;
    }
    for (const asset of assets ?? []) {
        const cached = await read(StorageKeys.candles(asset.symbol), z.array(CandleSchema));
        if (cached)
            candles[asset.symbol] = cached;
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
export function attachPersistence(storage, store, debounceMs = 300) {
    let timer = null;
    let dirty = false;
    const flush = async () => {
        const state = store.getState();
        const entries = [
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
        if (state.connection.lastSyncedAt)
            entries.push([StorageKeys.lastSync, state.connection.lastSyncedAt]);
        const messages = Object.entries(state.messages);
        const candles = Object.entries(state.candles);
        for (const [conversationId, list] of messages.slice(0, 40)) {
            entries.push([StorageKeys.messages(conversationId), list.slice(-300)]);
        }
        for (const [symbol, list] of candles.slice(0, 40)) {
            entries.push([StorageKeys.candles(symbol), list.slice(-500)]);
        }
        try {
            if (storage.setMany)
                await storage.setMany(entries);
            else
                for (const [key, value] of entries)
                    await storage.set(key, value);
        }
        catch {
            /* a full disk or revoked quota must not break the app */
        }
        dirty = false;
    };
    const unsubscribe = store.subscribe(() => {
        dirty = true;
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            if (dirty)
                void flush();
        }, debounceMs);
    });
    return () => {
        unsubscribe();
        if (timer)
            clearTimeout(timer);
        if (dirty)
            void flush();
    };
}
//# sourceMappingURL=persistence.js.map