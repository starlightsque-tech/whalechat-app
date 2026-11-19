import { z } from 'zod';
import { CurrencySchema, IsoDateSchema, MoneySchema } from './common.js';
export const ProductSchema = z.object({
    id: z.string(),
    sellerId: z.string(),
    title: z.string().min(1),
    description: z.string().default(''),
    price: MoneySchema,
    compareAtPrice: MoneySchema.nullable().default(null),
    imageUrl: z.string().default(''),
    category: z.string().default('general'),
    stock: z.number().int().nonnegative().default(0),
    rating: z.number().min(0).max(5).default(0),
    tags: z.array(z.string()).default([]),
    active: z.boolean().default(true),
    updatedAt: IsoDateSchema,
});
export const CartItemSchema = z.object({
    productId: z.string(),
    title: z.string(),
    unitPrice: MoneySchema,
    quantity: z.number().int().positive(),
    imageUrl: z.string().default(''),
});
export const CartSchema = z.object({
    items: z.array(CartItemSchema).default([]),
    updatedAt: IsoDateSchema,
});
export const OrderStatusSchema = z.enum([
    'draft',
    'pending_sync',
    'awaiting_payment',
    'paid_escrow',
    'processing',
    'shipped',
    'delivered',
    'completed',
    'cancelled',
    'refunded',
    'failed',
]);
export const OrderItemSchema = z.object({
    productId: z.string(),
    title: z.string(),
    unitPrice: MoneySchema,
    quantity: z.number().int().positive(),
});
export const OrderSchema = z.object({
    id: z.string(),
    userId: z.string(),
    items: z.array(OrderItemSchema).min(1),
    subtotal: MoneySchema,
    shipping: MoneySchema,
    total: MoneySchema,
    status: OrderStatusSchema,
    escrow: z.object({
        held: z.boolean().default(false),
        releasedAt: IsoDateSchema.nullable().default(null),
        releaseAfter: IsoDateSchema.nullable().default(null),
    }),
    placedAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
    idempotencyKey: z.string(),
});
export const CheckoutInputSchema = z.object({
    items: z.array(CartItemSchema).min(1),
    currency: CurrencySchema.default('USD'),
    shippingMinor: z.number().int().nonnegative().default(0),
    note: z.string().max(500).default(''),
});
//# sourceMappingURL=shop.js.map