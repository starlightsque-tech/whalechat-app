import { z } from 'zod';

export const IsoDateSchema = z.string().datetime({ offset: true });
export type IsoDate = z.infer<typeof IsoDateSchema>;

export const CurrencySchema = z.string().min(2).max(8).transform((v) => v.toUpperCase());
export type Currency = z.infer<typeof CurrencySchema>;

export const MoneySchema = z.object({
  /** integer minor units — never a float */
  amountMinor: z.number().int(),
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

export const PaginationSchema = z.object({
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const SyncStatusSchema = z.enum([
  'booting',
  'offline',
  'connecting',
  'syncing',
  'online',
  'error',
]);
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const ConnectionStateSchema = z.object({
  online: z.boolean(),
  status: SyncStatusSchema,
  pendingCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  lastSyncedAt: IsoDateSchema.nullable(),
  lastError: z.string().nullable(),
});
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const PageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });

export type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };

export const ResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  replayed: z.boolean().optional(),
});
export type Result = z.infer<typeof ResultSchema>;
