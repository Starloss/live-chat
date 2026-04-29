import { z } from "zod";

export const messageReceiptStatusSchema = z.enum(["DELIVERED", "READ"]);

const cuidIdSchema = z.string().trim().cuid();

export const markMessageReceiptBodySchema = z.object({
  status: messageReceiptStatusSchema
});

export const markMessageReceiptParamsSchema = z.object({
  channelId: cuidIdSchema,
  messageId: cuidIdSchema
});

export const messageReceiptSocketPayloadSchema = z.object({
  channelId: cuidIdSchema,
  messageId: cuidIdSchema,
  status: messageReceiptStatusSchema
});

export type MarkMessageReceiptBody = z.infer<typeof markMessageReceiptBodySchema>;
export type MessageReceiptSocketPayload = z.infer<typeof messageReceiptSocketPayloadSchema>;
