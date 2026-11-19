import type { StorageAdapter } from '../storage/adapter.js';
import type { WhalechatStoreApi } from '../state/store.js';
/** Boot from cache first: the UI must render instantly, even offline. */
export declare function hydrateStore(storage: StorageAdapter, store: WhalechatStoreApi): Promise<void>;
/**
 * Debounced cache writer. Cache writes are best-effort and must never be on
 * the critical path of a mutation — the outbox row is written first.
 */
export declare function attachPersistence(storage: StorageAdapter, store: WhalechatStoreApi, debounceMs?: number): () => void;
//# sourceMappingURL=persistence.d.ts.map