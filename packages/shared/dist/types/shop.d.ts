import { z } from 'zod';
export declare const ProductSchema: z.ZodObject<{
    id: z.ZodString;
    sellerId: z.ZodString;
    title: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    price: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    compareAtPrice: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>>>;
    imageUrl: z.ZodDefault<z.ZodString>;
    category: z.ZodDefault<z.ZodString>;
    stock: z.ZodDefault<z.ZodNumber>;
    rating: z.ZodDefault<z.ZodNumber>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    active: z.ZodDefault<z.ZodBoolean>;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    active: boolean;
    updatedAt: string;
    description: string;
    title: string;
    sellerId: string;
    price: {
        amountMinor: number;
        currency: string;
    };
    compareAtPrice: {
        amountMinor: number;
        currency: string;
    } | null;
    imageUrl: string;
    category: string;
    stock: number;
    rating: number;
    tags: string[];
}, {
    id: string;
    updatedAt: string;
    title: string;
    sellerId: string;
    price: {
        amountMinor: number;
        currency: string;
    };
    active?: boolean | undefined;
    description?: string | undefined;
    compareAtPrice?: {
        amountMinor: number;
        currency: string;
    } | null | undefined;
    imageUrl?: string | undefined;
    category?: string | undefined;
    stock?: number | undefined;
    rating?: number | undefined;
    tags?: string[] | undefined;
}>;
export type Product = z.infer<typeof ProductSchema>;
export declare const CartItemSchema: z.ZodObject<{
    productId: z.ZodString;
    title: z.ZodString;
    unitPrice: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    quantity: z.ZodNumber;
    imageUrl: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    title: string;
    imageUrl: string;
    productId: string;
    unitPrice: {
        amountMinor: number;
        currency: string;
    };
    quantity: number;
}, {
    title: string;
    productId: string;
    unitPrice: {
        amountMinor: number;
        currency: string;
    };
    quantity: number;
    imageUrl?: string | undefined;
}>;
export type CartItem = z.infer<typeof CartItemSchema>;
export declare const CartSchema: z.ZodObject<{
    items: z.ZodDefault<z.ZodArray<z.ZodObject<{
        productId: z.ZodString;
        title: z.ZodString;
        unitPrice: z.ZodObject<{
            amountMinor: z.ZodNumber;
            currency: z.ZodEffects<z.ZodString, string, string>;
        }, "strip", z.ZodTypeAny, {
            amountMinor: number;
            currency: string;
        }, {
            amountMinor: number;
            currency: string;
        }>;
        quantity: z.ZodNumber;
        imageUrl: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        imageUrl: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
    }, {
        title: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
        imageUrl?: string | undefined;
    }>, "many">>;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    items: {
        title: string;
        imageUrl: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
    }[];
    updatedAt: string;
}, {
    updatedAt: string;
    items?: {
        title: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
        imageUrl?: string | undefined;
    }[] | undefined;
}>;
export type Cart = z.infer<typeof CartSchema>;
export declare const OrderStatusSchema: z.ZodEnum<["draft", "pending_sync", "awaiting_payment", "paid_escrow", "processing", "shipped", "delivered", "completed", "cancelled", "refunded", "failed"]>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export declare const OrderItemSchema: z.ZodObject<{
    productId: z.ZodString;
    title: z.ZodString;
    unitPrice: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    quantity: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    title: string;
    productId: string;
    unitPrice: {
        amountMinor: number;
        currency: string;
    };
    quantity: number;
}, {
    title: string;
    productId: string;
    unitPrice: {
        amountMinor: number;
        currency: string;
    };
    quantity: number;
}>;
export declare const OrderSchema: z.ZodObject<{
    id: z.ZodString;
    userId: z.ZodString;
    items: z.ZodArray<z.ZodObject<{
        productId: z.ZodString;
        title: z.ZodString;
        unitPrice: z.ZodObject<{
            amountMinor: z.ZodNumber;
            currency: z.ZodEffects<z.ZodString, string, string>;
        }, "strip", z.ZodTypeAny, {
            amountMinor: number;
            currency: string;
        }, {
            amountMinor: number;
            currency: string;
        }>;
        quantity: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        title: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
    }, {
        title: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
    }>, "many">;
    subtotal: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    shipping: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    total: z.ZodObject<{
        amountMinor: z.ZodNumber;
        currency: z.ZodEffects<z.ZodString, string, string>;
    }, "strip", z.ZodTypeAny, {
        amountMinor: number;
        currency: string;
    }, {
        amountMinor: number;
        currency: string;
    }>;
    status: z.ZodEnum<["draft", "pending_sync", "awaiting_payment", "paid_escrow", "processing", "shipped", "delivered", "completed", "cancelled", "refunded", "failed"]>;
    escrow: z.ZodObject<{
        held: z.ZodDefault<z.ZodBoolean>;
        releasedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        releaseAfter: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        held: boolean;
        releasedAt: string | null;
        releaseAfter: string | null;
    }, {
        held?: boolean | undefined;
        releasedAt?: string | null | undefined;
        releaseAfter?: string | null | undefined;
    }>;
    placedAt: z.ZodString;
    updatedAt: z.ZodString;
    idempotencyKey: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "delivered" | "failed" | "draft" | "pending_sync" | "awaiting_payment" | "paid_escrow" | "processing" | "shipped" | "completed" | "cancelled" | "refunded";
    items: {
        title: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
    }[];
    id: string;
    updatedAt: string;
    userId: string;
    idempotencyKey: string;
    subtotal: {
        amountMinor: number;
        currency: string;
    };
    shipping: {
        amountMinor: number;
        currency: string;
    };
    total: {
        amountMinor: number;
        currency: string;
    };
    escrow: {
        held: boolean;
        releasedAt: string | null;
        releaseAfter: string | null;
    };
    placedAt: string;
}, {
    status: "delivered" | "failed" | "draft" | "pending_sync" | "awaiting_payment" | "paid_escrow" | "processing" | "shipped" | "completed" | "cancelled" | "refunded";
    items: {
        title: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
    }[];
    id: string;
    updatedAt: string;
    userId: string;
    idempotencyKey: string;
    subtotal: {
        amountMinor: number;
        currency: string;
    };
    shipping: {
        amountMinor: number;
        currency: string;
    };
    total: {
        amountMinor: number;
        currency: string;
    };
    escrow: {
        held?: boolean | undefined;
        releasedAt?: string | null | undefined;
        releaseAfter?: string | null | undefined;
    };
    placedAt: string;
}>;
export type Order = z.infer<typeof OrderSchema>;
export declare const CheckoutInputSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        productId: z.ZodString;
        title: z.ZodString;
        unitPrice: z.ZodObject<{
            amountMinor: z.ZodNumber;
            currency: z.ZodEffects<z.ZodString, string, string>;
        }, "strip", z.ZodTypeAny, {
            amountMinor: number;
            currency: string;
        }, {
            amountMinor: number;
            currency: string;
        }>;
        quantity: z.ZodNumber;
        imageUrl: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        imageUrl: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
    }, {
        title: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
        imageUrl?: string | undefined;
    }>, "many">;
    currency: z.ZodDefault<z.ZodEffects<z.ZodString, string, string>>;
    shippingMinor: z.ZodDefault<z.ZodNumber>;
    note: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    currency: string;
    items: {
        title: string;
        imageUrl: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
    }[];
    shippingMinor: number;
    note: string;
}, {
    items: {
        title: string;
        productId: string;
        unitPrice: {
            amountMinor: number;
            currency: string;
        };
        quantity: number;
        imageUrl?: string | undefined;
    }[];
    currency?: string | undefined;
    shippingMinor?: number | undefined;
    note?: string | undefined;
}>;
export type CheckoutInput = z.infer<typeof CheckoutInputSchema>;
//# sourceMappingURL=shop.d.ts.map