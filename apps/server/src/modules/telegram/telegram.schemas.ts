import * as v from "valibot";

// Valibot over a raw Telegram update, the boundary between the Bot API and the rest of
// the module. Only the fields the intake actually reads are declared; every other field
// Telegram sends is silently dropped rather than rejected; Telegram adds fields to its
// API on its own schedule and a strict schema would turn each one into an outage.

const telegramUserSchema = v.object({
  id: v.number(),
  first_name: v.string(),
});

const telegramChatSchema = v.object({
  id: v.number(),
});

const telegramMessageEntitySchema = v.object({
  type: v.string(),
  offset: v.number(),
  length: v.number(),
  url: v.optional(v.string()),
});

const telegramPhotoSizeSchema = v.object({
  file_id: v.string(),
  width: v.number(),
  height: v.number(),
  file_size: v.optional(v.number()),
});

const telegramFileAttachmentSchema = v.object({
  file_id: v.string(),
  file_name: v.optional(v.string()),
  mime_type: v.optional(v.string()),
  file_size: v.optional(v.number()),
});

const telegramMessageSchema = v.object({
  message_id: v.number(),
  from: v.optional(telegramUserSchema),
  chat: telegramChatSchema,
  text: v.optional(v.string()),
  caption: v.optional(v.string()),
  entities: v.optional(v.array(telegramMessageEntitySchema)),
  document: v.optional(telegramFileAttachmentSchema),
  photo: v.optional(v.array(telegramPhotoSizeSchema)),
  video: v.optional(telegramFileAttachmentSchema),
  audio: v.optional(telegramFileAttachmentSchema),
});

export const telegramUpdateSchema = v.object({
  update_id: v.number(),
  message: v.optional(telegramMessageSchema),
});

export type TelegramUpdate = v.InferOutput<typeof telegramUpdateSchema>;
export type TelegramMessage = v.InferOutput<typeof telegramMessageSchema>;
export type TelegramMessageEntity = v.InferOutput<typeof telegramMessageEntitySchema>;
