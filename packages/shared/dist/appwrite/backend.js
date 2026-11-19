import { z } from 'zod';
import { WhalechatError } from '../utils/errors.js';
import { defaultAppwriteConfig } from './transport.js';
import { ConversationSchema, MessageSchema, OrderSchema, PortfolioSchema, ProductSchema, QuoteSchema, TradeSchema, UserProfileSchema, WalletSchema, } from '../types/index.js';
const CandleListSchema = z.array(z.object({
    time: z.number(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number().optional().default(0),
}));
function q(method, attribute, values) {
    return JSON.stringify({ method, attribute, values });
}
const equal = (attr, ...values) => q('equal', attr, values);
const orderDesc = (attr) => q('orderDesc', attr, []);
const orderAsc = (attr) => q('orderAsc', attr, []);
const limit = (n) => q('limit', '', [n]);
const cursorAfter = (id) => q('cursorAfter', '', [id]);
/**
 * Appwrite implementation of the shared backend contract.
 *
 * Reads go straight to Databases (fast, realtime-friendly); every mutation
 * goes through the `whalechat-sync` Function so the server can enforce the
 * unique idempotency index and perform atomic wallet/escrow ledger writes.
 */
export function createAppwriteBackend(options) {
    const config = {
        ...defaultAppwriteConfig,
        ...options.config,
        collections: { ...defaultAppwriteConfig.collections, ...options.config?.collections },
    };
    const { client, userId } = options;
    const db = config.databaseId;
    const col = config.collections;
    async function execute(path, method, body) {
        let execution;
        try {
            execution = await client.functions.createExecution(config.functionId, body === undefined ? '' : JSON.stringify(body), false, path, method, { 'content-type': 'application/json' });
        }
        catch (error) {
            throw new WhalechatError(`Sync function unreachable: ${error instanceof Error ? error.message : String(error)}`, 'retryable', 'SYNC_UNREACHABLE');
        }
        const status = execution.responseStatusCode ?? Number(execution.status === 'completed' ? 200 : 500);
        let parsed = null;
        try {
            parsed = execution.responseBody ? JSON.parse(execution.responseBody) : null;
        }
        catch {
            parsed = execution.responseBody;
        }
        if (status >= 400) {
            const message = parsed && typeof parsed === 'object' && 'message' in parsed
                ? String(parsed.message)
                : execution.errors || `Sync function returned ${status}`;
            const kind = status === 409 ? 'conflict' : status >= 500 || status === 429 ? 'retryable' : 'permanent';
            throw new WhalechatError(message, kind, `SYNC_${status}`);
        }
        return parsed;
    }
    function docData(doc) {
        return doc;
    }
    function mapMessage(doc) {
        const data = docData(doc);
        const rawAttachments = Array.isArray(data.attachments) ? data.attachments : [];
        const attachments = rawAttachments.flatMap((entry) => {
            if (typeof entry !== 'string')
                return [];
            try {
                return [JSON.parse(entry)];
            }
            catch {
                return [];
            }
        });
        return MessageSchema.parse({
            id: doc.$id,
            clientId: data.clientId ?? null,
            conversationId: data.conversationId,
            senderId: data.senderId,
            body: data.body ?? '',
            attachments,
            status: data.status ?? 'sent',
            createdAt: data.createdAt ?? doc.$createdAt,
            updatedAt: data.updatedAt ?? doc.$updatedAt,
            serverCreatedAt: doc.$createdAt,
            readBy: Array.isArray(data.readBy) ? data.readBy : [],
            replyToId: data.replyToId ?? null,
            deletedAt: data.deletedAt ?? null,
        });
    }
    function mapProduct(doc) {
        const d = docData(doc);
        return ProductSchema.parse({
            id: doc.$id,
            sellerId: d.sellerId,
            title: d.title,
            description: d.description ?? '',
            price: { amountMinor: d.priceMinor, currency: d.currency ?? 'USD' },
            compareAtPrice: typeof d.compareAtMinor === 'number' ? { amountMinor: d.compareAtMinor, currency: d.currency ?? 'USD' } : null,
            imageUrl: d.imageUrl ?? '',
            category: d.category ?? 'general',
            stock: d.stock ?? 0,
            rating: d.rating ?? 0,
            tags: Array.isArray(d.tags) ? d.tags : [],
            active: d.active ?? true,
            updatedAt: d.updatedAt ?? doc.$updatedAt,
        });
    }
    function mapWallet(doc) {
        return WalletSchema.parse({
            id: doc.$id,
            userId: docData(doc).userId,
            balances: docData(doc).balances ?? { USD: 0 },
            locked: docData(doc).locked ?? {},
            version: docData(doc).version ?? 0,
            updatedAt: docData(doc).updatedAt ?? doc.$updatedAt,
        });
    }
    const backend = {
        mode: 'appwrite',
        auth: {
            async getProfile() {
                const doc = await client.databases.getDocument(db, col.users, userId);
                return UserProfileSchema.parse({
                    ...docData(doc),
                    id: doc.$id,
                    createdAt: docData(doc).createdAt ?? doc.$createdAt,
                    updatedAt: docData(doc).updatedAt ?? doc.$updatedAt,
                });
            },
            async updateProfile(patch) {
                const doc = await client.databases.updateDocument(db, col.users, userId, patch);
                return UserProfileSchema.parse({
                    ...docData(doc),
                    id: doc.$id,
                    createdAt: docData(doc).createdAt ?? doc.$createdAt,
                    updatedAt: docData(doc).updatedAt ?? doc.$updatedAt,
                });
            },
        },
        chat: {
            async listConversations() {
                const res = await client.databases.listDocuments(db, col.conversations, [
                    equal('participantIds', userId),
                    orderDesc('updatedAt'),
                    limit(100),
                ]);
                return res.documents.map((doc) => ConversationSchema.parse({
                    id: doc.$id,
                    kind: docData(doc).kind ?? 'direct',
                    title: docData(doc).title ?? null,
                    participantIds: docData(doc).participantIds ?? [userId],
                    lastMessagePreview: docData(doc).lastMessagePreview ?? '',
                    lastMessageAt: docData(doc).lastMessageAt ?? null,
                    unreadCount: docData(doc).unreadCount ?? 0,
                    updatedAt: docData(doc).updatedAt ?? doc.$updatedAt,
                }));
            },
            async listMessages(conversationId, cursor) {
                const queries = [equal('conversationId', conversationId), orderDesc('createdAt'), limit(50)];
                if (cursor)
                    queries.push(cursorAfter(cursor));
                const res = await client.databases.listDocuments(db, col.messages, queries);
                const items = res.documents.map(mapMessage).reverse();
                return { items, nextCursor: res.documents.at(-1)?.$id ?? null, hasMore: res.total > queries.length };
            },
            async sendMessage(input, meta) {
                const raw = await execute('/api/messages', 'POST', {
                    ...input,
                    idempotencyKey: meta.idempotencyKey,
                    clientTimestamp: meta.clientTimestamp,
                });
                return MessageSchema.parse(raw);
            },
            async markRead(conversationId, messageId, meta) {
                return execute('/api/messages/read', 'POST', {
                    conversationId,
                    messageId,
                    idempotencyKey: meta.idempotencyKey,
                    clientTimestamp: meta.clientTimestamp,
                });
            },
        },
        shop: {
            async listProducts() {
                const res = await client.databases.listDocuments(db, col.products, [
                    equal('active', true),
                    orderDesc('updatedAt'),
                    limit(100),
                ]);
                return res.documents.map(mapProduct);
            },
            async listOrders() {
                const res = await client.databases.listDocuments(db, col.orders, [
                    equal('userId', userId),
                    orderDesc('createdAt'),
                    limit(100),
                ]);
                return res.documents.map((doc) => {
                    const d = docData(doc);
                    return OrderSchema.parse({
                        id: doc.$id,
                        userId: d.userId,
                        items: typeof d.items === 'string' ? JSON.parse(d.items) : d.items,
                        subtotal: { amountMinor: d.subtotalMinor, currency: d.currency },
                        shipping: { amountMinor: d.shippingMinor ?? 0, currency: d.currency },
                        total: { amountMinor: d.totalMinor, currency: d.currency },
                        status: d.status,
                        escrow: {
                            held: d.escrowHeld ?? false,
                            releasedAt: d.escrowReleasedAt ?? null,
                            releaseAfter: d.escrowReleaseAfter ?? null,
                        },
                        placedAt: d.createdAt ?? doc.$createdAt,
                        updatedAt: d.updatedAt ?? doc.$updatedAt,
                        idempotencyKey: d.idempotencyKey,
                    });
                });
            },
            async placeOrder(input, meta) {
                const raw = await execute('/api/orders/checkout', 'POST', {
                    ...input,
                    idempotencyKey: meta.idempotencyKey,
                    clientTimestamp: meta.clientTimestamp,
                });
                return OrderSchema.parse(raw);
            },
        },
        trade: {
            async listAssets() {
                const collection = col.assets ?? 'assets';
                const res = await client.databases.listDocuments(db, collection, [limit(500)]);
                return res.documents.map((doc) => {
                    const d = docData(doc);
                    return {
                        symbol: String(d.symbol ?? doc.$id).toUpperCase(),
                        name: String(d.name ?? d.symbol ?? doc.$id),
                        exchange: String(d.exchange ?? 'NASDAQ'),
                        assetClass: (d.assetClass ?? 'equity'),
                        currency: String(d.currency ?? 'USD'),
                        logoUrl: String(d.logoUrl ?? ''),
                        sector: String(d.sector ?? ''),
                        active: d.active !== false,
                        updatedAt: String(d.updatedAt ?? doc.$updatedAt),
                    };
                });
            },
            async getQuotes(symbols) {
                const raw = await execute(`/api/market/quotes?symbols=${encodeURIComponent(symbols.join(','))}`, 'GET');
                return z.array(QuoteSchema).parse(raw);
            },
            async getCandles(symbol, range = '1D') {
                const raw = await execute(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&range=${range}`, 'GET');
                return CandleListSchema.parse(raw);
            },
            async listTrades() {
                const res = await client.databases.listDocuments(db, col.trades, [
                    equal('userId', userId),
                    orderDesc('createdAt'),
                    limit(100),
                ]);
                return res.documents.map((doc) => {
                    const d = docData(doc);
                    return TradeSchema.parse({
                        id: doc.$id,
                        userId: d.userId,
                        symbol: d.symbol,
                        side: d.side,
                        quantity: d.quantity,
                        limitPrice: d.limitPrice ?? null,
                        filledPrice: d.filledPrice ?? null,
                        status: d.status,
                        fees: { amountMinor: d.feesMinor ?? 0, currency: d.currency ?? 'USD' },
                        notional: { amountMinor: d.notionalMinor, currency: d.currency ?? 'USD' },
                        idempotencyKey: d.idempotencyKey,
                        offlineExecutionPrice: d.offlineExecutionPrice ?? null,
                        createdAt: d.createdAt ?? doc.$createdAt,
                        updatedAt: d.updatedAt ?? doc.$updatedAt,
                    });
                });
            },
            async getPortfolio() {
                const raw = await execute('/api/portfolio', 'GET');
                return PortfolioSchema.parse(raw);
            },
            async placeTrade(input, meta) {
                const raw = await execute('/api/trades', 'POST', {
                    ...input,
                    idempotencyKey: meta.idempotencyKey,
                    clientTimestamp: meta.clientTimestamp,
                    offlineExecutionPrice: meta.offlineExecutionPrice ?? null,
                });
                return TradeSchema.parse(raw);
            },
        },
        wallet: {
            async getWallet() {
                const res = await client.databases.listDocuments(db, col.wallets, [equal('userId', userId), limit(10)]);
                const docs = res.documents;
                if (docs.length === 0)
                    throw new WhalechatError('Wallet not provisioned', 'permanent', 'NO_WALLET');
                const balances = {};
                const locked = {};
                for (const doc of docs) {
                    const d = docData(doc);
                    const currency = String(d.currency ?? 'USD').toUpperCase();
                    balances[currency] = (balances[currency] ?? 0) + Number(d.availableMinor ?? 0);
                    locked[currency] = (locked[currency] ?? 0) + Number(d.lockedMinor ?? 0);
                }
                const first = docs[0];
                return mapWallet({ ...first, balances, locked, userId });
            },
            async listLedger(cursor) {
                const queries = [equal('userId', userId), orderDesc('createdAt'), limit(50)];
                if (cursor)
                    queries.push(cursorAfter(cursor));
                const res = await client.databases.listDocuments(db, col.ledger, queries);
                const items = res.documents.map((doc) => {
                    const d = docData(doc);
                    return {
                        id: doc.$id,
                        userId: d.userId,
                        type: d.type,
                        amount: { amountMinor: d.amountMinor, currency: d.currency },
                        balanceAfterMinor: d.balanceAfterMinor,
                        referenceId: d.referenceId ?? null,
                        idempotencyKey: d.idempotencyKey,
                        description: d.description ?? '',
                        createdAt: d.createdAt ?? doc.$createdAt,
                    };
                });
                return { items, nextCursor: res.documents.at(-1)?.$id ?? null, hasMore: res.total > items.length };
            },
            async transfer(input, meta) {
                return execute('/api/wallet/transfer', 'POST', {
                    ...input,
                    idempotencyKey: meta.idempotencyKey,
                    clientTimestamp: meta.clientTimestamp,
                });
            },
        },
        admin: {
            async overview() {
                return execute('/api/admin/overview', 'GET');
            },
            async listUsers() {
                const res = await client.databases.listDocuments(db, col.users, [orderDesc('createdAt'), limit(100)]);
                return res.documents.map((doc) => UserProfileSchema.parse({
                    ...docData(doc),
                    id: doc.$id,
                    createdAt: docData(doc).createdAt ?? doc.$createdAt,
                    updatedAt: docData(doc).updatedAt ?? doc.$updatedAt,
                }));
            },
            async act(action, meta) {
                return execute('/api/admin/users/action', 'POST', {
                    action,
                    idempotencyKey: meta.idempotencyKey,
                    clientTimestamp: meta.clientTimestamp,
                });
            },
            async audit() {
                return execute('/api/admin/audit', 'GET');
            },
        },
        realtime: {
            subscribeQuotes(symbols, onQuote) {
                let closed = false;
                let unsub = null;
                if (client.realtime) {
                    try {
                        unsub = client.realtime.subscribe([`databases.${db}.collections.${col.assets ?? 'assets'}.documents`], (event) => {
                            const payload = event.payload;
                            const symbol = String(payload.symbol ?? '').toUpperCase();
                            if (!symbols.includes(symbol))
                                return;
                            const parsed = QuoteSchema.safeParse({
                                ...payload,
                                symbol,
                                asOf: payload.asOf ?? new Date().toISOString(),
                                updatedAt: payload.updatedAt ?? new Date().toISOString(),
                            });
                            if (parsed.success)
                                onQuote(parsed.data);
                        });
                    }
                    catch {
                        unsub = null;
                    }
                }
                const timer = setInterval(() => {
                    if (closed)
                        return;
                    void backend.trade
                        .getQuotes(symbols)
                        .then((quotes) => quotes.forEach(onQuote))
                        .catch(() => undefined);
                }, 10_000);
                return () => {
                    closed = true;
                    clearInterval(timer);
                    unsub?.();
                };
            },
            subscribeMessages(conversationId, onMessage) {
                if (!client.realtime)
                    return () => undefined;
                try {
                    return client.realtime.subscribe([`databases.${db}.collections.${col.messages}.documents`], (event) => {
                        const payload = event.payload;
                        if (payload.conversationId !== conversationId)
                            return;
                        try {
                            onMessage(mapMessage(payload));
                        }
                        catch {
                            /* ignore malformed realtime payloads; the cursor resync covers it */
                        }
                    });
                }
                catch {
                    return () => undefined;
                }
            },
        },
    };
    return backend;
}
//# sourceMappingURL=backend.js.map