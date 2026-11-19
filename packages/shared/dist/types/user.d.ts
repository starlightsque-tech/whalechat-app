import { z } from 'zod';
export declare const UserRoleSchema: z.ZodEnum<["user", "support", "admin", "superadmin"]>;
export type UserRole = z.infer<typeof UserRoleSchema>;
export declare const UserProfileSchema: z.ZodObject<{
    id: z.ZodString;
    displayName: z.ZodString;
    email: z.ZodString;
    phone: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    phoneVerified: z.ZodDefault<z.ZodBoolean>;
    avatarUrl: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    role: z.ZodDefault<z.ZodEnum<["user", "support", "admin", "superadmin"]>>;
    status: z.ZodDefault<z.ZodEnum<["active", "suspended", "deleted"]>>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "active" | "suspended" | "deleted";
    id: string;
    displayName: string;
    email: string;
    phone: string | null;
    phoneVerified: boolean;
    avatarUrl: string | null;
    role: "user" | "support" | "admin" | "superadmin";
    createdAt: string;
    updatedAt: string;
}, {
    id: string;
    displayName: string;
    email: string;
    createdAt: string;
    updatedAt: string;
    status?: "active" | "suspended" | "deleted" | undefined;
    phone?: string | null | undefined;
    phoneVerified?: boolean | undefined;
    avatarUrl?: string | null | undefined;
    role?: "user" | "support" | "admin" | "superadmin" | undefined;
}>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export declare const WalletSchema: z.ZodObject<{
    id: z.ZodString;
    userId: z.ZodString;
    /** authoritative balances in minor units, keyed by currency */
    balances: z.ZodRecord<z.ZodEffects<z.ZodString, string, string>, z.ZodNumber>;
    /** funds reserved by pending offline/financial outbox operations */
    locked: z.ZodDefault<z.ZodRecord<z.ZodEffects<z.ZodString, string, string>, z.ZodNumber>>;
    version: z.ZodDefault<z.ZodNumber>;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    updatedAt: string;
    userId: string;
    balances: Record<string, number>;
    locked: Record<string, number>;
    version: number;
}, {
    id: string;
    updatedAt: string;
    userId: string;
    balances: Record<string, number>;
    locked?: Record<string, number> | undefined;
    version?: number | undefined;
}>;
export type Wallet = z.infer<typeof WalletSchema>;
export declare const LedgerEntryTypeSchema: z.ZodEnum<["deposit", "withdrawal", "trade_debit", "trade_credit", "order_debit", "order_refund", "escrow_hold", "escrow_release", "transfer_in", "transfer_out", "fee", "adjustment"]>;
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;
export declare const LedgerTransactionSchema: z.ZodObject<{
    id: z.ZodString;
    userId: z.ZodString;
    type: z.ZodEnum<["deposit", "withdrawal", "trade_debit", "trade_credit", "order_debit", "order_refund", "escrow_hold", "escrow_release", "transfer_in", "transfer_out", "fee", "adjustment"]>;
    amount: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    balanceAfterMinor: z.ZodNumber;
    referenceId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    idempotencyKey: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "deposit" | "withdrawal" | "trade_debit" | "trade_credit" | "order_debit" | "order_refund" | "escrow_hold" | "escrow_release" | "transfer_in" | "transfer_out" | "fee" | "adjustment";
    id: string;
    createdAt: string;
    userId: string;
    amount: {
        amountMinor: number;
        currency: string;
    };
    balanceAfterMinor: number;
    referenceId: string | null;
    idempotencyKey: string;
    description: string;
}, {
    type: "deposit" | "withdrawal" | "trade_debit" | "trade_credit" | "order_debit" | "order_refund" | "escrow_hold" | "escrow_release" | "transfer_in" | "transfer_out" | "fee" | "adjustment";
    id: string;
    createdAt: string;
    userId: string;
    amount: {
        amountMinor: number;
        currency: string;
    };
    balanceAfterMinor: number;
    idempotencyKey: string;
    referenceId?: string | null | undefined;
    description?: string | undefined;
}>;
export type LedgerTransaction = z.infer<typeof LedgerTransactionSchema>;
export declare const WalletSnapshotSchema: z.ZodObject<{
    wallet: z.ZodObject<{
        id: z.ZodString;
        userId: z.ZodString;
        /** authoritative balances in minor units, keyed by currency */
        balances: z.ZodRecord<z.ZodEffects<z.ZodString, string, string>, z.ZodNumber>;
        /** funds reserved by pending offline/financial outbox operations */
        locked: z.ZodDefault<z.ZodRecord<z.ZodEffects<z.ZodString, string, string>, z.ZodNumber>>;
        version: z.ZodDefault<z.ZodNumber>;
        updatedAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        updatedAt: string;
        userId: string;
        balances: Record<string, number>;
        locked: Record<string, number>;
        version: number;
    }, {
        id: string;
        updatedAt: string;
        userId: string;
        balances: Record<string, number>;
        locked?: Record<string, number> | undefined;
        version?: number | undefined;
    }>;
    ledger: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        userId: z.ZodString;
        type: z.ZodEnum<["deposit", "withdrawal", "trade_debit", "trade_credit", "order_debit", "order_refund", "escrow_hold", "escrow_release", "transfer_in", "transfer_out", "fee", "adjustment"]>;
        amount: z.ZodObject<{
            amountMinor: z.ZodNumber;
            currency: z.ZodEffects<z.ZodString, string, string>;
        }, "strip", z.ZodTypeAny, {
            amountMinor: number;
            currency: string;
        }, {
            amountMinor: number;
            currency: string;
        }>;
        balanceAfterMinor: z.ZodNumber;
        referenceId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        idempotencyKey: z.ZodString;
        description: z.ZodDefault<z.ZodString>;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "deposit" | "withdrawal" | "trade_debit" | "trade_credit" | "order_debit" | "order_refund" | "escrow_hold" | "escrow_release" | "transfer_in" | "transfer_out" | "fee" | "adjustment";
        id: string;
        createdAt: string;
        userId: string;
        amount: {
            amountMinor: number;
            currency: string;
        };
        balanceAfterMinor: number;
        referenceId: string | null;
        idempotencyKey: string;
        description: string;
    }, {
        type: "deposit" | "withdrawal" | "trade_debit" | "trade_credit" | "order_debit" | "order_refund" | "escrow_hold" | "escrow_release" | "transfer_in" | "transfer_out" | "fee" | "adjustment";
        id: string;
        createdAt: string;
        userId: string;
        amount: {
            amountMinor: number;
            currency: string;
        };
        balanceAfterMinor: number;
        idempotencyKey: string;
        referenceId?: string | null | undefined;
        description?: string | undefined;
    }>, "many">;
    fetchedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    wallet: {
        id: string;
        updatedAt: string;
        userId: string;
        balances: Record<string, number>;
        locked: Record<string, number>;
        version: number;
    };
    ledger: {
        type: "deposit" | "withdrawal" | "trade_debit" | "trade_credit" | "order_debit" | "order_refund" | "escrow_hold" | "escrow_release" | "transfer_in" | "transfer_out" | "fee" | "adjustment";
        id: string;
        createdAt: string;
        userId: string;
        amount: {
            amountMinor: number;
            currency: string;
        };
        balanceAfterMinor: number;
        referenceId: string | null;
        idempotencyKey: string;
        description: string;
    }[];
    fetchedAt: string;
}, {
    wallet: {
        id: string;
        updatedAt: string;
        userId: string;
        balances: Record<string, number>;
        locked?: Record<string, number> | undefined;
        version?: number | undefined;
    };
    ledger: {
        type: "deposit" | "withdrawal" | "trade_debit" | "trade_credit" | "order_debit" | "order_refund" | "escrow_hold" | "escrow_release" | "transfer_in" | "transfer_out" | "fee" | "adjustment";
        id: string;
        createdAt: string;
        userId: string;
        amount: {
            amountMinor: number;
            currency: string;
        };
        balanceAfterMinor: number;
        idempotencyKey: string;
        referenceId?: string | null | undefined;
        description?: string | undefined;
    }[];
    fetchedAt: string;
}>;
export type WalletSnapshot = z.infer<typeof WalletSnapshotSchema>;
//# sourceMappingURL=user.d.ts.map