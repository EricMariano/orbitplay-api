import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { postStatusValues } from '../../community/dto/community.dto';

export const MESSAGE_MAX_LENGTH = 2000;

export const chatChannelSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  slug: z.string(),
  name: z.string(),
  topic: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.string(),
});

export const chatChannelListSchema = z.object({
  data: z.array(chatChannelSchema),
  nextCursor: z.string().nullable(),
});

export const createChatChannelSchema = z.object({
  name: z.string().min(1, 'Nome do canal obrigatório').max(60),
  topic: z.string().max(500).optional(),
});

export const updateChatChannelSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    topic: z.string().max(500).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nada para atualizar' });

export const chatMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  authorUserId: z.string(),
  authorDisplayName: z.string(),
  body: z.string(),
  status: z.enum(postStatusValues),
  createdAt: z.string(),
});

export const chatMessageListSchema = z.object({
  data: z.array(chatMessageSchema),
  nextCursor: z.string().nullable(),
});

export const sendChatMessageSchema = z.object({
  body: z.string().min(1, 'Mensagem vazia').max(MESSAGE_MAX_LENGTH),
});

export const moderateChatMessageActionValues = ['hide', 'restore', 'remove'] as const;

export const moderateChatMessageSchema = z.object({
  action: z.enum(moderateChatMessageActionValues),
});

export const chatPresenceSchema = z.object({
  channelId: z.string(),
  members: z.array(z.object({ userId: z.string(), displayName: z.string() })),
});

/**
 * WebSocket payloads. The global ZodValidationPipe only covers HTTP, so the
 * gateway parses these by hand — same schemas, same messages, one definition.
 */
export const wsChannelRefSchema = z.object({ channelId: z.string().uuid() });

export const wsSendMessageSchema = wsChannelRefSchema.extend({
  body: z.string().min(1, 'Mensagem vazia').max(MESSAGE_MAX_LENGTH),
});

export type ChatChannelView = z.infer<typeof chatChannelSchema>;
export type CreateChatChannelDto = z.infer<typeof createChatChannelSchema>;
export type UpdateChatChannelDto = z.infer<typeof updateChatChannelSchema>;
export type ChatMessageView = z.infer<typeof chatMessageSchema>;
export type SendChatMessageDto = z.infer<typeof sendChatMessageSchema>;
export type ModerateChatMessageDto = z.infer<typeof moderateChatMessageSchema>;
export type ChatPresenceView = z.infer<typeof chatPresenceSchema>;

export class ChatChannelDto extends createZodDto(chatChannelSchema) {}
export class ChatChannelListDto extends createZodDto(chatChannelListSchema) {}
export class CreateChatChannelRequestDto extends createZodDto(createChatChannelSchema) {}
export class UpdateChatChannelRequestDto extends createZodDto(updateChatChannelSchema) {}
export class ChatMessageDto extends createZodDto(chatMessageSchema) {}
export class ChatMessageListDto extends createZodDto(chatMessageListSchema) {}
export class SendChatMessageRequestDto extends createZodDto(sendChatMessageSchema) {}
export class ModerateChatMessageRequestDto extends createZodDto(moderateChatMessageSchema) {}
export class ChatPresenceDto extends createZodDto(chatPresenceSchema) {}
