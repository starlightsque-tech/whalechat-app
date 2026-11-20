import {
  createMemoryStorage,
  nsKey,
  type PlatformStorageAdapter,
  type StorageAdapterInfo,
} from '@whalechat/shared';

const DB_NAME = 'whalechat';
const STORE = 'kv';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

/**
 * Web storage adapter: IndexedDB primary, localStorage fallback.
 * Values are stored as JSON strings so both backends share one code path.
 */
export async function createWebStorage(): Promise<PlatformStorageAdapter> {
  const info: StorageAdapterInfo = { kind: 'indexeddb', durable: true };
  let db: IDBDatabase | null = null;
  try {
    db = await openDatabase();
  } catch {
    db = null;
  }

  if (!db) {
    if (typeof localStorage === 'undefined') {
      return createMemoryStorage();
    }
    const fallback: PlatformStorageAdapter = {
      info: { kind: 'localstorage', durable: true },
      async get<T>(key: string): Promise<T | null> {
        const raw = localStorage.getItem(nsKey(key));
        return raw === null ? null : (JSON.parse(raw) as T);
      },
      async set<T>(key: string, value: T): Promise<void> {
        localStorage.setItem(nsKey(key), JSON.stringify(value));
      },
      async remove(key: string): Promise<void> {
        localStorage.removeItem(nsKey(key));
      },
      async keys(prefix = ''): Promise<string[]> {
        const full = nsKey(prefix);
        const result: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key?.startsWith(full)) result.push(key.slice('whalechat:'.length));
        }
        return result;
      },
      async clear(prefix = ''): Promise<void> {
        for (const key of await this.keys(prefix)) localStorage.removeItem(nsKey(key));
      },
    };
    return fallback;
  }

  const request = <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const tx = db!.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });

  const adapter: PlatformStorageAdapter = {
    info,
    async get<T>(key: string): Promise<T | null> {
      const value = await request<T | undefined>('readonly', (store) => store.get(nsKey(key)) as IDBRequest<T | undefined>);
      return value === undefined ? null : value;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await request('readwrite', (store) => store.put(value, nsKey(key)));
    },
    async remove(key: string): Promise<void> {
      await request('readwrite', (store) => store.delete(nsKey(key)));
    },
    async keys(prefix = ''): Promise<string[]> {
      const keys = await request<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
      const full = nsKey(prefix);
      return keys
        .filter((key): key is string => typeof key === 'string' && key.startsWith(full))
        .map((key) => key.slice('whalechat:'.length));
    },
    async clear(prefix = ''): Promise<void> {
      const keys = await adapter.keys(prefix);
      await Promise.all(keys.map((key) => adapter.remove(key)));
    },
    async setMany(entries): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const tx = db!.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const [key, value] of entries) store.put(value, nsKey(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB batch failed'));
      });
    },
  };
  return adapter;
}
