import { createNetworkMonitor, createWebNetworkAdapter } from '@whalechat/shared';

export function createWebNetwork() {
  const probeUrl = (import.meta.env.VITE_API_PROBE_URL as string | undefined) || undefined;
  return createNetworkMonitor({
    adapter: createWebNetworkAdapter(probeUrl),
    debounceMs: 700,
    probeIntervalMs: 25_000,
  });
}
