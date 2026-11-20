import { z } from 'zod';
import type { Page, Result } from '../types/common.js';
import type { LedgerTransaction, UserProfile, Wallet } from '../types/user.js';
import type { Conversation, Message } from '../types/chat.js';
import type { CartItem, Order, Product } from '../types/shop.js';
import type { Asset, Candle, Portfolio, Quote, Trade } from '../types/trade.js';
import type { AdminOverview } from '../types/admin.js';
import type { MutationMeta, WhalechatBackend } from '../backend/types.js';
import { WhalechatError } from '../utils/errors.js';
import type {
  AppwriteClientBundle,
  AppwriteDocument,
  AppwriteExecution,
  AppwriteRealtimeEvent,
} from './transport.js';
import { defaultAppwriteConfig, type AppwriteConfig } from './transport.js';
import {
  ConversationSchema,
  MessageSchema,
  OrderSchema,
  PortfolioSchema,
  ProductSchema,
  QuoteSchema,
  TradeSchema,
  UserProfileSchema,
  WalletSchema,
} from '../types/index.js';

const CandleListSchema = z.array(
  z.object({
    time: z.number(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number().optional().default(0),
  }),
);

function q(method: string, attribute: string, values: unknown[]): string {
  return JSON.stringify({ method, attribute, values });
}

const equal = (attr: string, ...values: unknown[]) => q('equal', attr, values);
const orderDesc = (attr: string) => q('orderDesc', attr, []);
const orderAsc = (attr: string) => q('orderAsc', attr, []);
const limit = (n: number) => q('limit', '', [n]);
const cursorAfter = (id: string) => q('cursorAfter', '', [id]);

export interface AppwriteBackendOptions {
  client: AppwriteClientBundle;
  userId: string;
  config?: Partial<AppwriteConfig> & { collections?: Partial<AppwriteConfig['collections']> };
}

/**
 * Appwrite implementation of the shared backend contract.
 *
 * Reads go straight to Databases (fast, realtime-friendly); every mutation
 * goes through the `whalechat-sync` Function so the server can enforce the
 * unique idempotency index and perform atomic wallet/escrow ledger writes.
 */
export function createAppwriteBackend(options: AppwriteBackendOptions): WhalechatBackend {
  const config: AppwriteConfig = {
    ...defaultAppwriteConfig,
    ...options.config,
    collections: { ...defaultAppwriteConfig.collections, ...options.config?.collections },
  };
  const { client, userId } = options;
  const db = config.databaseId;
  const col = config.collections;

  async function execute<T>(path: string, method: string, body?: unknown): Promise<T> {
    let execution: AppwriteExecution;
    try {
      // The function resolves identity from the Appwrite session header and
      // (as a compatibility fallback) from this signed-in user id.
      const payload =
        body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), userId }
          : body === undefined
            ? { userId }
            : body;
      execution = await client.functions.createExecution(
        config.functionId,
        payload === undefined ? '' : JSON.stringify(payload),
        false,
        path,
        method,
        { 'content-type': 'application/json' },
      );
    } catch (error) {
      throw new WhalechatError(
        `Sync function unreachable: ${error instanceof Error ? error.message : String(error)}`,
        'retryable',
        'SYNC_UNREACHABLE',
      );
    }
    const status = execution.responseStatusCode ?? Number(execution.status === 'completed' ? 200 : 500);
    let parsed: unknown = null;
    try {
      parsed = execution.responseBody ? JSON.parse(execution.responseBody) : null;
    } catch {
      parsed = execution.responseBody;
    }
    if (status >= 400) {
      const message =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : execution.errors || `Sync function returned ${status}`;
      const kind = status === 409 ? 'conflict' : status >= 500 || status === 429 ? 'retryable' : 'permanent';
      throw new WhalechatError(message, kind, `SYNC_${status}`);
    }
    return parsed as T;
  }

  function docData(doc: AppwriteDocument): Record<string, unknown> {
    return doc as unknown as Record<string, unknown>;
  }

  function mapMessage(doc: AppwriteDocument): Message {
    const data = docData(doc);
    const rawAttachments = Array.isArray(data.attachments) ? data.attachments : [];
    const attachments = rawAttachments.flatMap((entry) => {
      if (typeof entry !== 'string') return [];
      try {
        return [JSON.parse(entry) as unknown];
      } catch {
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

  function mapProduct(doc: AppwriteDocument): Product {
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
      updatedAt: (d.updatedAt as string) ?? doc.$updatedAt,
    });
  }

  function mapWallet(doc: AppwriteDocument): Wallet {
    return WalletSchema.parse({
      id: doc.$id,
      userId: docData(doc).userId,
      balances: docData(doc).balances ?? { USD: 0 },
      locked: docData(doc).locked ?? {},
      version: docData(doc).version ?? 0,
      updatedAt: docData(doc).updatedAt ?? doc.$updatedAt,
    });
  }

  const backend: WhalechatBackend = {
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
        return res.documents.map((doc) =>
          ConversationSchema.parse({
            id: doc.$id,
            kind: docData(doc).kind ?? 'direct',
            title: docData(doc).title ?? null,
            participantIds: docData(doc).participantIds ?? [userId],
            lastMessagePreview: docData(doc).lastMessagePreview ?? '',
            lastMessageAt: docData(doc).lastMessageAt ?? null,
            unreadCount: docData(doc).unreadCount ?? 0,
            updatedAt: docData(doc).updatedAt ?? doc.$updatedAt,
          }),
        );
      },
      async listMessages(conversationId, cursor): Promise<Page<Message>> {
        const queries = [equal('conversationId', conversationId), orderDesc('createdAt'), limit(50)];
        if (cursor) queries.push(cursorAfter(cursor));
        const res = await client.databases.listDocuments(db, col.messages, queries);
        const items = res.documents.map(mapMessage).reverse();
        return { items, nextCursor: res.documents.at(-1)?.$id ?? null, hasMore: res.total > queries.length };
      },
      async sendMessage(input, meta: MutationMeta) {
        const raw = await execute<unknown>('/api/messages', 'POST', {
          ...input,
          idempotencyKey: meta.idempotencyKey,
          clientTimestamp: meta.clientTimestamp,
        });
        return MessageSchema.parse(raw);
      },
      async markRead(conversationId, messageId, meta): Promise<Result> {
        return execute<Result>('/api/messages/read', 'POST', {
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
      async placeOrder(input, meta: MutationMeta) {
        const raw = await execute<unknown>('/api/orders/checkout', 'POST', {
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
            assetClass: (d.assetClass ?? 'equity') as Asset['assetClass'],
            currency: String(d.currency ?? 'USD'),
            logoUrl: String(d.logoUrl ?? ''),
            sector: String(d.sector ?? ''),
            active: d.active !== false,
            updatedAt: String(d.updatedAt ?? doc.$updatedAt),
          };
        });
      },
      async getQuotes(symbols) {
        const raw = await execute<unknown>(`/api/market/quotes?symbols=${encodeURIComponent(symbols.join(','))}`, 'GET');
        return z.array(QuoteSchema).parse(raw);
      },
      async getCandles(symbol, range = '1D') {
        const raw = await execute<unknown>(
          `/api/market/candles?symbol=${encodeURIComponent(symbol)}&range=${range}`,
          'GET',
        );
        return CandleListSchema.parse(raw) as Candle[];
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
        const raw = await execute<unknown>('/api/portfolio', 'GET');
        return PortfolioSchema.parse(raw);
      },
      async placeTrade(input, meta: MutationMeta) {
        const raw = await execute<unknown>('/api/trades', 'POST', {
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
        if (docs.length === 0) throw new WhalechatError('Wallet not provisioned', 'permanent', 'NO_WALLET');
        const balances: Record<string, number> = {};
        const locked: Record<string, number> = {};
        for (const doc of docs) {
          const d = docData(doc);
          const currency = String(d.currency ?? 'USD').toUpperCase();
          balances[currency] = (balances[currency] ?? 0) + Number(d.availableMinor ?? 0);
          locked[currency] = (locked[currency] ?? 0) + Number(d.lockedMinor ?? 0);
        }
        const first = docs[0]!;
        return mapWallet({ ...first, balances, locked, userId } as AppwriteDocument);
      },
      async listLedger(cursor): Promise<Page<LedgerTransaction>> {
        const queries = [equal('userId', userId), orderDesc('createdAt'), limit(50)];
        if (cursor) queries.push(cursorAfter(cursor));
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
          } as LedgerTransaction;
        });
        return { items, nextCursor: res.documents.at(-1)?.$id ?? null, hasMore: res.total > items.length };
      },
      async transfer(input, meta): Promise<Result> {
        return execute<Result>('/api/wallet/transfer', 'POST', {
          ...input,
          idempotencyKey: meta.idempotencyKey,
          clientTimestamp: meta.clientTimestamp,
        });
      },
    },

    admin: {
      async overview() {
        return execute<AdminOverview>('/api/admin/overview', 'GET');
      },
      async listUsers() {
        const res = await client.databases.listDocuments(db, col.users, [orderDesc('createdAt'), limit(100)]);
        return res.documents.map((doc) =>
          UserProfileSchema.parse({
            ...docData(doc),
            id: doc.$id,
            createdAt: docData(doc).createdAt ?? doc.$createdAt,
            updatedAt: docData(doc).updatedAt ?? doc.$updatedAt,
          }),
        );
      },
      async act(action, meta): Promise<Result> {
        return execute<Result>('/api/admin/users/action', 'POST', {
          action,
          idempotencyKey: meta.idempotencyKey,
          clientTimestamp: meta.clientTimestamp,
        });
      },
      async audit() {
        return execute<never[]>('/api/admin/audit', 'GET') as Promise<never[]>;
      },
    },

    realtime: {
      subscribeQuotes(symbols, onQuote) {
        let closed = false;
        let unsub: (() => void) | null = null;
        if (client.realtime) {
          try {
            unsub = client.realtime.subscribe(
              [`databases.${db}.collections.${col.assets ?? 'assets'}.documents`],
              (event: AppwriteRealtimeEvent) => {
                const payload = event.payload;
                const symbol = String(payload.symbol ?? '').toUpperCase();
                if (!symbols.includes(symbol)) return;
                const parsed = QuoteSchema.safeParse({
                  ...payload,
                  symbol,
                  asOf: payload.asOf ?? new Date().toISOString(),
                  updatedAt: payload.updatedAt ?? new Date().toISOString(),
                });
                if (parsed.success) onQuote(parsed.data);
              },
            );
          } catch {
            unsub = null;
          }
        }
        const timer = setInterval(() => {
          if (closed) return;
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
        if (!client.realtime) return () => undefined;
        try {
          return client.realtime.subscribe(
            [`databases.${db}.collections.${col.messages}.documents`],
            (event) => {
              const payload = event.payload;
              if (payload.conversationId !== conversationId) return;
              try {
                onMessage(mapMessage(payload as unknown as AppwriteDocument));
              } catch {
                /* ignore malformed realtime payloads; the cursor resync covers it */
              }
            },
          );
        } catch {
          return () => undefined;
        }
      },
    },
  };

  return backend;
}
