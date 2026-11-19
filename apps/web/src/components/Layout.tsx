import { NavLink, Outlet } from 'react-router-dom';
import { useWhalechatSync } from '@whalechat/shared';
import { SyncBanner } from './SyncBanner';

const NAV = [
  { to: '/', label: 'Overview', icon: '◎' },
  { to: '/trade', label: 'Trade', icon: '📈' },
  { to: '/chat', label: 'Chat', icon: '💬' },
  { to: '/shop', label: 'Shop', icon: '🛍' },
  { to: '/wallet', label: 'Wallet', icon: '💳' },
  { to: '/admin', label: 'Admin', icon: '⚙' },
];

export function Layout() {
  const { connection, booted, retryNow, refresh } = useWhalechatSync();

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-3 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-mint/15 text-xl">🐋</div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Whalechat</h1>
            <p className="text-xs text-slate-400">Trade · Chat · Shop — offline-first</p>
          </div>
        </div>
        <nav className="flex flex-wrap gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `rounded-xl px-3 py-2 text-sm font-medium transition ${
                  isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <span className="mr-1.5 opacity-80">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <SyncBanner connection={connection} onRetry={() => void retryNow()} onRefresh={() => void refresh()} />

      {!booted ? (
        <div className="grid flex-1 place-items-center text-sm text-slate-400">Opening local cache…</div>
      ) : (
        <main className="flex-1 pb-10">
          <Outlet />
        </main>
      )}
    </div>
  );
}
