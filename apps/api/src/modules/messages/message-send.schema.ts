import { z } from "zod";

export const clientMessageIdSchema = z.string().trim().min(1).max(128);

const messageScopeSchema = z
  .object({
    channelId: z.string().trim().min(1).optional(),
    conversationId: z.string().trim().min(1).optional()
  });

export const messageSendPayloadSchema = messageScopeSchema
  .extend({
    body: z.string().trim().min(1).max(2000),
    clientMessageId: clientMessageIdSchema.optional()
  })
  .refine((value) => Boolean(value.channelId || value.conversationId), {
    message: "channelId o conversationId es requerido"
  });

export type MessageSendPayload = z.infer<typeof messageSendPayloadSchema>;
