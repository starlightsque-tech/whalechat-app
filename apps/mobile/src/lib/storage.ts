import { createMemoryStorage, nsKey, type PlatformStorageAdapter } from '@whalechat/shared';

let mmkv: import('react-native-mmkv').MMKV | null = null;

try {
  // MMKV is synchronous, encrypted-at-rest capable and survives app restarts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
  mmkv = new MMKV({ id: 'whalechat' });
} catch {
  mmkv = null;
}

/** Expo storage adapter: MMKV primary, in-memory fallback (Expo Go / web). */
export function createMobileStorage(): PlatformStorageAdapter {
  if (!mmkv) return createMemoryStorage();
  const store = mmkv;

  return {
    info: { kind: 'mmkv', durable: true },
    async get<T>(key: string): Promise<T | null> {
      const raw = store.getString(nsKey(key));
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(nsKey(key), JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      store.delete(nsKey(key));
    },
    async keys(prefix = ''): Promise<string[]> {
      const full = nsKey(prefix);
      return store
        .getAllKeys()
        .filter((key) => key.startsWith(full))
        .map((key) => key.slice('whalechat:'.length));
    },
    async clear(prefix = ''): Promise<void> {
      for (const key of await this.keys(prefix)) store.delete(nsKey(key));
    },
  };
}
