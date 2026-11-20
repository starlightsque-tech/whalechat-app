import { z } from 'zod';
import { IsoDateSchema, MoneySchema } from './common.js';

export const AssetClassSchema = z.enum(['equity', 'etf', 'crypto', 'fx', 'commodity', 'index']);
export type AssetClass = z.infer<typeof AssetClassSchema>;

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
export type Asset = z.infer<typeof AssetSchema>;

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
export type Quote = z.infer<typeof QuoteSchema>;

export const CandleSchema = z.object({
  time: z.number().int(),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  volume: z.number().nonnegative().default(0),
});
export type Candle = z.infer<typeof CandleSchema>;

export const TradeSideSchema = z.enum(['buy', 'sell']);
export type TradeSide = z.infer<typeof TradeSideSchema>;

export const TradeStatusSchema = z.enum([
  'pending_sync',
  'pending',
  'filled',
  'partially_filled',
  'rejected',
  'cancelled',
  'failed',
]);
export type TradeStatus = z.infer<typeof TradeStatusSchema>;

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
export type Trade = z.infer<typeof TradeSchema>;

export const PositionSchema = z.object({
  symbol: z.string(),
  quantity: z.number(),
  averagePrice: z.number(),
  marketPrice: z.number(),
  marketValueMinor: z.number().int(),
  unrealizedPnlMinor: z.number().int(),
  updatedAt: IsoDateSchema,
});
export type Position = z.infer<typeof PositionSchema>;

export const PortfolioPointSchema = z.object({
  time: z.number().int(),
  valueMinor: z.number().int(),
});
export type PortfolioPoint = z.infer<typeof PortfolioPointSchema>;

export const PortfolioSchema = z.object({
  userId: z.string(),
  cash: MoneySchema,
  positions: z.array(PositionSchema),
  totalValue: MoneySchema,
  totalPnl: MoneySchema,
  history: z.array(PortfolioPointSchema).default([]),
  updatedAt: IsoDateSchema,
});
export type Portfolio = z.infer<typeof PortfolioSchema>;

export const PlaceTradeInputSchema = z.object({
  symbol: z.string().min(1),
  side: TradeSideSchema,
  quantity: z.number().positive(),
  limitPrice: z.number().positive().nullable().default(null),
  currency: z.string().default('USD'),
});
export type PlaceTradeInput = z.infer<typeof PlaceTradeInputSchema>;
