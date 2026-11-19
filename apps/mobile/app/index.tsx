import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from 'zustand';
import { formatMoney, whalechatStore, useWallet } from '@whalechat/shared';

const LINKS = [
  { href: '/trade', title: 'Trade', body: 'Live markets, charts and portfolio' },
  { href: '/chat', title: 'Chat', body: 'Messages sync when you reconnect' },
  { href: '/shop', title: 'Shop', body: 'Escrow checkout, offline cart' },
  { href: '/wallet', title: 'Wallet', body: 'Balances, holds and ledger' },
] as const;

export default function DashboardScreen() {
  const router = useRouter();
  const profile = useStore(whalechatStore, (s) => s.profile);
  const pending = useStore(whalechatStore, (s) => s.connection.pendingCount);
  const { availableMinor, portfolio } = useWallet();

  return (
    <ScrollView className="flex-1 bg-abyss" contentContainerStyle={{ padding: 14, gap: 12 }}>
      <View className="rounded-2xl border border-white/10 bg-deep p-4">
        <Text className="text-xs text-slate-400">Welcome back</Text>
        <Text className="mt-1 text-2xl font-bold text-white">{profile?.displayName ?? 'Whalechat trader'}</Text>
        <Text className="mt-1 text-xs text-slate-500">
          {pending > 0 ? `${pending} change(s) queued offline` : 'Everything is synced'}
        </Text>
        <View className="mt-4 flex-row gap-3">
          <View className="flex-1 rounded-xl bg-white/5 p-3">
            <Text className="text-[10px] uppercase text-slate-500">Available</Text>
            <Text className="mt-1 text-lg font-bold text-mint">{formatMoney({ amountMinor: availableMinor, currency: 'USD' })}</Text>
          </View>
          <View className="flex-1 rounded-xl bg-white/5 p-3">
            <Text className="text-[10px] uppercase text-slate-500">Portfolio</Text>
            <Text className="mt-1 text-lg font-bold text-white">{portfolio ? formatMoney(portfolio.totalValue) : '—'}</Text>
          </View>
        </View>
      </View>

      {LINKS.map((link) => (
        <Pressable key={link.href} onPress={() => router.push(link.href)} className="rounded-2xl border border-white/10 bg-deep p-4">
          <Text className="text-base font-semibold text-white">{link.title}</Text>
          <Text className="mt-1 text-xs text-slate-400">{link.body}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
