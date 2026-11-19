import { z } from 'zod';
export const IsoDateSchema = z.string().datetime({ offset: true });
export const CurrencySchema = z.string().min(2).max(8).transform((v) => v.toUpperCase());
export const MoneySchema = z.object({
    /** integer minor units — never a float */
    amountMinor: z.number().int(),
    currency: CurrencySchema,
});
export const PaginationSchema = z.object({
    cursor: z.string().nullish(),
    limit: z.number().int().min(1).max(100).default(25),
});
export const SyncStatusSchema = z.enum([
    'booting',
    'offline',
    'connecting',
    'syncing',
    'online',
    'error',
]);
export const ConnectionStateSchema = z.object({
    online: z.boolean(),
    status: SyncStatusSchema,
    pendingCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    lastSyncedAt: IsoDateSchema.nullable(),
    lastError: z.string().nullable(),
});
export const PageSchema = (item) => z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
});
export const ResultSchema = z.object({
    ok: z.boolean(),
    message: z.string().optional(),
    replayed: z.boolean().optional(),
});
//# sourceMappingURL=common.js.map