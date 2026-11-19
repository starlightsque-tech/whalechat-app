import { whalechatStore } from './state/store.js';
import { StorageKeys } from './storage/keys.js';
import { OutboxQueue, FINANCIAL_OPERATION_TYPES } from './sync/outbox.js';
import { SyncManager } from './sync/manager.js';
import { attachPersistence, hydrateStore } from './sync/persistence.js';
import { availableBalance, releaseReservation, reserveFunds, } from './sync/financial.js';
import { uuidv4 } from './utils/id.js';
import { nowIso } from './utils/time.js';
import { WhalechatError } from './utils/errors.js';
/**
 * Shared application runtime — the only place UI code talks to for mutations.
 *
 * Every mutation is applied locally first (optimistic), persisted, then
 * appended to the outbox with a UUIDv4 idempotency key. Nothing calls the
 * backend directly from a screen.
 */
export class WhalechatRuntime {
    storage;
    network;
    backend;
    store = whalechatStore;
    outbox;
    manager;
    now = Date.now;
    detachPersistence = null;
    unsubs = [];
    started = false;
    bootPromise = null;
    configure(options) {
        this.storage = options.storage;
        this.network = options.network;
        this.backend = options.backend;
        this.store = options.store ?? whalechatStore;
        this.now = options.now ?? Date.now;
        this.outbox = new OutboxQueue({ storage: options.storage, now: this.now });
        this.manager = new SyncManager({
            storage: options.storage,
            network: options.network,
            outbox: this.outbox,
            store: this.store,
            handlers: {
                'message.send': (op) => this.handleMessageSend(op),
                'message.read': (op) => this.handleMessageRead(op),
                'cart.upsert': async () => undefined,
                'cart.remove': async () => undefined,
                'order.checkout': (op) => this.handleCheckout(op),
                'trade.place': (op) => this.handleTrade(op),
                'wallet.transfer': (op) => this.handleTransfer(op),
                'profile.update': (op) => this.handleProfileUpdate(op),
                'admin.action': (op) => this.handleAdminAction(op),
            },
            onDeadLetter: (op) => this.handleDeadLetter(op),
            reconcile: () => this.refreshWallet(),
        });
        return this;
    }
    /** Boot: cache → UI, then network refresh and queue drain. Idempotent. */
    async start() {
        if (this.started)
            return;
        if (this.bootPromise)
            return this.bootPromise;
        this.bootPromise = (async () => {
            this.started = true;
            const store = this.store;
            store.getState().setSyncStatus('booting', { online: this.network.isOnline() });
            await this.outbox.load();
            await hydrateStore(this.storage, store);
            store.getState().setBooted(true);
            this.detachPersistence = attachPersistence(this.storage, store);
            this.network.start();
            await this.manager.start();
            if (this.network.isOnline()) {
                await this.refreshAll().catch(() => undefined);
            }
            else {
                store.getState().setSyncStatus('offline', { online: false });
            }
            this.subscribeRealtime();
        })();
        return this.bootPromise;
    }
    stop() {
        this.manager?.stop();
        this.network?.stop();
        this.detachPersistence?.();
        this.detachPersistence = null;
        for (const unsub of this.unsubs)
            unsub();
        this.unsubs = [];
        this.started = false;
        this.bootPromise = null;
    }
    getOutbox() {
        return this.outbox;
    }
    getManager() {
        return this.manager;
    }
    isOnline() {
        return this.network?.isOnline() ?? false;
    }
    async retryNow() {
        await this.manager.retryNow();
    }
    // ─────────────────────────────────────────────────────────────── chat
    async sendMessage(conversationId, body, attachments = []) {
        const trimmed = body.trim();
        if (!trimmed && attachments.length === 0)
            throw new WhalechatError('Message is empty', 'permanent', 'EMPTY_MESSAGE');
        const ts = nowIso(this.now);
        const optimisticId = uuidv4();
        const message = {
            id: optimisticId,
            clientId: optimisticId,
            conversationId,
            senderId: this.store.getState().profile?.id ?? 'me',
            body: trimmed,
            attachments,
            status: 'sending',
            createdAt: ts,
            updatedAt: ts,
            serverCreatedAt: null,
            readBy: [],
            replyToId: null,
            deletedAt: null,
        };
        this.store.getState().appendMessage(message);
        const payload = {
            input: { conversationId, body: trimmed, attachments, replyToId: null },
            optimisticId,
        };
        const op = await this.manager.enqueue({
            type: 'message.send',
            payload,
            dedupeKey: `message:${optimisticId}`,
        });
        this.store.getState().patchMessage(conversationId, optimisticId, { updatedAt: nowIso(this.now) });
        void op;
        return message;
    }
    async markRead(conversationId, messageId) {
        const state = this.store.getState();
        state.setConversations(state.conversations.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)));
        const conversation = state.conversations.find((c) => c.id === conversationId);
        if (!conversation)
            return;
        const payload = { conversationId, body: '', attachments: [], replyToId: null };
        void payload;
        await this.manager.enqueue({
            type: 'message.read',
            payload: { conversationId, messageId },
            dedupeKey: `read:${conversationId}:${messageId}`,
        });
    }
    async loadMessages(conversationId) {
        if (!this.network.isOnline())
            return;
        try {
            const page = await this.backend.chat.listMessages(conversationId);
            const current = this.store.getState().messages[conversationId] ?? [];
            const pending = current.filter((m) => m.status === 'sending');
            const merged = [...page.items, ...pending].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
            this.store.getState().setMessages(conversationId, merged);
        }
        catch {
            /* keep the cached thread */
        }
    }
    // ─────────────────────────────────────────────────────────────── shop
    addToCart(product, quantity = 1) {
        const state = this.store.getState();
        const existing = state.cart.find((item) => item.productId === product.id);
        const cart = existing
            ? state.cart.map((item) => item.productId === product.id ? { ...item, quantity: item.quantity + quantity } : item)
            : [
                ...state.cart,
                {
                    productId: product.id,
                    title: product.title,
                    unitPrice: product.price,
                    quantity,
                    imageUrl: product.imageUrl,
                },
            ];
        state.setCart(cart);
        // Fire-and-forget: cart operations are non-financial and safe to retry.
        void this.manager.enqueue({
            type: 'cart.upsert',
            payload: { items: cart },
            dedupeKey: `cart:${product.id}`,
        });
    }
    updateCartQuantity(productId, quantity) {
        const state = this.store.getState();
        const cart = state.cart
            .map((item) => (item.productId === productId ? { ...item, quantity: Math.max(0, quantity) } : item))
            .filter((item) => item.quantity > 0);
        state.setCart(cart);
        void this.manager.enqueue({
            type: 'cart.upsert',
            payload: { items: cart },
            dedupeKey: `cart:${productId}`,
        });
    }
    removeFromCart(productId) {
        const state = this.store.getState();
        state.setCart(state.cart.filter((item) => item.productId !== productId));
        void this.manager.enqueue({
            type: 'cart.remove',
            payload: { productId },
            dedupeKey: `cart:${productId}`,
        });
    }
    cartTotals() {
        const cart = this.store.getState().cart;
        const currency = cart[0]?.unitPrice.currency ?? 'USD';
        const subtotalMinor = cart.reduce((sum, item) => sum + item.unitPrice.amountMinor * item.quantity, 0);
        const shippingMinor = subtotalMinor > 0 && subtotalMinor < 5_000 ? 499 : 0;
        return { subtotalMinor, shippingMinor, totalMinor: subtotalMinor + shippingMinor, currency };
    }
    async checkout() {
        const state = this.store.getState();
        if (state.cart.length === 0)
            throw new WhalechatError('Cart is empty', 'permanent', 'EMPTY_CART');
        const totals = this.cartTotals();
        const wallet = Object.values(state.wallets)[0] ?? null;
        const reservationCheck = reserveFunds(wallet, state.reservations, {
            currency: totals.currency,
            amountMinor: totals.totalMinor,
            ref: 'pending',
            now: nowIso(this.now),
        });
        if (!reservationCheck.ok) {
            throw new WhalechatError(reservationCheck.reason === 'insufficient_funds' ? 'Insufficient available balance' : 'Unable to reserve funds', 'permanent', 'INSUFFICIENT_FUNDS');
        }
        const idempotencyKey = uuidv4();
        const ts = nowIso(this.now);
        const input = {
            items: state.cart,
            currency: totals.currency,
            shippingMinor: totals.shippingMinor,
            note: '',
        };
        const optimisticOrder = {
            id: `local_${idempotencyKey.slice(0, 8)}`,
            userId: state.profile?.id ?? 'me',
            items: state.cart.map((item) => ({
                productId: item.productId,
                title: item.title,
                unitPrice: item.unitPrice,
                quantity: item.quantity,
            })),
            subtotal: { amountMinor: totals.subtotalMinor, currency: totals.currency },
            shipping: { amountMinor: totals.shippingMinor, currency: totals.currency },
            total: { amountMinor: totals.totalMinor, currency: totals.currency },
            status: 'pending_sync',
            escrow: { held: true, releasedAt: null, releaseAfter: null },
            placedAt: ts,
            updatedAt: ts,
            idempotencyKey,
        };
        this.commitReservation(reservationCheck.reservation, idempotencyKey);
        state.upsertOrder(optimisticOrder);
        state.setCart([]);
        await this.manager.enqueue({
            type: 'order.checkout',
            payload: { input, optimisticOrderId: optimisticOrder.id },
            idempotencyKey,
            reservation: {
                walletId: reservationCheck.reservation.walletId,
                currency: totals.currency,
                amountMinor: totals.totalMinor,
            },
        });
        return optimisticOrder;
    }
    // ─────────────────────────────────────────────────────────────── trade
    async placeTrade(input) {
        const state = this.store.getState();
        const symbol = input.symbol.toUpperCase();
        const quote = state.quotes[symbol];
        const executionPrice = input.limitPrice ?? quote?.price;
        if (!executionPrice)
            throw new WhalechatError('No price available for this symbol', 'retryable', 'NO_QUOTE');
        const notionalMinor = Math.round(input.quantity * executionPrice * 100);
        const feesMinor = Math.max(1, Math.round(notionalMinor * 0.0005));
        const currency = input.currency.toUpperCase();
        const wallet = Object.values(state.wallets)[0] ?? null;
        let reservation = null;
        if (input.side === 'buy') {
            const result = reserveFunds(wallet, state.reservations, {
                currency,
                amountMinor: notionalMinor + feesMinor,
                ref: 'pending',
                now: nowIso(this.now),
            });
            if (!result.ok) {
                throw new WhalechatError(result.reason === 'insufficient_funds' ? 'Insufficient available balance for this trade' : 'Unable to reserve funds', 'permanent', 'INSUFFICIENT_FUNDS');
            }
            reservation = result.reservation;
        }
        const idempotencyKey = uuidv4();
        const ts = nowIso(this.now);
        const optimisticTrade = {
            id: `local_${idempotencyKey.slice(0, 8)}`,
            userId: state.profile?.id ?? 'me',
            symbol,
            side: input.side,
            quantity: input.quantity,
            limitPrice: input.limitPrice,
            filledPrice: null,
            status: 'pending_sync',
            fees: { amountMinor: feesMinor, currency },
            notional: { amountMinor: notionalMinor, currency },
            idempotencyKey,
            offlineExecutionPrice: executionPrice,
            createdAt: ts,
            updatedAt: ts,
        };
        if (reservation) {
            this.commitReservation(reservation, idempotencyKey);
        }
        state.upsertTrade(optimisticTrade);
        await this.manager.enqueue({
            type: 'trade.place',
            payload: { input: { ...input, symbol }, optimisticTradeId: optimisticTrade.id, executionPrice },
            idempotencyKey,
            reservation: reservation
                ? { walletId: reservation.walletId, currency, amountMinor: notionalMinor + feesMinor }
                : null,
        });
        return optimisticTrade;
    }
    async transfer(toUserId, currency, amountMinor, note) {
        const state = this.store.getState();
        const result = reserveFunds(Object.values(state.wallets)[0] ?? null, state.reservations, {
            currency,
            amountMinor,
            ref: 'pending',
            now: nowIso(this.now),
        });
        if (!result.ok)
            throw new WhalechatError('Insufficient available balance', 'permanent', 'INSUFFICIENT_FUNDS');
        const idempotencyKey = uuidv4();
        this.commitReservation(result.reservation, idempotencyKey);
        await this.manager.enqueue({
            type: 'wallet.transfer',
            payload: { toUserId, currency, amountMinor, note },
            idempotencyKey,
            reservation: { walletId: result.reservation.walletId, currency, amountMinor },
        });
    }
    // ─────────────────────────────────────────────────────────────── reads
    async refreshAll() {
        if (!this.network.isOnline())
            return;
        const store = this.store;
        store.getState().setSyncStatus('syncing');
        const results = await Promise.allSettled([
            this.backend.auth.getProfile(),
            this.backend.chat.listConversations(),
            this.backend.shop.listProducts(),
            this.backend.trade.listAssets(),
            this.backend.wallet.getWallet(),
            this.backend.trade.getPortfolio(),
            this.backend.trade.listTrades(),
            this.backend.shop.listOrders(),
            this.backend.wallet.listLedger(),
        ]);
        const [profile, conversations, products, assets, wallet, portfolio, trades, orders, ledger] = results;
        if (profile?.status === 'fulfilled')
            store.getState().setProfile(profile.value);
        if (conversations?.status === 'fulfilled')
            store.getState().setConversations(conversations.value);
        if (products?.status === 'fulfilled')
            store.getState().setProducts(products.value);
        if (assets?.status === 'fulfilled') {
            store.getState().setAssets(assets.value);
            await this.loadQuotes(assets.value.map((a) => a.symbol));
            const first = assets.value[0];
            if (first && !store.getState().candles[first.symbol])
                await this.loadCandles(first.symbol).catch(() => undefined);
        }
        if (wallet?.status === 'fulfilled')
            this.applyWallet(wallet.value);
        if (portfolio?.status === 'fulfilled')
            store.getState().setPortfolio(portfolio.value);
        if (trades?.status === 'fulfilled')
            store.getState().setTrades(trades.value);
        if (orders?.status === 'fulfilled')
            store.getState().setOrders(orders.value);
        if (ledger?.status === 'fulfilled')
            store.getState().setLedger(ledger.value.items);
        const active = store.getState().activeConversationId ?? store.getState().conversations[0]?.id;
        if (active)
            await this.loadMessages(active);
        store.getState().setSyncStatus(this.network.isOnline() ? 'online' : 'offline', {
            lastSyncedAt: nowIso(this.now),
            lastError: results.every((r) => r.status === 'rejected') ? 'Could not reach the Whalechat API' : null,
        });
    }
    async refreshWallet() {
        if (!this.network.isOnline())
            return;
        try {
            const wallet = await this.backend.wallet.getWallet();
            this.applyWallet(wallet);
            const ledger = await this.backend.wallet.listLedger();
            this.store.getState().setLedger(ledger.items);
            const portfolio = await this.backend.trade.getPortfolio();
            this.store.getState().setPortfolio(portfolio);
        }
        catch {
            /* cache remains authoritative for display until the next refresh */
        }
    }
    async loadQuotes(symbols) {
        if (!this.network.isOnline() || symbols.length === 0)
            return;
        try {
            const quotes = await this.backend.trade.getQuotes(symbols);
            this.store.getState().setQuotes(quotes);
        }
        catch {
            /* ignore */
        }
    }
    async loadCandles(symbol, range = '1D') {
        try {
            const cached = this.store.getState().candles[symbol.toUpperCase()];
            if (cached && cached.length > 0)
                return;
            if (!this.network.isOnline())
                return;
            const candles = await this.backend.trade.getCandles(symbol, range);
            this.store.getState().setCandles(symbol.toUpperCase(), candles);
        }
        catch {
            /* keep cached candles */
        }
    }
    async refreshAdmin() {
        if (!this.network.isOnline())
            return;
        try {
            const overview = await this.backend.admin.overview();
            this.store.getState().setAdmin(overview);
        }
        catch {
            /* admin panel shows cached/empty state */
        }
    }
    async adminUsers() {
        return this.backend.admin.listUsers();
    }
    async adminOverview() {
        return this.backend.admin.overview();
    }
    /** Admin mutations still flow through the outbox (audited, idempotent). */
    async adminAction(action) {
        const idempotencyKey = uuidv4();
        await this.manager.enqueue({ type: 'admin.action', payload: action, idempotencyKey });
    }
    // ─────────────────────────────────────────────────────────── handlers
    async handleMessageSend(op) {
        const { input, optimisticId } = op.payload;
        try {
            const server = await this.backend.chat.sendMessage(input, this.meta(op));
            const list = this.store.getState().messages[input.conversationId] ?? [];
            const next = list.map((message) => message.id === optimisticId
                ? { ...server, clientId: optimisticId, status: 'sent' }
                : message);
            this.store.getState().setMessages(input.conversationId, next);
            this.store.getState().setMessageStatus(input.conversationId, server.id, 'sent');
        }
        catch (error) {
            const list = this.store.getState().messages[input.conversationId] ?? [];
            const failed = list.map((message) => message.id === optimisticId ? { ...message, status: 'failed' } : message);
            this.store.getState().setMessages(input.conversationId, failed);
            throw error;
        }
    }
    async handleMessageRead(op) {
        const { conversationId, messageId } = op.payload;
        await this.backend.chat.markRead(conversationId, messageId, this.meta(op));
    }
    async handleCheckout(op) {
        const { input, optimisticOrderId } = op.payload;
        const order = await this.backend.shop.placeOrder(input, this.meta(op));
        this.store.getState().upsertOrder(order);
        void optimisticOrderId;
        await this.refreshWallet();
        this.releaseCommitted(op.idempotencyKey);
    }
    async handleTrade(op) {
        const { input, optimisticTradeId, executionPrice } = op.payload;
        const trade = await this.backend.trade.placeTrade(input, {
            ...this.meta(op),
            offlineExecutionPrice: executionPrice,
        });
        this.store.getState().upsertTrade(trade);
        void optimisticTradeId;
        await this.refreshWallet();
        this.releaseCommitted(op.idempotencyKey);
    }
    async handleTransfer(op) {
        const payload = op.payload;
        await this.backend.wallet.transfer(payload, this.meta(op));
        await this.refreshWallet();
        this.releaseCommitted(op.idempotencyKey);
    }
    async handleProfileUpdate(op) {
        const patch = op.payload;
        const profile = await this.backend.auth.updateProfile(patch);
        this.store.getState().setProfile(profile);
    }
    async handleAdminAction(op) {
        await this.backend.admin.act(op.payload, this.meta(op));
        await this.refreshAdmin();
    }
    async handleDeadLetter(op) {
        if (!FINANCIAL_OPERATION_TYPES.has(op.type))
            return;
        const reservations = this.store.getState().reservations;
        this.store.getState().setReservations(releaseReservation(reservations, op.idempotencyKey));
        await this.storage.set(StorageKeys.outbox + ':reservations', this.store.getState().reservations).catch(() => undefined);
        if (op.type === 'order.checkout') {
            const order = this.store.getState().orders.find((o) => o.idempotencyKey === op.idempotencyKey);
            if (order) {
                this.store.getState().upsertOrder({ ...order, status: 'failed', escrow: { ...order.escrow, held: false } });
            }
        }
        if (op.type === 'trade.place') {
            const trade = this.store.getState().trades.find((t) => t.idempotencyKey === op.idempotencyKey);
            if (trade)
                this.store.getState().upsertTrade({ ...trade, status: 'failed' });
        }
    }
    // ─────────────────────────────────────────────────────────── internals
    meta(op) {
        return {
            idempotencyKey: op.idempotencyKey,
            clientTimestamp: op.createdAt,
        };
    }
    applyWallet(wallet) {
        this.store.getState().setWallets({ [wallet.id]: wallet });
        this.store.getState().hydrate({ walletFetchedAt: nowIso(this.now) });
        // Drop committed reservations — the authoritative balance now reflects them.
        const reservations = this.store.getState().reservations.filter((r) => r.status === 'held');
        this.store.getState().setReservations(reservations);
    }
    commitReservation(reservation, ref) {
        const current = this.store.getState().reservations;
        this.store.getState().setReservations([
            ...current,
            { ...reservation, ref, status: 'held' },
        ]);
    }
    releaseCommitted(idempotencyKey) {
        const reservations = this.store.getState().reservations.filter((r) => r.ref !== idempotencyKey);
        this.store.getState().setReservations(reservations);
        void this.storage.set(StorageKeys.outbox + ':reservations', reservations).catch(() => undefined);
    }
    subscribeRealtime() {
        const symbols = this.store.getState().assets.map((asset) => asset.symbol);
        if (symbols.length > 0) {
            this.unsubs.push(this.backend.realtime.subscribeQuotes(symbols, (quote) => {
                this.store.getState().setQuotes([quote]);
                const bucket = Math.floor(this.now() / 300_000) * 300;
                const existing = this.store.getState().candles[quote.symbol]?.at(-1);
                const candle = existing && existing.time === bucket
                    ? { ...existing, close: quote.price, high: Math.max(existing.high, quote.price), low: Math.min(existing.low, quote.price) }
                    : { time: bucket, open: quote.price, high: quote.price, low: quote.price, close: quote.price, volume: 0 };
                this.store.getState().appendCandle(quote.symbol, candle);
            }));
        }
        for (const conversation of this.store.getState().conversations) {
            this.unsubs.push(this.backend.realtime.subscribeMessages(conversation.id, (message) => {
                const state = this.store.getState();
                if (message.senderId === state.profile?.id)
                    return;
                state.appendMessage({ ...message, status: 'delivered' });
                if (state.activeConversationId === conversation.id) {
                    void this.markRead(conversation.id, message.id);
                }
            }));
        }
    }
}
export const whalechatRuntime = new WhalechatRuntime();
/** Convenience for UI components that want a live available balance. */
export function availableFor(state, currency) {
    return availableBalance(Object.values(state.wallets)[0] ?? null, state.reservations, currency);
}
//# sourceMappingURL=runtime.js.map