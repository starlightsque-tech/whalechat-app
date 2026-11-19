/**
 * Appwrite collection contract for the three core domains.
 *
 * `scripts/provision-monorepo-appwrite.mjs` creates/updates exactly these
 * collections, attributes and indexes (idempotent — safe to re-run).
 */
export type AppwriteAttributeType = 'string' | 'integer' | 'float' | 'boolean' | 'datetime' | 'email' | 'url';
export interface AppwriteAttributeSchema {
    key: string;
    type: AppwriteAttributeType;
    required: boolean;
    size?: number;
    array?: boolean;
    default?: string | number | boolean;
}
export interface AppwriteIndexSchema {
    key: string;
    type: 'key' | 'unique' | 'fulltext';
    attributes: string[];
    orders?: Array<'ASC' | 'DESC'>;
}
export interface AppwriteCollectionSchema {
    id: string;
    name: string;
    description: string;
    attributes: AppwriteAttributeSchema[];
    indexes: AppwriteIndexSchema[];
}
export declare const usersCollection: AppwriteCollectionSchema;
export declare const walletsCollection: AppwriteCollectionSchema;
export declare const conversationsCollection: AppwriteCollectionSchema;
export declare const messagesCollection: AppwriteCollectionSchema;
export declare const productsCollection: AppwriteCollectionSchema;
export declare const ordersCollection: AppwriteCollectionSchema;
export declare const tradesCollection: AppwriteCollectionSchema;
export declare const ledgerCollection: AppwriteCollectionSchema;
export declare const WHALECHAT_COLLECTIONS: AppwriteCollectionSchema[];
//# sourceMappingURL=schema.d.ts.map