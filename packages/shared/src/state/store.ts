import { createStore } from 'zustand/vanilla';
import type {
  AdminAuditEvent,
  AdminOverview,
  Asset,
  Candle,
  CartItem,
  ConnectionState,
  Conversation,
  LedgerTransaction,
  Message,
  MessageStatus,
  Order,
  Portfolio,
  Product,
  Quote,
  SyncStatus,
  Trade,
  UserProfile,
  Wallet,
} from '../types/index.js';
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

export const initialConnection: ConnectionState = {
  online: true,
  status: 'booting',
  pendingCount: 0,
  failedCount: 0,
  lastSyncedAt: null,
  lastError: null,
};

export const initialState: WhalechatState = {
  booted: false,
  connection: initialConnection,
  profile: null,
  wallets: {},
  reservations: [],
  conversations: [],
  messages: {},
  activeConversationId: null,
  products: [],
  cart: [],
  orders: [],
  assets: [],
  quotes: {},
  candles: {},
  portfolio: null,
  trades: [],
  ledger: [],
  adminOverview: null,
  audit: [],
  catalogFetchedAt: null,
  walletFetchedAt: null,
};

function indexById<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

export function createWhalechatStore() {
  return createStore<WhalechatStore>()((set, get) => ({
    ...initialState,

    setBooted: (booted) => set({ booted }),

    setConnection: (patch) => set({ connection: { ...get().connection, ...patch } }),

    setSyncStatus: (status, patch) =>
      set({ connection: { ...get().connection, ...patch, status } }),

    hydrate: (patch) => set(patch),

    setProfile: (profile) => set({ profile }),

    setWallets: (wallets) =>
      set({ wallets: Array.isArray(wallets) ? indexById(wallets) : { ...get().wallets, ...wallets } }),

    setReservations: (reservations) => set({ reservations }),

    setConversations: (conversations) => set({ conversations }),

    upsertConversation: (conversation) => {
      const existing = get().conversations;
      const idx = existing.findIndex((c) => c.id === conversation.id);
      set({
        conversations:
          idx >= 0
            ? existing.map((c) => (c.id === conversation.id ? { ...c, ...conversation } : c))
            : [conversation, ...existing],
      });
    },

    setActiveConversation: (activeConversationId) => set({ activeConversationId }),

    setMessages: (conversationId, messages) =>
      set({ messages: { ...get().messages, [conversationId]: messages } }),

    appendMessage: (message) => {
      const current = get().messages[message.conversationId] ?? [];
      if (current.some((m) => m.id === message.id || (message.clientId && m.clientId === message.clientId))) {
        return;
      }
      const next = [...current, message].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      set({
        messages: { ...get().messages, [message.conversationId]: next },
        conversations: get().conversations.map((c) =>
          c.id === message.conversationId
            ? {
                ...c,
                lastMessagePreview: message.body.slice(0, 120),
                lastMessageAt: message.createdAt,
                updatedAt: message.updatedAt,
              }
            : c,
        ),
      });
    },

    patchMessage: (conversationId, messageId, patch) => {
      const current = get().messages[conversationId] ?? [];
      set({
        messages: {
          ...get().messages,
          [conversationId]: current.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
        },
      });
    },

    setMessageStatus: (conversationId, messageId, status) => {
      const current = get().messages[conversationId] ?? [];
      set({
        messages: {
          ...get().messages,
          [conversationId]: current.map((m) => (m.id === messageId ? { ...m, status } : m)),
        },
      });
    },

    setProducts: (products) => set({ products, catalogFetchedAt: new Date().toISOString() }),

    setCart: (cart) => set({ cart }),

    setOrders: (orders) => set({ orders }),

    upsertOrder: (order) => {
      const existing = get().orders;
      const idx = existing.findIndex((o) => o.id === order.id || o.idempotencyKey === order.idempotencyKey);
      set({ orders: idx >= 0 ? existing.map((o, i) => (i === idx ? order : o)) : [order, ...existing] });
    },

    setAssets: (assets) => set({ assets }),

    setQuotes: (quotes) => {
      const next = { ...get().quotes };
      for (const quote of quotes) next[quote.symbol] = quote;
      set({ quotes: next });
    },

    setCandles: (symbol, candles) => set({ candles: { ...get().candles, [symbol]: candles } }),

    appendCandle: (symbol, candle) => {
      const current = get().candles[symbol] ?? [];
      const last = current[current.length - 1];
      const next = last && last.time === candle.time ? [...current.slice(0, -1), candle] : [...current, candle];
      set({ candles: { ...get().candles, [symbol]: next.slice(-500) } });
    },

    setPortfolio: (portfolio) => set({ portfolio }),

    setTrades: (trades) => set({ trades }),

    upsertTrade: (trade) => {
      const existing = get().trades;
      const idx = existing.findIndex((t) => t.id === trade.id || t.idempotencyKey === trade.idempotencyKey);
      set({ trades: idx >= 0 ? existing.map((t, i) => (i === idx ? trade : t)) : [trade, ...existing] });
    },

    setLedger: (ledger) => set({ ledger }),

    setAdmin: (adminOverview, audit) => set({ adminOverview, ...(audit ? { audit } : {}) }),

    reset: () => set({ ...initialState }),
  }));
}

export type WhalechatStoreApi = ReturnType<typeof createWhalechatStore>;

/** App-wide singleton; hooks read from it, the runtime writes to it. */
export const whalechatStore = createWhalechatStore();

export const selectWalletFor =
  (currency: string) =>
  (state: WhalechatState): Wallet | null =>
    Object.values(state.wallets).find((w) => (w.balances[currency.toUpperCase()] ?? 0) > 0) ??
    Object.values(state.wallets)[0] ??
    null;

export const selectMessages =
  (conversationId: string | null) =>
  (state: WhalechatState): Message[] =>
    conversationId ? state.messages[conversationId] ?? [] : [];
