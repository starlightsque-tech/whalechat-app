import { z } from 'zod';
import { IsoDateSchema, MoneySchema } from './common.js';
export const AssetClassSchema = z.enum(['equity', 'etf', 'crypto', 'fx', 'commodity', 'index']);
export const AssetSchema = z.object({
    symbol: z.string().min(1).max(16).transform((s) => s.toUpperCase()),
    name: z.string(),
    exchange: z.string().default('NASDAQ'),
    assetClass: AssetClassSchema.default('equity'),
    currency: z.string().default('USD'),
    logoUrl: z.string().default(''),
    sector: z.string().default(''),
    active: z.boolean().default(true),
    updatedAt: IsoDateSchema,
});
export const QuoteSchema = z.object({
    symbol: z.string(),
    price: z.number().positive(),
    previousClose: z.number().positive(),
    open: z.number().positive().default(0),
    high: z.number().positive().default(0),
    low: z.number().positive().default(0),
    change: z.number().default(0),
    changePercent: z.number().default(0),
    volume: z.number().nonnegative().default(0),
    currency: z.string().default('USD'),
    /** live | delayed | otc | simulated */
    source: z.enum(['live', 'delayed', 'otc', 'simulated']).default('simulated'),
    asOf: IsoDateSchema,
    updatedAt: IsoDateSchema,
});
export const CandleSchema = z.object({
    time: z.number().int(),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    volume: z.number().nonnegative().default(0),
});
export const TradeSideSchema = z.enum(['buy', 'sell']);
export const TradeStatusSchema = z.enum([
    'pending_sync',
    'pending',
    'filled',
    'partially_filled',
    'rejected',
    'cancelled',
    'failed',
]);
export const TradeSchema = z.object({
    id: z.string(),
    userId: z.string(),
    symbol: z.string(),
    side: TradeSideSchema,
    quantity: z.number().positive(),
    /** limit price; null = market */
    limitPrice: z.number().positive().nullable().default(null),
    filledPrice: z.number().nullable().default(null),
    status: TradeStatusSchema,
    fees: MoneySchema,
    notional: MoneySchema,
    idempotencyKey: z.string().min(8),
    /** the local execution price honoured by the server inside the tolerance band */
    offlineExecutionPrice: z.number().nullable().default(null),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
});
export const PositionSchema = z.object({
    symbol: z.string(),
    quantity: z.number(),
    averagePrice: z.number(),
    marketPrice: z.number(),
    marketValueMinor: z.number().int(),
    unrealizedPnlMinor: z.number().int(),
    updatedAt: IsoDateSchema,
});
export const PortfolioPointSchema = z.object({
    time: z.number().int(),
    valueMinor: z.number().int(),
});
export const PortfolioSchema = z.object({
    userId: z.string(),
    cash: MoneySchema,
    positions: z.array(PositionSchema),
    totalValue: MoneySchema,
    totalPnl: MoneySchema,
    history: z.array(PortfolioPointSchema).default([]),
    updatedAt: IsoDateSchema,
});
export const PlaceTradeInputSchema = z.object({
    symbol: z.string().min(1),
    side: TradeSideSchema,
    quantity: z.number().positive(),
    limitPrice: z.number().positive().nullable().default(null),
    currency: z.string().default('USD'),
});
//# sourceMappingURL=trade.js.map