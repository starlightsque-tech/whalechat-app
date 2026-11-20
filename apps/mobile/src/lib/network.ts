import NetInfo from '@react-native-community/netinfo';
import { createNetworkMonitor, type NetworkAdapter } from '@whalechat/shared';

const adapter: NetworkAdapter = {
  isOnline: () => true,
  subscribe(listener) {
    return NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected) && state.isInternetReachable !== false;
      listener(online);
    });
  },
  async probe() {
    const state = await NetInfo.fetch();
    return Boolean(state.isConnected) && state.isInternetReachable !== false;
  },
};

export function createMobileNetwork() {
  return createNetworkMonitor({ adapter, debounceMs: 500, probeIntervalMs: 20_000 });
}
