import { z } from "zod";

export const messageReceiptStatusSchema = z.enum(["DELIVERED", "READ"]);

export const markMessageReceiptBodySchema = z.object({
  status: messageReceiptStatusSchema
});

export const markMessageReceiptParamsSchema = z.object({
  messageId: z.string().trim().min(1)
});

export const messageReceiptSocketPayloadSchema = z.object({
  channelId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  status: messageReceiptStatusSchema
});

export type MarkMessageReceiptBody = z.infer<typeof markMessageReceiptBodySchema>;
export type MessageReceiptSocketPayload = z.infer<typeof messageReceiptSocketPayloadSchema>;
