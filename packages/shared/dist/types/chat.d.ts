import { z } from 'zod';
export declare const MessageStatusSchema: z.ZodEnum<["sending", "sent", "delivered", "read", "failed"]>;
export type MessageStatus = z.infer<typeof MessageStatusSchema>;
export declare const AttachmentSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<["image", "video", "audio", "file"]>;
    url: z.ZodString;
    name: z.ZodDefault<z.ZodString>;
    sizeBytes: z.ZodDefault<z.ZodNumber>;
    mimeType: z.ZodDefault<z.ZodString>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    id: string;
    kind: "image" | "video" | "audio" | "file";
    url: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    width?: number | undefined;
    height?: number | undefined;
}, {
    id: string;
    kind: "image" | "video" | "audio" | "file";
    url: string;
    name?: string | undefined;
    sizeBytes?: number | undefined;
    mimeType?: string | undefined;
    width?: number | undefined;
    height?: number | undefined;
}>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export declare const MessageSchema: z.ZodObject<{
    id: z.ZodString;
    clientId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    conversationId: z.ZodString;
    senderId: z.ZodString;
    body: z.ZodDefault<z.ZodString>;
    attachments: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<["image", "video", "audio", "file"]>;
        url: z.ZodString;
        name: z.ZodDefault<z.ZodString>;
        sizeBytes: z.ZodDefault<z.ZodNumber>;
        mimeType: z.ZodDefault<z.ZodString>;
        width: z.ZodOptional<z.ZodNumber>;
        height: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        kind: "image" | "video" | "audio" | "file";
        url: string;
        name: string;
        sizeBytes: number;
        mimeType: string;
        width?: number | undefined;
        height?: number | undefined;
    }, {
        id: string;
        kind: "image" | "video" | "audio" | "file";
        url: string;
        name?: string | undefined;
        sizeBytes?: number | undefined;
        mimeType?: string | undefined;
        width?: number | undefined;
        height?: number | undefined;
    }>, "many">>;
    status: z.ZodDefault<z.ZodEnum<["sending", "sent", "delivered", "read", "failed"]>>;
    /** server timestamps; null while optimistic */
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    serverCreatedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    readBy: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    replyToId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    deletedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    status: "sending" | "sent" | "delivered" | "read" | "failed";
    id: string;
    createdAt: string;
    updatedAt: string;
    clientId: string | null;
    conversationId: string;
    senderId: string;
    body: string;
    attachments: {
        id: string;
        kind: "image" | "video" | "audio" | "file";
        url: string;
        name: string;
        sizeBytes: number;
        mimeType: string;
        width?: number | undefined;
        height?: number | undefined;
    }[];
    serverCreatedAt: string | null;
    readBy: string[];
    replyToId: string | null;
    deletedAt: string | null;
}, {
    id: string;
    createdAt: string;
    updatedAt: string;
    conversationId: string;
    senderId: string;
    status?: "sending" | "sent" | "delivered" | "read" | "failed" | undefined;
    clientId?: string | null | undefined;
    body?: string | undefined;
    attachments?: {
        id: string;
        kind: "image" | "video" | "audio" | "file";
        url: string;
        name?: string | undefined;
        sizeBytes?: number | undefined;
        mimeType?: string | undefined;
        width?: number | undefined;
        height?: number | undefined;
    }[] | undefined;
    serverCreatedAt?: string | null | undefined;
    readBy?: string[] | undefined;
    replyToId?: string | null | undefined;
    deletedAt?: string | null | undefined;
}>;
export type Message = z.infer<typeof MessageSchema>;
export declare const ConversationSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodDefault<z.ZodEnum<["direct", "group", "support"]>>;
    title: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    participantIds: z.ZodArray<z.ZodString, "many">;
    lastMessagePreview: z.ZodDefault<z.ZodString>;
    lastMessageAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    unreadCount: z.ZodDefault<z.ZodNumber>;
    /** cursor used to fetch missed deltas after a realtime drop */
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    updatedAt: string;
    kind: "support" | "direct" | "group";
    title: string | null;
    participantIds: string[];
    lastMessagePreview: string;
    lastMessageAt: string | null;
    unreadCount: number;
}, {
    id: string;
    updatedAt: string;
    participantIds: string[];
    kind?: "support" | "direct" | "group" | undefined;
    title?: string | null | undefined;
    lastMessagePreview?: string | undefined;
    lastMessageAt?: string | null | undefined;
    unreadCount?: number | undefined;
}>;
export type Conversation = z.infer<typeof ConversationSchema>;
export declare const SendMessageInputSchema: z.ZodObject<{
    conversationId: z.ZodString;
    body: z.ZodDefault<z.ZodString>;
    attachments: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<["image", "video", "audio", "file"]>;
        url: z.ZodString;
        name: z.ZodDefault<z.ZodString>;
        sizeBytes: z.ZodDefault<z.ZodNumber>;
        mimeType: z.ZodDefault<z.ZodString>;
        width: z.ZodOptional<z.ZodNumber>;
        height: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        kind: "image" | "video" | "audio" | "file";
        url: string;
        name: string;
        sizeBytes: number;
        mimeType: string;
        width?: number | undefined;
        height?: number | undefined;
    }, {
        id: string;
        kind: "image" | "video" | "audio" | "file";
        url: string;
        name?: string | undefined;
        sizeBytes?: number | undefined;
        mimeType?: string | undefined;
        width?: number | undefined;
        height?: number | undefined;
    }>, "many">>;
    replyToId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    conversationId: string;
    body: string;
    attachments: {
        id: string;
        kind: "image" | "video" | "audio" | "file";
        url: string;
        name: string;
        sizeBytes: number;
        mimeType: string;
        width?: number | undefined;
        height?: number | undefined;
    }[];
    replyToId: string | null;
}, {
    conversationId: string;
    body?: string | undefined;
    attachments?: {
        id: string;
        kind: "image" | "video" | "audio" | "file";
        url: string;
        name?: string | undefined;
        sizeBytes?: number | undefined;
        mimeType?: string | undefined;
        width?: number | undefined;
        height?: number | undefined;
    }[] | undefined;
    replyToId?: string | null | undefined;
}>;
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
export declare const ReadReceiptSchema: z.ZodObject<{
    conversationId: z.ZodString;
    messageId: z.ZodString;
    userId: z.ZodString;
    readAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    userId: string;
    conversationId: string;
    messageId: string;
    readAt: string;
}, {
    userId: string;
    conversationId: string;
    messageId: string;
    readAt: string;
}>;
export type ReadReceipt = z.infer<typeof ReadReceiptSchema>;
//# sourceMappingURL=chat.d.ts.map