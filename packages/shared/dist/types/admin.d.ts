import { z } from 'zod';
export declare const AdminAuditEventSchema: z.ZodObject<{
    id: z.ZodString;
    actorId: z.ZodString;
    action: z.ZodString;
    entity: z.ZodString;
    entityId: z.ZodString;
    before: z.ZodOptional<z.ZodUnknown>;
    after: z.ZodOptional<z.ZodUnknown>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    createdAt: string;
    actorId: string;
    action: string;
    entity: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
}, {
    id: string;
    createdAt: string;
    actorId: string;
    action: string;
    entity: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
}>;
export type AdminAuditEvent = z.infer<typeof AdminAuditEventSchema>;
export declare const AdminOverviewSchema: z.ZodObject<{
    users: z.ZodNumber;
    activeUsers24h: z.ZodNumber;
    orders: z.ZodNumber;
    escrowHeldMinor: z.ZodNumber;
    trades24h: z.ZodNumber;
    volume24hMinor: z.ZodNumber;
    openTickets: z.ZodNumber;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    updatedAt: string;
    users: number;
    activeUsers24h: number;
    orders: number;
    escrowHeldMinor: number;
    trades24h: number;
    volume24hMinor: number;
    openTickets: number;
}, {
    updatedAt: string;
    users: number;
    activeUsers24h: number;
    orders: number;
    escrowHeldMinor: number;
    trades24h: number;
    volume24hMinor: number;
    openTickets: number;
}>;
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;
export declare const AdminUserActionSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"suspend">;
    userId: z.ZodString;
    reason: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "suspend";
    userId: string;
    reason: string;
}, {
    type: "suspend";
    userId: string;
    reason?: string | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"reinstate">;
    userId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "reinstate";
    userId: string;
}, {
    type: "reinstate";
    userId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"set_role">;
    userId: z.ZodString;
    role: z.ZodEnum<["user", "support", "admin"]>;
}, "strip", z.ZodTypeAny, {
    type: "set_role";
    role: "user" | "support" | "admin";
    userId: string;
}, {
    type: "set_role";
    role: "user" | "support" | "admin";
    userId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"adjust_wallet">;
    userId: z.ZodString;
    currency: z.ZodString;
    amountMinor: z.ZodNumber;
    reason: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "adjust_wallet";
    amountMinor: number;
    currency: string;
    userId: string;
    reason: string;
}, {
    type: "adjust_wallet";
    amountMinor: number;
    currency: string;
    userId: string;
    reason: string;
}>]>;
export type AdminUserAction = z.infer<typeof AdminUserActionSchema>;
export declare const AdminOrderActionSchema: z.ZodObject<{
    orderId: z.ZodString;
    status: z.ZodEnum<["draft", "pending_sync", "awaiting_payment", "paid_escrow", "processing", "shipped", "delivered", "completed", "cancelled", "refunded", "failed"]>;
    note: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "delivered" | "failed" | "draft" | "pending_sync" | "awaiting_payment" | "paid_escrow" | "processing" | "shipped" | "completed" | "cancelled" | "refunded";
    note: string;
    orderId: string;
}, {
    status: "delivered" | "failed" | "draft" | "pending_sync" | "awaiting_payment" | "paid_escrow" | "processing" | "shipped" | "completed" | "cancelled" | "refunded";
    orderId: string;
    note?: string | undefined;
}>;
export type AdminOrderAction = z.infer<typeof AdminOrderActionSchema>;
export declare const AdminTradeActionSchema: z.ZodObject<{
    tradeId: z.ZodString;
    status: z.ZodEnum<["pending_sync", "pending", "filled", "partially_filled", "rejected", "cancelled", "failed"]>;
    note: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "failed" | "pending_sync" | "cancelled" | "pending" | "filled" | "partially_filled" | "rejected";
    note: string;
    tradeId: string;
}, {
    status: "failed" | "pending_sync" | "cancelled" | "pending" | "filled" | "partially_filled" | "rejected";
    tradeId: string;
    note?: string | undefined;
}>;
export type AdminTradeAction = z.infer<typeof AdminTradeActionSchema>;
//# sourceMappingURL=admin.d.ts.map