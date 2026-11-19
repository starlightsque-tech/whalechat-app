import type { Attachment, Message } from './types/chat.js';
import type { Order, Product } from './types/shop.js';
import type { PlaceTradeInput, Trade } from './types/trade.js';
import type { UserProfile } from './types/user.js';
import type { WhalechatBackend } from './backend/types.js';
import type { NetworkMonitor } from './network/monitor.js';
import type { StorageAdapter } from './storage/adapter.js';
import type { WhalechatStoreApi } from './state/store.js';
import { OutboxQueue } from './sync/outbox.js';
import { SyncManager } from './sync/manager.js';
export interface RuntimeOptions {
    storage: StorageAdapter;
    network: NetworkMonitor;
    backend: WhalechatBackend;
    store?: WhalechatStoreApi;
    now?: () => number;
}
/**
 * Shared application runtime — the only place UI code talks to for mutations.
 *
 * Every mutation is applied locally first (optimistic), persisted, then
 * appended to the outbox with a UUIDv4 idempotency key. Nothing calls the
 * backend directly from a screen.
 */
export declare class WhalechatRuntime {
    private storage;
    private network;
    private backend;
    private store;
    private outbox;
    private manager;
    private now;
    private detachPersistence;
    private unsubs;
    private started;
    private bootPromise;
    configure(options: RuntimeOptions): this;
    /** Boot: cache → UI, then network refresh and queue drain. Idempotent. */
    start(): Promise<void>;
    stop(): void;
    getOutbox(): OutboxQueue;
    getManager(): SyncManager;
    isOnline(): boolean;
    retryNow(): Promise<void>;
    sendMessage(conversationId: string, body: string, attachments?: Attachment[]): Promise<Message>;
    markRead(conversationId: string, messageId: string): Promise<void>;
    loadMessages(conversationId: string): Promise<void>;
    addToCart(product: Product, quantity?: number): void;
    updateCartQuantity(productId: string, quantity: number): void;
    removeFromCart(productId: string): void;
    cartTotals(): {
        subtotalMinor: number;
        shippingMinor: number;
        totalMinor: number;
        currency: string;
    };
    checkout(): Promise<Order>;
    placeTrade(input: PlaceTradeInput): Promise<Trade>;
    transfer(toUserId: string, currency: string, amountMinor: number, note?: string): Promise<void>;
    refreshAll(): Promise<void>;
    refreshWallet(): Promise<void>;
    loadQuotes(symbols: string[]): Promise<void>;
    loadCandles(symbol: string, range?: '1D' | '1W' | '1M' | '1Y'): Promise<void>;
    refreshAdmin(): Promise<void>;
    adminUsers(): Promise<UserProfile[]>;
    adminOverview(): Promise<import('./types/admin.js').AdminOverview>;
    /** Admin mutations still flow through the outbox (audited, idempotent). */
    adminAction(action: import('./types/admin.js').AdminUserAction): Promise<void>;
    private handleMessageSend;
    private handleMessageRead;
    private handleCheckout;
    private handleTrade;
    private handleTransfer;
    private handleProfileUpdate;
    private handleAdminAction;
    private handleDeadLetter;
    private meta;
    private applyWallet;
    private commitReservation;
    private releaseCommitted;
    private subscribeRealtime;
}
export declare const whalechatRuntime: WhalechatRuntime;
/** Convenience for UI components that want a live available balance. */
export declare function availableFor(state: ReturnType<WhalechatStoreApi['getState']>, currency: string): number;
//# sourceMappingURL=runtime.d.ts.map