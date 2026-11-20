/**
 * Cross-platform connectivity monitor.
 *
 * The platform supplies an adapter (navigator.onLine on web, NetInfo on Expo).
 * The monitor debounces flaps, adds a lightweight reachability probe, and
 * exposes a subscribe() contract the sync engine depends on.
 */
export type NetworkListener = (online: boolean) => void;

export interface NetworkAdapter {
  isOnline(): boolean;
  subscribe(listener: NetworkListener): () => void;
  /** Optional HTTP reachability check; defaults to the browser's online flag. */
  probe?(): Promise<boolean>;
}

export interface NetworkMonitor {
  isOnline(): boolean;
  subscribe(listener: NetworkListener): () => void;
  start(): void;
  stop(): void;
  refresh(): Promise<boolean>;
}

export interface NetworkMonitorOptions {
  adapter: NetworkAdapter;
  /** Consecutive probe failures before declaring offline. */
  failureThreshold?: number;
  probeIntervalMs?: number;
  /** Avoid flapping on a single dropped packet. */
  debounceMs?: number;
}

export function createNetworkMonitor(options: NetworkMonitorOptions): NetworkMonitor {
  const { adapter, failureThreshold = 2, probeIntervalMs = 20_000, debounceMs = 800 } = options;
  const listeners = new Set<NetworkListener>();
  let online = adapter.isOnline();
  let failures = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubAdapter: (() => void) | null = null;

  const emit = (next: boolean, force = false) => {
    if (next === online && !force) return;
    online = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        /* a listener must not break the monitor */
      }
    }
  };

  const schedule = (next: boolean) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => emit(next), debounceMs);
  };

  const refresh = async (): Promise<boolean> => {
    if (!adapter.isOnline()) {
      failures = failureThreshold;
      emit(false);
      return false;
    }
    if (!adapter.probe) {
      failures = 0;
      emit(true);
      return true;
    }
    try {
      const reachable = await adapter.probe();
      if (reachable) {
        failures = 0;
        emit(true);
        return true;
      }
      failures += 1;
    } catch {
      failures += 1;
    }
    if (failures >= failureThreshold) emit(false);
    return online;
  };

  return {
    isOnline: () => online,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (!unsubAdapter) {
        unsubAdapter = adapter.subscribe((value) => {
          if (!value) {
            failures = failureThreshold;
            schedule(false);
          } else {
            void refresh();
          }
        });
      }
      if (!timer) {
        timer = setInterval(() => void refresh(), probeIntervalMs);
      }
      void refresh();
    },
    stop() {
      unsubAdapter?.();
      unsubAdapter = null;
      if (timer) clearInterval(timer);
      timer = null;
      if (debounceTimer) clearTimeout(debounceTimer);
    },
    refresh,
  };
}

/**
 * Web adapter: navigator.onLine + a HEAD request to the API origin.
 * A 4xx still proves reachability, so only network errors count as offline.
 */
export function createWebNetworkAdapter(probeUrl?: string): NetworkAdapter {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    isOnline: () => (nav ? nav.onLine : true),
    subscribe(listener) {
      if (typeof window === 'undefined') return () => undefined;
      const on = () => listener(true);
      const off = () => listener(false);
      window.addEventListener('online', on);
      window.addEventListener('offline', off);
      return () => {
        window.removeEventListener('online', on);
        window.removeEventListener('offline', off);
      };
    },
    async probe() {
      if (!probeUrl || typeof fetch === 'undefined') return nav ? nav.onLine : true;
      try {
        await fetch(probeUrl, { method: 'HEAD', cache: 'no-store' });
        return true;
      } catch {
        return false;
      }
    },
  };
}
