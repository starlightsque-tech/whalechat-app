import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from 'zustand';
import { useChat, whalechatRuntime, whalechatStore } from '@whalechat/shared';

export default function ChatScreen() {
  const conversations = useStore(whalechatStore, (s) => s.conversations);
  const activeId = useStore(whalechatStore, (s) => s.activeConversationId);
  const profile = useStore(whalechatStore, (s) => s.profile);
  const { messages, send } = useChat(activeId);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!activeId && conversations[0]) whalechatStore.getState().setActiveConversation(conversations[0].id);
  }, [activeId, conversations]);

  return (
    <View className="flex-1 bg-abyss">
      <FlatList
        horizontal
        data={conversations}
        keyExtractor={(item) => item.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              whalechatStore.getState().setActiveConversation(item.id);
              void whalechatRuntime.loadMessages(item.id);
            }}
            className={`rounded-xl border px-3 py-2 ${activeId === item.id ? 'border-mint/40 bg-mint/10' : 'border-white/10 bg-deep'}`}
          >
            <Text className="text-xs font-semibold text-white">{item.title ?? 'Direct'}</Text>
            <Text className="text-[10px] text-slate-500">{item.unreadCount} unread</Text>
          </Pressable>
        )}
      />

      <FlatList
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        renderItem={({ item }) => {
          const mine = item.senderId === profile?.id;
          return (
            <View className={`max-w-[85%] rounded-2xl px-3 py-2 ${mine ? 'self-end bg-mint/20' : 'self-start bg-white/10'}`}>
              <Text className="text-sm text-white">{item.body}</Text>
              <Text className="mt-1 text-right text-[9px] text-slate-500">
                {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {item.status}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={<Text className="mt-10 text-center text-xs text-slate-500">No messages cached. Send one — it queues offline.</Text>}
      />

      <View className="flex-row gap-2 border-t border-white/10 p-3">
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Message…"
          placeholderTextColor="#64748b"
          className="flex-1 rounded-xl border border-white/10 bg-deep px-3 py-2 text-sm text-white"
        />
        <Pressable
          className="rounded-xl bg-mint px-4 py-2"
          onPress={async () => {
            if (!draft.trim() || !activeId) return;
            const body = draft;
            setDraft('');
            try {
              await send(body);
            } catch {
              setDraft(body);
            }
          }}
        >
          <Text className="text-sm font-bold text-abyss">Send</Text>
        </Pressable>
      </View>
    </View>
  );
}
