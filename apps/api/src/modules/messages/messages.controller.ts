import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { createChannelMessageIdempotent } from "./message-idempotency";
import {
  markMessageReceiptBodySchema,
  markMessageReceiptParamsSchema
} from "./message-receipt.schema";
import {
  applyMessageReceiptTransition,
  MessageReceiptTransitionError,
  messageReceiptSelect,
  toMessageReceiptState
} from "./message-receipts";
import { clientMessageIdSchema } from "./message-send.schema";

const listMessagesQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30)
});

const createMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(2000),
  clientMessageId: clientMessageIdSchema.optional()
});

export async function listChannelMessages(req: Request, res: Response) {
  const channelId = req.channelAccess?.channelId;
  const viewerUserId = req.authUser?.id;

  if (!channelId || !viewerUserId) {
    return res.status(403).json({ message: "No tienes acceso a este canal" });
  }

  const parsedQuery = listMessagesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ message: "Query inválida" });
  }

  const { cursor, limit } = parsedQuery.data;

  const messages = await prisma.message.findMany({
    where: {
      channelId,
      deletedAt: null
    },
    select: {
      id: true,
      channelId: true,
      authorId: true,
      body: true,
      createdAt: true,
      updatedAt: true,
      receipts: {
        where: {
          userId: viewerUserId
        },
        take: 1,
        select: messageReceiptSelect
      }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    ...(cursor
      ? {
          cursor: { id: cursor },
          skip: 1
        }
      : {})
  });

  const nextCursor = messages.length === limit ? messages[messages.length - 1].id : null;

  return res.status(200).json({
    messages: messages.map((message) => ({
      id: message.id,
      channelId: message.channelId,
      authorId: message.authorId,
      body: message.body,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      viewerReceipt: toMessageReceiptState(message.receipts[0] ?? null)
    })),
    nextCursor
  });
}

export async function createChannelMessage(req: Request, res: Response) {
  const channelId = req.channelAccess?.channelId;
  const authorId = req.authUser?.id;

  if (!channelId || !authorId) {
    return res.status(403).json({ message: "No tienes acceso a este canal" });
  }

  const parsedBody = createMessageBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ message: "Payload inválido" });
  }

  const { body, clientMessageId } = parsedBody.data;

  const { message, deduplicated } = await createChannelMessageIdempotent({
    channelId,
    authorId,
    body,
    clientMessageId
  });

  return res.status(201).json({
    message,
    clientMessageId: clientMessageId ?? null,
    deduplicated
  });
}

export async function markMessageReceipt(req: Request, res: Response) {
  const channelId = req.channelAccess?.channelId;
  const userId = req.authUser?.id;

  if (!channelId || !userId) {
    return res.status(403).json({ message: "No tienes acceso a este canal" });
  }

  const parsedParams = markMessageReceiptParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ message: "Parámetros inválidos" });
  }

  const parsedBody = markMessageReceiptBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ message: "Payload inválido" });
  }

  try {
    const receipt = await applyMessageReceiptTransition({
      channelId,
      messageId: parsedParams.data.messageId,
      userId,
      status: parsedBody.data.status
    });

    return res.status(200).json({ receipt });
  } catch (error) {
    if (error instanceof MessageReceiptTransitionError && error.code === "MESSAGE_NOT_FOUND") {
      return res.status(404).json({ message: "Mensaje no encontrado" });
    }

    throw error;
  }
}
