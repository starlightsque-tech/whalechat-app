import { z } from 'zod';
import { CurrencySchema, IsoDateSchema, MoneySchema } from './common.js';
export const UserRoleSchema = z.enum(['user', 'support', 'admin', 'superadmin']);
export const UserProfileSchema = z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().nullable().default(null),
    phoneVerified: z.boolean().default(false),
    avatarUrl: z.string().url().nullable().default(null),
    role: UserRoleSchema.default('user'),
    status: z.enum(['active', 'suspended', 'deleted']).default('active'),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
});
export const WalletSchema = z.object({
    id: z.string(),
    userId: z.string(),
    /** authoritative balances in minor units, keyed by currency */
    balances: z.record(CurrencySchema, z.number().int()),
    /** funds reserved by pending offline/financial outbox operations */
    locked: z.record(CurrencySchema, z.number().int()).default({}),
    version: z.number().int().nonnegative().default(0),
    updatedAt: IsoDateSchema,
});
export const LedgerEntryTypeSchema = z.enum([
    'deposit',
    'withdrawal',
    'trade_debit',
    'trade_credit',
    'order_debit',
    'order_refund',
    'escrow_hold',
    'escrow_release',
    'transfer_in',
    'transfer_out',
    'fee',
    'adjustment',
]);
export const LedgerTransactionSchema = z.object({
    id: z.string(),
    userId: z.string(),
    type: LedgerEntryTypeSchema,
    amount: MoneySchema,
    balanceAfterMinor: z.number().int(),
    referenceId: z.string().nullable().default(null),
    idempotencyKey: z.string().min(8),
    description: z.string().default(''),
    createdAt: IsoDateSchema,
});
export const WalletSnapshotSchema = z.object({
    wallet: WalletSchema,
    ledger: z.array(LedgerTransactionSchema),
    fetchedAt: IsoDateSchema,
});
//# sourceMappingURL=user.js.map