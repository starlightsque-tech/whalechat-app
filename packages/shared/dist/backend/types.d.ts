import type { Page, Result } from '../types/common.js';
import type { LedgerTransaction, UserProfile, Wallet } from '../types/user.js';
import type { Conversation, Message, SendMessageInput } from '../types/chat.js';
import type { CheckoutInput, Order, Product } from '../types/shop.js';
import type { Asset, Candle, PlaceTradeInput, Portfolio, Quote, Trade } from '../types/trade.js';
import type { AdminAuditEvent, AdminOverview, AdminUserAction } from '../types/admin.js';
export interface MutationMeta {
    /** UUIDv4 generated on the client, reused for every retry. */
    idempotencyKey: string;
    /** device clock at the moment the user acted (server clamps future dates) */
    clientTimestamp: string;
    /** optional offline execution price for market orders */
    offlineExecutionPrice?: number | null;
}
export interface WhalechatRealtime {
    subscribeQuotes(symbols: string[], onQuote: (quote: Quote) => void): () => void;
    subscribeMessages(conversationId: string, onMessage: (message: Message) => void): () => void;
    /** resume a dropped channel using an updatedAt cursor */
    cursor?(): Promise<string | null>;
}
/**
 * High-level backend contract consumed by the shared runtime.
 *
 * `AppwriteWhalechatBackend` implements this over Appwrite Databases +
 * Functions (`whalechat-sync`), and `DemoWhalechatBackend` implements it
 * in-memory so both apps can boot and demo the offline flow with no backend.
 */
export interface WhalechatBackend {
    readonly mode: 'appwrite' | 'demo';
    auth: {
        getProfile(): Promise<UserProfile>;
        updateProfile(patch: Partial<Pick<UserProfile, 'displayName' | 'avatarUrl' | 'phone'>>): Promise<UserProfile>;
    };
    chat: {
        listConversations(): Promise<Conversation[]>;
        listMessages(conversationId: string, cursor?: string | null): Promise<Page<Message>>;
        sendMessage(input: SendMessageInput, meta: MutationMeta): Promise<Message>;
        markRead(conversationId: string, messageId: string, meta: MutationMeta): Promise<Result>;
    };
    shop: {
        listProducts(): Promise<Product[]>;
        listOrders(): Promise<Order[]>;
        placeOrder(input: CheckoutInput, meta: MutationMeta): Promise<Order>;
    };
    trade: {
        listAssets(): Promise<Asset[]>;
        getQuotes(symbols: string[]): Promise<Quote[]>;
        getCandles(symbol: string, range?: '1D' | '1W' | '1M' | '1Y'): Promise<Candle[]>;
        listTrades(): Promise<Trade[]>;
        getPortfolio(): Promise<Portfolio>;
        placeTrade(input: PlaceTradeInput, meta: MutationMeta): Promise<Trade>;
    };
    wallet: {
        getWallet(): Promise<Wallet>;
        listLedger(cursor?: string | null): Promise<Page<LedgerTransaction>>;
        transfer(input: {
            toUserId: string;
            currency: string;
            amountMinor: number;
            note?: string;
        }, meta: MutationMeta): Promise<Result>;
    };
    admin: {
        overview(): Promise<AdminOverview>;
        listUsers(): Promise<UserProfile[]>;
        act(action: AdminUserAction, meta: MutationMeta): Promise<Result>;
        audit(): Promise<AdminAuditEvent[]>;
    };
    realtime: WhalechatRealtime;
}
//# sourceMappingURL=types.d.ts.map