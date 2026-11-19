const NAMESPACE = 'whalechat';
/** Prefix every key so the app never collides with host-page storage. */
export function nsKey(key) {
    return `${NAMESPACE}:${key}`;
}
/** In-memory adapter: tests, SSR, and a safe fallback when MMKV is absent. */
export function createMemoryStorage(seed = {}) {
    const map = new Map();
    for (const [k, v] of Object.entries(seed))
        map.set(nsKey(k), JSON.stringify(v));
    return {
        info: { kind: 'memory', durable: false },
        async get(key) {
            const raw = map.get(nsKey(key));
            return raw === undefined ? null : JSON.parse(raw);
        },
        async set(key, value) {
            map.set(nsKey(key), JSON.stringify(value));
        },
        async remove(key) {
            map.delete(nsKey(key));
        },
        async keys(prefix = '') {
            const full = nsKey(prefix);
            return [...map.keys()].filter((k) => k.startsWith(full)).map((k) => k.slice(NAMESPACE.length + 1));
        },
        async clear(prefix = '') {
            const full = nsKey(prefix);
            for (const k of [...map.keys()])
                if (k.startsWith(full))
                    map.delete(k);
        },
        async setMany(entries) {
            for (const [k, v] of entries)
                map.set(nsKey(k), JSON.stringify(v));
        },
    };
}
/** Wrap read/write failures so a corrupt cache can never crash app boot. */
export async function safeGet(storage, key, fallback) {
    try {
        const value = await storage.get(key);
        return value ?? fallback;
    }
    catch {
        return fallback;
    }
}
export async function safeSet(storage, key, value) {
    try {
        await storage.set(key, value);
    }
    catch {
        // Cache writes are best-effort; the outbox write is the source of truth
        // for pending mutations and is retried by the sync manager.
    }
}
//# sourceMappingURL=adapter.js.map