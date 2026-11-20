import { z } from 'zod';
import { IsoDateSchema } from './common.js';
import { OrderStatusSchema } from './shop.js';
import { TradeStatusSchema } from './trade.js';

export const AdminAuditEventSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  createdAt: IsoDateSchema,
});
export type AdminAuditEvent = z.infer<typeof AdminAuditEventSchema>;

export const AdminOverviewSchema = z.object({
  users: z.number().int().nonnegative(),
  activeUsers24h: z.number().int().nonnegative(),
  orders: z.number().int().nonnegative(),
  escrowHeldMinor: z.number().int().nonnegative(),
  trades24h: z.number().int().nonnegative(),
  volume24hMinor: z.number().int().nonnegative(),
  openTickets: z.number().int().nonnegative(),
  updatedAt: IsoDateSchema,
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

export const AdminUserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('suspend'), userId: z.string(), reason: z.string().default('') }),
  z.object({ type: z.literal('reinstate'), userId: z.string() }),
  z.object({ type: z.literal('set_role'), userId: z.string(), role: z.enum(['user', 'support', 'admin']) }),
  z.object({
    type: z.literal('adjust_wallet'),
    userId: z.string(),
    currency: z.string(),
    amountMinor: z.number().int(),
    reason: z.string().min(3),
  }),
]);
export type AdminUserAction = z.infer<typeof AdminUserActionSchema>;

export const AdminOrderActionSchema = z.object({
  orderId: z.string(),
  status: OrderStatusSchema,
  note: z.string().default(''),
});
export type AdminOrderAction = z.infer<typeof AdminOrderActionSchema>;

export const AdminTradeActionSchema = z.object({
  tradeId: z.string(),
  status: TradeStatusSchema,
  note: z.string().default(''),
});
export type AdminTradeAction = z.infer<typeof AdminTradeActionSchema>;
