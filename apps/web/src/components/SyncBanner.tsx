import type { ConnectionState } from '@whalechat/shared';

interface Props {
  connection: ConnectionState;
  onRetry(): void;
  onRefresh(): void;
}

const LABELS: Record<ConnectionState['status'], string> = {
  booting: 'Loading cached data…',
  offline: 'Offline — changes are queued and will sync automatically',
  connecting: 'Connecting…',
  syncing: 'Syncing changes…',
  online: 'All changes synced',
  error: 'Sync error',
};

export function SyncBanner({ connection, onRetry, onRefresh }: Props) {
  const pending = connection.pendingCount;
  const tone =
    connection.status === 'offline'
      ? 'border-gold/40 bg-gold/10 text-gold'
      : connection.status === 'error'
        ? 'border-coral/40 bg-coral/10 text-coral'
        : connection.status === 'online'
          ? 'border-mint/30 bg-mint/10 text-mint'
          : 'border-sky-400/30 bg-sky-400/10 text-sky-300';

  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-xs ${tone}`}>
      <span className="flex items-center gap-2 font-semibold">
        <span
          className={`h-2 w-2 rounded-full ${
            connection.online ? 'bg-mint' : 'bg-gold'
          } ${connection.status === 'syncing' ? 'live-dot' : ''}`}
        />
        {LABELS[connection.status]}
      </span>
      {pending > 0 && (
        <span className="rounded-full bg-black/20 px-2 py-0.5">
          {pending} queued {connection.failedCount > 0 ? `· ${connection.failedCount} failed` : ''}
        </span>
      )}
      {connection.lastSyncedAt && (
        <span className="text-slate-400">
          last sync {new Date(connection.lastSyncedAt).toLocaleTimeString()}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        {connection.failedCount > 0 && (
          <button className="rounded-lg border border-current/40 px-2 py-1 font-semibold" onClick={onRetry}>
            Retry failed
          </button>
        )}
        <button className="rounded-lg border border-current/30 px-2 py-1 font-semibold" onClick={onRefresh}>
          Refresh
        </button>
      </span>
    </div>
  );
}
