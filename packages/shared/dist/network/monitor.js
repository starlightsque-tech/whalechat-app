export function createNetworkMonitor(options) {
    const { adapter, failureThreshold = 2, probeIntervalMs = 20_000, debounceMs = 800 } = options;
    const listeners = new Set();
    let online = adapter.isOnline();
    let failures = 0;
    let timer = null;
    let debounceTimer = null;
    let unsubAdapter = null;
    const emit = (next, force = false) => {
        if (next === online && !force)
            return;
        online = next;
        for (const listener of listeners) {
            try {
                listener(next);
            }
            catch {
                /* a listener must not break the monitor */
            }
        }
    };
    const schedule = (next) => {
        if (debounceTimer)
            clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => emit(next), debounceMs);
    };
    const refresh = async () => {
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
        }
        catch {
            failures += 1;
        }
        if (failures >= failureThreshold)
            emit(false);
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
                    }
                    else {
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
            if (timer)
                clearInterval(timer);
            timer = null;
            if (debounceTimer)
                clearTimeout(debounceTimer);
        },
        refresh,
    };
}
/**
 * Web adapter: navigator.onLine + a HEAD request to the API origin.
 * A 4xx still proves reachability, so only network errors count as offline.
 */
export function createWebNetworkAdapter(probeUrl) {
    const nav = typeof navigator === 'undefined' ? undefined : navigator;
    return {
        isOnline: () => (nav ? nav.onLine : true),
        subscribe(listener) {
            if (typeof window === 'undefined')
                return () => undefined;
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
            if (!probeUrl || typeof fetch === 'undefined')
                return nav ? nav.onLine : true;
            try {
                await fetch(probeUrl, { method: 'HEAD', cache: 'no-store' });
                return true;
            }
            catch {
                return false;
            }
        },
    };
}
//# sourceMappingURL=monitor.js.map