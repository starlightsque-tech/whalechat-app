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
export declare function useChat(conversationId: string | null): UseChatResult;
//# sourceMappingURL=useChat.d.ts.map