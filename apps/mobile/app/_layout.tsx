import '../global.css';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useWhalechatSync } from '@whalechat/shared';
import { configureMobileWhalechat } from '../src/lib/whalechat';
import { SyncBanner } from '../src/components/SyncBanner';

function Shell() {
  const { connection } = useWhalechatSync();
  return (
    <SafeAreaView className="flex-1 bg-abyss" edges={['top', 'left', 'right']}>
      <View className="flex-row items-center justify-between px-4 pt-2">
        <Text className="text-lg font-bold text-white">🐋 Whalechat</Text>
        <Text className="text-[10px] text-slate-500">trade · chat · shop</Text>
      </View>
      <SyncBanner connection={connection} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#04101a' },
          animation: 'slide_from_right',
        }}
      />
    </SafeAreaView>
  );
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    configureMobileWhalechat()
      .then(() => setReady(true))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (!ready) {
    return (
      <View className="flex-1 items-center justify-center bg-abyss">
        <ActivityIndicator color="#34d3a6" />
        <Text className="mt-3 text-xs text-slate-400">{error ?? 'Opening local cache…'}</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Shell />
    </SafeAreaProvider>
  );
}
