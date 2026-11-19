import { useCallback, useEffect } from 'react';
import { useStore } from 'zustand';
import { whalechatStore } from '../state/store.js';
import { whalechatRuntime } from '../runtime.js';
import type { Attachment, Message } from '../types/chat.js';

export interface UseChatResult {
  messages: Message[];
  unreadCount: number;
  sending: boolean;
  send(body: string, attachments?: Attachment[]): Promise<Message>;
  markRead(messageId: string): Promise<void>;
  reload(): Promise<void>;
}

/** Shared chat hook — identical optimistic behaviour on web and mobile. */
export function useChat(conversationId: string | null): UseChatResult {
  const messages = useStore(whalechatStore, (state) =>
    conversationId ? state.messages[conversationId] ?? [] : [],
  );
  const unreadCount = useStore(whalechatStore, (state) =>
    conversationId ? state.conversations.find((c) => c.id === conversationId)?.unreadCount ?? 0 : 0,
  );

  useEffect(() => {
    if (conversationId) void whalechatRuntime.loadMessages(conversationId);
  }, [conversationId]);

  const send = useCallback(
    async (body: string, attachments: Attachment[] = []) => {
      if (!conversationId) throw new Error('No conversation selected');
      return whalechatRuntime.sendMessage(conversationId, body, attachments);
    },
    [conversationId],
  );

  const markRead = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;
      await whalechatRuntime.markRead(conversationId, messageId);
    },
    [conversationId],
  );

  const reload = useCallback(async () => {
    if (conversationId) await whalechatRuntime.loadMessages(conversationId);
  }, [conversationId]);

  return {
    messages,
    unreadCount,
    sending: messages.some((m) => m.status === 'sending'),
    send,
    markRead,
    reload,
  };
}
