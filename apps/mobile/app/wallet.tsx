import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { formatMoney, useWallet } from '@whalechat/shared';

export default function WalletScreen() {
  const { currency, availableMinor, balanceMinor, pendingMinor, ledger, portfolio, transfer } = useWallet();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <ScrollView className="flex-1 bg-abyss" contentContainerStyle={{ padding: 14, gap: 12 }}>
      <View className="rounded-2xl border border-white/10 bg-deep p-4">
        <Text className="text-[10px] uppercase text-slate-500">Available</Text>
        <Text className="mt-1 text-3xl font-bold text-white">{formatMoney({ amountMinor: availableMinor, currency })}</Text>
        <Text className="mt-1 text-xs text-slate-500">Total {formatMoney({ amountMinor: balanceMinor, currency })} · pending {formatMoney({ amountMinor: pendingMinor, currency })}</Text>
        <View className="mt-3 flex-row gap-2">
          <View className="flex-1 rounded-xl bg-white/5 p-3">
            <Text className="text-[10px] text-slate-500">Portfolio</Text>
            <Text className="mt-1 text-sm font-bold text-mint">{portfolio ? formatMoney(portfolio.totalValue) : '—'}</Text>
          </View>
          <View className="flex-1 rounded-xl bg-white/5 p-3">
            <Text className="text-[10px] text-slate-500">Positions</Text>
            <Text className="mt-1 text-sm font-bold text-white">{portfolio?.positions.length ?? 0}</Text>
          </View>
        </View>
      </View>

      <View className="rounded-2xl border border-white/10 bg-deep p-4">
        <Text className="text-sm font-semibold text-white">Send funds</Text>
        <TextInput value={to} onChangeText={setTo} placeholder="Recipient user id" placeholderTextColor="#64748b" className="mt-2 rounded-xl border border-white/10 bg-abyss px-3 py-2 text-sm text-white" />
        <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Amount" placeholderTextColor="#64748b" className="mt-2 rounded-xl border border-white/10 bg-abyss px-3 py-2 text-sm text-white" />
        <Pressable
          className="mt-2 rounded-xl bg-mint py-2.5"
          onPress={async () => {
            try {
              await transfer(to.trim(), Math.round(Number(amount) * 100), 'Whalechat transfer');
              setNotice('Transfer queued — funds locked until sync.');
              setTo('');
              setAmount('');
            } catch (error) {
              setNotice(error instanceof Error ? error.message : 'Transfer failed');
            }
          }}
        >
          <Text className="text-center text-sm font-bold text-abyss">Send</Text>
        </Pressable>
        {notice && <Text className="mt-2 text-[11px] text-gold">{notice}</Text>}
      </View>

      <View className="rounded-2xl border border-white/10 bg-deep p-4">
        <Text className="mb-2 text-sm font-semibold text-white">Transactions</Text>
        {ledger.slice(0, 20).map((entry) => (
          <View key={entry.id} className="flex-row items-center justify-between border-b border-white/5 py-2">
            <View className="flex-1">
              <Text className="text-xs text-slate-300">{entry.type.replace('_', ' ')}</Text>
              <Text className="text-[10px] text-slate-500" numberOfLines={1}>{entry.description}</Text>
            </View>
            <Text className={`text-xs font-semibold ${entry.type.includes('debit') ? 'text-coral' : 'text-mint'}`}>{formatMoney(entry.amount)}</Text>
          </View>
        ))}
        {ledger.length === 0 && <Text className="text-xs text-slate-500">Ledger cached after first sync.</Text>}
      </View>
    </ScrollView>
  );
}
