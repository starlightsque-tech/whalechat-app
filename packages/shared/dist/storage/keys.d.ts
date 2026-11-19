/** Every persisted cache key in one place (namespaced by the adapter). */
export declare const StorageKeys: {
    readonly schemaVersion: "meta:schemaVersion";
    readonly session: "session:current";
    readonly profile: "cache:profile";
    readonly wallet: "cache:wallet";
    readonly conversations: "cache:conversations";
    readonly messages: (conversationId: string) => string;
    readonly products: "cache:products";
    readonly cart: "cache:cart";
    readonly orders: "cache:orders";
    readonly assets: "cache:assets";
    readonly quotes: "cache:quotes";
    readonly candles: (symbol: string) => string;
    readonly portfolio: "cache:portfolio";
    readonly trades: "cache:trades";
    readonly ledger: "cache:ledger";
    readonly realtimeCursor: "sync:realtime:cursor";
    readonly outbox: "sync:outbox";
    readonly lastSync: "sync:lastSync";
    readonly failedOps: "sync:failedOps";
};
export declare const STORAGE_SCHEMA_VERSION = 1;
//# sourceMappingURL=keys.d.ts.map