import { z } from 'zod';
export declare const AssetClassSchema: z.ZodEnum<["equity", "etf", "crypto", "fx", "commodity", "index"]>;
export type AssetClass = z.infer<typeof AssetClassSchema>;
export declare const AssetSchema: z.ZodObject<{
    symbol: z.ZodEffects<z.ZodString, string, string>;
    name: z.ZodString;
    exchange: z.ZodDefault<z.ZodString>;
    assetClass: z.ZodDefault<z.ZodEnum<["equity", "etf", "crypto", "fx", "commodity", "index"]>>;
    currency: z.ZodDefault<z.ZodString>;
    logoUrl: z.ZodDefault<z.ZodString>;
    sector: z.ZodDefault<z.ZodString>;
    active: z.ZodDefault<z.ZodBoolean>;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    symbol: string;
    currency: string;
    active: boolean;
    updatedAt: string;
    name: string;
    exchange: string;
    assetClass: "equity" | "etf" | "crypto" | "fx" | "commodity" | "index";
    logoUrl: string;
    sector: string;
}, {
    symbol: string;
    updatedAt: string;
    name: string;
    currency?: string | undefined;
    active?: boolean | undefined;
    exchange?: string | undefined;
    assetClass?: "equity" | "etf" | "crypto" | "fx" | "commodity" | "index" | undefined;
    logoUrl?: string | undefined;
    sector?: string | undefined;
}>;
export type Asset = z.infer<typeof AssetSchema>;
export declare const QuoteSchema: z.ZodObject<{
    symbol: z.ZodString;
    price: z.ZodNumber;
    previousClose: z.ZodNumber;
    open: z.ZodDefault<z.ZodNumber>;
    high: z.ZodDefault<z.ZodNumber>;
    low: z.ZodDefault<z.ZodNumber>;
    change: z.ZodDefault<z.ZodNumber>;
    changePercent: z.ZodDefault<z.ZodNumber>;
    volume: z.ZodDefault<z.ZodNumber>;
    currency: z.ZodDefault<z.ZodString>;
    /** live | delayed | otc | simulated */
    source: z.ZodDefault<z.ZodEnum<["live", "delayed", "otc", "simulated"]>>;
    asOf: z.ZodString;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    symbol: string;
    currency: string;
    updatedAt: string;
    price: number;
    previousClose: number;
    open: number;
    high: number;
    low: number;
    change: number;
    changePercent: number;
    volume: number;
    source: "live" | "delayed" | "otc" | "simulated";
    asOf: string;
}, {
    symbol: string;
    updatedAt: string;
    price: number;
    previousClose: number;
    asOf: string;
    currency?: string | undefined;
    open?: number | undefined;
    high?: number | undefined;
    low?: number | undefined;
    change?: number | undefined;
    changePercent?: number | undefined;
    volume?: number | undefined;
    source?: "live" | "delayed" | "otc" | "simulated" | undefined;
}>;
export type Quote = z.infer<typeof QuoteSchema>;
export declare const CandleSchema: z.ZodObject<{
    time: z.ZodNumber;
    open: z.ZodNumber;
    high: z.ZodNumber;
    low: z.ZodNumber;
    close: z.ZodNumber;
    volume: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    open: number;
    high: number;
    low: number;
    volume: number;
    time: number;
    close: number;
}, {
    open: number;
    high: number;
    low: number;
    time: number;
    close: number;
    volume?: number | undefined;
}>;
export type Candle = z.infer<typeof CandleSchema>;
export declare const TradeSideSchema: z.ZodEnum<["buy", "sell"]>;
export type TradeSide = z.infer<typeof TradeSideSchema>;
export declare const TradeStatusSchema: z.ZodEnum<["pending_sync", "pending", "filled", "partially_filled", "rejected", "cancelled", "failed"]>;
export type TradeStatus = z.infer<typeof TradeStatusSchema>;
export declare const TradeSchema: z.ZodObject<{
    id: z.ZodString;
    userId: z.ZodString;
    symbol: z.ZodString;
    side: z.ZodEnum<["buy", "sell"]>;
    quantity: z.ZodNumber;
    /** limit price; null = market */
    limitPrice: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    filledPrice: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    status: z.ZodEnum<["pending_sync", "pending", "filled", "partially_filled", "rejected", "cancelled", "failed"]>;
    fees: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    notional: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    idempotencyKey: z.ZodString;
    /** the local execution price honoured by the server inside the tolerance band */
    offlineExecutionPrice: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    symbol: string;
    status: "failed" | "pending_sync" | "cancelled" | "pending" | "filled" | "partially_filled" | "rejected";
    id: string;
    createdAt: string;
    updatedAt: string;
    userId: string;
    idempotencyKey: string;
    quantity: number;
    side: "buy" | "sell";
    limitPrice: number | null;
    filledPrice: number | null;
    fees: {
        amountMinor: number;
        currency: string;
    };
    notional: {
        amountMinor: number;
        currency: string;
    };
    offlineExecutionPrice: number | null;
}, {
    symbol: string;
    status: "failed" | "pending_sync" | "cancelled" | "pending" | "filled" | "partially_filled" | "rejected";
    id: string;
    createdAt: string;
    updatedAt: string;
    userId: string;
    idempotencyKey: string;
    quantity: number;
    side: "buy" | "sell";
    fees: {
        amountMinor: number;
        currency: string;
    };
    notional: {
        amountMinor: number;
        currency: string;
    };
    limitPrice?: number | null | undefined;
    filledPrice?: number | null | undefined;
    offlineExecutionPrice?: number | null | undefined;
}>;
export type Trade = z.infer<typeof TradeSchema>;
export declare const PositionSchema: z.ZodObject<{
    symbol: z.ZodString;
    quantity: z.ZodNumber;
    averagePrice: z.ZodNumber;
    marketPrice: z.ZodNumber;
    marketValueMinor: z.ZodNumber;
    unrealizedPnlMinor: z.ZodNumber;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    symbol: string;
    updatedAt: string;
    quantity: number;
    averagePrice: number;
    marketPrice: number;
    marketValueMinor: number;
    unrealizedPnlMinor: number;
}, {
    symbol: string;
    updatedAt: string;
    quantity: number;
    averagePrice: number;
    marketPrice: number;
    marketValueMinor: number;
    unrealizedPnlMinor: number;
}>;
export type Position = z.infer<typeof PositionSchema>;
export declare const PortfolioPointSchema: z.ZodObject<{
    time: z.ZodNumber;
    valueMinor: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    time: number;
    valueMinor: number;
}, {
    time: number;
    valueMinor: number;
}>;
export type PortfolioPoint = z.infer<typeof PortfolioPointSchema>;
export declare const PortfolioSchema: z.ZodObject<{
    userId: z.ZodString;
    cash: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    positions: z.ZodArray<z.ZodObject<{
        symbol: z.ZodString;
        quantity: z.ZodNumber;
        averagePrice: z.ZodNumber;
        marketPrice: z.ZodNumber;
        marketValueMinor: z.ZodNumber;
        unrealizedPnlMinor: z.ZodNumber;
        updatedAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        symbol: string;
        updatedAt: string;
        quantity: number;
        averagePrice: number;
        marketPrice: number;
        marketValueMinor: number;
        unrealizedPnlMinor: number;
    }, {
        symbol: string;
        updatedAt: string;
        quantity: number;
        averagePrice: number;
        marketPrice: number;
        marketValueMinor: number;
        unrealizedPnlMinor: number;
    }>, "many">;
    totalValue: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    totalPnl: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    history: z.ZodDefault<z.ZodArray<z.ZodObject<{
        time: z.ZodNumber;
        valueMinor: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        time: number;
        valueMinor: number;
    }, {
        time: number;
        valueMinor: number;
    }>, "many">>;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    updatedAt: string;
    userId: string;
    cash: {
        amountMinor: number;
        currency: string;
    };
    positions: {
        symbol: string;
        updatedAt: string;
        quantity: number;
        averagePrice: number;
        marketPrice: number;
        marketValueMinor: number;
        unrealizedPnlMinor: number;
    }[];
    totalValue: {
        amountMinor: number;
        currency: string;
    };
    totalPnl: {
        amountMinor: number;
        currency: string;
    };
    history: {
        time: number;
        valueMinor: number;
    }[];
}, {
    updatedAt: string;
    userId: string;
    cash: {
        amountMinor: number;
        currency: string;
    };
    positions: {
        symbol: string;
        updatedAt: string;
        quantity: number;
        averagePrice: number;
        marketPrice: number;
        marketValueMinor: number;
        unrealizedPnlMinor: number;
    }[];
    totalValue: {
        amountMinor: number;
        currency: string;
    };
    totalPnl: {
        amountMinor: number;
        currency: string;
    };
    history?: {
        time: number;
        valueMinor: number;
    }[] | undefined;
}>;
export type Portfolio = z.infer<typeof PortfolioSchema>;
export declare const PlaceTradeInputSchema: z.ZodObject<{
    symbol: z.ZodString;
    side: z.ZodEnum<["buy", "sell"]>;
    quantity: z.ZodNumber;
    limitPrice: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    currency: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    symbol: string;
    currency: string;
    quantity: number;
    side: "buy" | "sell";
    limitPrice: number | null;
}, {
    symbol: string;
    quantity: number;
    side: "buy" | "sell";
    currency?: string | undefined;
    limitPrice?: number | null | undefined;
}>;
export type PlaceTradeInput = z.infer<typeof PlaceTradeInputSchema>;
//# sourceMappingURL=trade.d.ts.map