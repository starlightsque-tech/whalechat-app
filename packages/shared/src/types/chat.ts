import { z } from 'zod';
import { IsoDateSchema } from './common.js';

export const MessageStatusSchema = z.enum(['sending', 'sent', 'delivered', 'read', 'failed']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['image', 'video', 'audio', 'file']),
  url: z.string().url(),
  name: z.string().default(''),
  sizeBytes: z.number().int().nonnegative().default(0),
  mimeType: z.string().default('application/octet-stream'),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  clientId: z.string().nullable().default(null),
  conversationId: z.string(),
  senderId: z.string(),
  body: z.string().max(8_000).default(''),
  attachments: z.array(AttachmentSchema).default([]),
  status: MessageStatusSchema.default('sending'),
  /** server timestamps; null while optimistic */
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  serverCreatedAt: IsoDateSchema.nullable().default(null),
  readBy: z.array(z.string()).default([]),
  replyToId: z.string().nullable().default(null),
  deletedAt: IsoDateSchema.nullable().default(null),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  kind: z.enum(['direct', 'group', 'support']).default('direct'),
  title: z.string().nullable().default(null),
  participantIds: z.array(z.string()).min(1),
  lastMessagePreview: z.string().default(''),
  lastMessageAt: IsoDateSchema.nullable().default(null),
  unreadCount: z.number().int().nonnegative().default(0),
  /** cursor used to fetch missed deltas after a realtime drop */
  updatedAt: IsoDateSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const SendMessageInputSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().max(8_000).default(''),
  attachments: z.array(AttachmentSchema).default([]),
  replyToId: z.string().nullable().default(null),
});
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const ReadReceiptSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  userId: z.string(),
  readAt: IsoDateSchema,
});
export type ReadReceipt = z.infer<typeof ReadReceiptSchema>;
