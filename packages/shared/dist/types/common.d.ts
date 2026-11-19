import { z } from 'zod';
export declare const IsoDateSchema: z.ZodString;
export type IsoDate = z.infer<typeof IsoDateSchema>;
export declare const CurrencySchema: z.ZodEffects<z.ZodString, string, string>;
export type Currency = z.infer<typeof CurrencySchema>;
export declare const MoneySchema: z.ZodObject<{
    /** integer minor units — never a float */
    amountMinor: z.ZodNumber;
    currency: z.ZodEffects<z.ZodString, string, string>;
}, "strip", z.ZodTypeAny, {
    amountMinor: number;
    currency: string;
}, {
    amountMinor: number;
    currency: string;
}>;
export type Money = z.infer<typeof MoneySchema>;
export declare const PaginationSchema: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    cursor?: string | null | undefined;
}, {
    cursor?: string | null | undefined;
    limit?: number | undefined;
}>;
export type Pagination = z.infer<typeof PaginationSchema>;
export declare const SyncStatusSchema: z.ZodEnum<["booting", "offline", "connecting", "syncing", "online", "error"]>;
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
export declare const ConnectionStateSchema: z.ZodObject<{
    online: z.ZodBoolean;
    status: z.ZodEnum<["booting", "offline", "connecting", "syncing", "online", "error"]>;
    pendingCount: z.ZodNumber;
    failedCount: z.ZodNumber;
    lastSyncedAt: z.ZodNullable<z.ZodString>;
    lastError: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "booting" | "offline" | "connecting" | "syncing" | "online" | "error";
    online: boolean;
    pendingCount: number;
    failedCount: number;
    lastSyncedAt: string | null;
    lastError: string | null;
}, {
    status: "booting" | "offline" | "connecting" | "syncing" | "online" | "error";
    online: boolean;
    pendingCount: number;
    failedCount: number;
    lastSyncedAt: string | null;
    lastError: string | null;
}>;
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
export declare const PageSchema: <T extends z.ZodTypeAny>(item: T) => z.ZodObject<{
    items: z.ZodArray<T, "many">;
    nextCursor: z.ZodNullable<z.ZodString>;
    hasMore: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    items: T["_output"][];
    nextCursor: string | null;
    hasMore: boolean;
}, {
    items: T["_input"][];
    nextCursor: string | null;
    hasMore: boolean;
}>;
export type Page<T> = {
    items: T[];
    nextCursor: string | null;
    hasMore: boolean;
};
export declare const ResultSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    message: z.ZodOptional<z.ZodString>;
    replayed: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    ok: boolean;
    message?: string | undefined;
    replayed?: boolean | undefined;
}, {
    ok: boolean;
    message?: string | undefined;
    replayed?: boolean | undefined;
}>;
export type Result = z.infer<typeof ResultSchema>;
//# sourceMappingURL=common.d.ts.map