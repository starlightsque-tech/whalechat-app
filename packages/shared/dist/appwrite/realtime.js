import { backoffDelay } from '../utils/backoff.js';
/**
 * Appwrite Realtime drops its socket on backgrounding, network changes and
 * token expiry. This wrapper reconnects with exponential backoff and asks the
 * caller to re-fetch deltas from the last `updatedAt` cursor it saw.
 */
export function createRealtimeBridge(options) {
    let stopped = false;
    let currentUnsub = null;
    let attempt = 0;
    let lastEventAt = options.cursor?.() ?? null;
    const connect = () => {
        if (stopped)
            return;
        const realtime = options.client.realtime;
        if (!realtime) {
            options.onStatus?.('disconnected');
            return;
        }
        try {
            currentUnsub = realtime.subscribe(options.channels, (event) => {
                attempt = 0;
                options.onStatus?.('connected');
                lastEventAt = typeof event.timestamp === 'string' ? event.timestamp : lastEventAt;
                options.onEvent(event);
            });
            options.onStatus?.('connected');
        }
        catch {
            options.onStatus?.('reconnecting');
            currentUnsub = null;
            schedule();
        }
    };
    const schedule = () => {
        if (stopped)
            return;
        const delay = backoffDelay(attempt, { baseMs: 1_000, maxMs: 60_000 });
        attempt += 1;
        setTimeout(async () => {
            if (stopped)
                return;
            if (options.onResume) {
                try {
                    await options.onResume(lastEventAt);
                }
                catch {
                    /* retry the cursor fetch on the next reconnect */
                }
            }
            connect();
        }, delay);
    };
    return {
        start() {
            stopped = false;
            connect();
        },
        stop() {
            stopped = true;
            currentUnsub?.();
            currentUnsub = null;
        },
    };
}
//# sourceMappingURL=realtime.js.map