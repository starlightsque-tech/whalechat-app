import { useCallback, useEffect } from 'react';
import { useStore } from 'zustand';
import { whalechatStore } from '../state/store.js';
import { whalechatRuntime } from '../runtime.js';
/** Shared chat hook — identical optimistic behaviour on web and mobile. */
export function useChat(conversationId) {
    const messages = useStore(whalechatStore, (state) => conversationId ? state.messages[conversationId] ?? [] : []);
    const unreadCount = useStore(whalechatStore, (state) => conversationId ? state.conversations.find((c) => c.id === conversationId)?.unreadCount ?? 0 : 0);
    useEffect(() => {
        if (conversationId)
            void whalechatRuntime.loadMessages(conversationId);
    }, [conversationId]);
    const send = useCallback(async (body, attachments = []) => {
        if (!conversationId)
            throw new Error('No conversation selected');
        return whalechatRuntime.sendMessage(conversationId, body, attachments);
    }, [conversationId]);
    const markRead = useCallback(async (messageId) => {
        if (!conversationId)
            return;
        await whalechatRuntime.markRead(conversationId, messageId);
    }, [conversationId]);
    const reload = useCallback(async () => {
        if (conversationId)
            await whalechatRuntime.loadMessages(conversationId);
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
//# sourceMappingURL=useChat.js.map