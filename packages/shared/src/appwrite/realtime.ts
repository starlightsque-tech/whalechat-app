import type { AppwriteClientBundle, AppwriteRealtimeEvent } from './transport.js';
import { backoffDelay } from '../utils/backoff.js';

export interface RealtimeBridgeOptions {
  client: AppwriteClientBundle;
  channels: string[];
  onEvent(event: AppwriteRealtimeEvent): void;
  /** fetch missed documents after a drop, using the last updatedAt cursor */
  onResume?(cursor: string | null): Promise<void>;
  cursor?(): string | null;
  onStatus?(status: 'connected' | 'reconnecting' | 'disconnected'): void;
}

/**
 * Appwrite Realtime drops its socket on backgrounding, network changes and
 * token expiry. This wrapper reconnects with exponential backoff and asks the
 * caller to re-fetch deltas from the last `updatedAt` cursor it saw.
 */
export function createRealtimeBridge(options: RealtimeBridgeOptions): { start(): void; stop(): void } {
  let stopped = false;
  let currentUnsub: (() => void) | null = null;
  let attempt = 0;
  let lastEventAt: string | null = options.cursor?.() ?? null;

  const connect = () => {
    if (stopped) return;
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
    } catch {
      options.onStatus?.('reconnecting');
      currentUnsub = null;
      schedule();
    }
  };

  const schedule = () => {
    if (stopped) return;
    const delay = backoffDelay(attempt, { baseMs: 1_000, maxMs: 60_000 });
    attempt += 1;
    setTimeout(async () => {
      if (stopped) return;
      if (options.onResume) {
        try {
          await options.onResume(lastEventAt);
        } catch {
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
