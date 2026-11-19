import type { AdminAuditEvent, AdminOverview, Asset, Candle, CartItem, ConnectionState, Conversation, LedgerTransaction, Message, MessageStatus, Order, Portfolio, Product, Quote, SyncStatus, Trade, UserProfile, Wallet } from '../types/index.js';
import type { Reservation } from '../sync/financial.js';
export interface WhalechatState {
    booted: boolean;
    connection: ConnectionState;
    profile: UserProfile | null;
    wallets: Record<string, Wallet>;
    reservations: Reservation[];
    conversations: Conversation[];
    messages: Record<string, Message[]>;
    activeConversationId: string | null;
    products: Product[];
    cart: CartItem[];
    orders: Order[];
    assets: Asset[];
    quotes: Record<string, Quote>;
    candles: Record<string, Candle[]>;
    portfolio: Portfolio | null;
    trades: Trade[];
    ledger: LedgerTransaction[];
    adminOverview: AdminOverview | null;
    audit: AdminAuditEvent[];
    catalogFetchedAt: string | null;
    walletFetchedAt: string | null;
}
export interface WhalechatActions {
    setBooted(booted: boolean): void;
    setConnection(patch: Partial<ConnectionState>): void;
    setSyncStatus(status: SyncStatus, patch?: Partial<ConnectionState>): void;
    hydrate(patch: Partial<WhalechatState>): void;
    setProfile(profile: UserProfile | null): void;
    setWallets(wallets: Record<string, Wallet> | Wallet[]): void;
    setReservations(reservations: Reservation[]): void;
    setConversations(conversations: Conversation[]): void;
    upsertConversation(conversation: Conversation): void;
    setActiveConversation(id: string | null): void;
    setMessages(conversationId: string, messages: Message[]): void;
    appendMessage(message: Message): void;
    patchMessage(conversationId: string, messageId: string, patch: Partial<Message>): void;
    setMessageStatus(conversationId: string, messageId: string, status: MessageStatus): void;
    setProducts(products: Product[]): void;
    setCart(items: CartItem[]): void;
    setOrders(orders: Order[]): void;
    upsertOrder(order: Order): void;
    setAssets(assets: Asset[]): void;
    setQuotes(quotes: Quote[]): void;
    setCandles(symbol: string, candles: Candle[]): void;
    appendCandle(symbol: string, candle: Candle): void;
    setPortfolio(portfolio: Portfolio | null): void;
    setTrades(trades: Trade[]): void;
    upsertTrade(trade: Trade): void;
    setLedger(ledger: LedgerTransaction[]): void;
    setAdmin(overview: AdminOverview | null, audit?: AdminAuditEvent[]): void;
    reset(): void;
}
export type WhalechatStore = WhalechatState & WhalechatActions;
export declare const initialConnection: ConnectionState;
export declare const initialState: WhalechatState;
export declare function createWhalechatStore(): import("zustand").StoreApi<WhalechatStore>;
export type WhalechatStoreApi = ReturnType<typeof createWhalechatStore>;
/** App-wide singleton; hooks read from it, the runtime writes to it. */
export declare const whalechatStore: import("zustand").StoreApi<WhalechatStore>;
export declare const selectWalletFor: (currency: string) => (state: WhalechatState) => Wallet | null;
export declare const selectMessages: (conversationId: string | null) => (state: WhalechatState) => Message[];
//# sourceMappingURL=store.d.ts.map