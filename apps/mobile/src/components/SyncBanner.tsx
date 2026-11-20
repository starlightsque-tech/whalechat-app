import { Text, View } from 'react-native';
import type { ConnectionState } from '@whalechat/shared';

const LABELS: Record<ConnectionState['status'], string> = {
  booting: 'Loading cache…',
  offline: 'Offline — queued locally',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  online: 'Synced',
  error: 'Sync error',
};

export function SyncBanner({ connection }: { connection: ConnectionState }) {
  const tone =
    connection.status === 'offline'
      ? 'bg-gold/15 border-gold/40 text-gold'
      : connection.status === 'error'
        ? 'bg-coral/15 border-coral/40 text-coral'
        : connection.status === 'online'
          ? 'bg-mint/10 border-mint/30 text-mint'
          : 'bg-sky-400/10 border-sky-400/30 text-sky-300';
  return (
    <View className={`mx-3 mt-2 flex-row items-center justify-between rounded-xl border px-3 py-2 ${tone}`}>
      <Text className="text-[11px] font-semibold">{LABELS[connection.status]}</Text>
      {connection.pendingCount > 0 ? (
        <Text className="text-[11px]">{connection.pendingCount} queued</Text>
      ) : (
        <Text className="text-[11px] opacity-70">idempotent outbox</Text>
      )}
    </View>
  );
}
