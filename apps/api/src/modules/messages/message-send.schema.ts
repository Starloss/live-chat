import { z } from "zod";

export const clientMessageIdSchema = z.string().trim().min(1).max(128);

export const messageSendPayloadSchema = z.object({
  channelId: z.string().trim().min(1),
  body: z.string().trim().min(1).max(2000),
  clientMessageId: clientMessageIdSchema.optional()
});

export type MessageSendPayload = z.infer<typeof messageSendPayloadSchema>;
