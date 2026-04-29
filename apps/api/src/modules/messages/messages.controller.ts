import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../../config/env";
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
import {
  type MessageScopeResolutionErrorCode,
  resolveMessageScopeForUser
} from "./message-scope";
import { clientMessageIdSchema } from "./message-send.schema";

const listMessagesQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  conversationId: z.string().trim().min(1).optional()
});

const conversationIdParamsSchema = z.object({
  conversationId: z.string().trim().min(1)
});

const createMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(2000),
  clientMessageId: clientMessageIdSchema.optional(),
  channelId: z.string().trim().min(1).optional(),
  conversationId: z.string().trim().min(1).optional()
});

interface ListMessagesBaseInput {
  viewerUserId: string;
  cursor: string | undefined;
  limit: number;
}

type ListMessagesInput =
  | (ListMessagesBaseInput & {
      mode: "channel";
      channelId: string;
    })
  | (ListMessagesBaseInput & {
      mode: "conversation";
      conversationId: string;
    });

function mapMessageScopeErrorToChannelResponse(
  res: Response,
  code: MessageScopeResolutionErrorCode,
  origin: "Query" | "Payload"
) {
  if (code === "MISSING_SCOPE") {
    return res.status(400).json({ message: `${origin} inválida` });
  }

  return res.status(404).json({ message: "Canal no encontrado" });
}

function mapMessageScopeErrorToConversationResponse(
  res: Response,
  code: MessageScopeResolutionErrorCode,
  origin: "Query" | "Payload" | "Parámetros"
) {
  if (code === "MISSING_SCOPE") {
    return res.status(400).json({ message: `${origin} inválidos` });
  }

  return res.status(404).json({ message: "Conversación no encontrada" });
}

async function listMessages(input: ListMessagesInput) {
  const where =
    input.mode === "conversation"
      ? {
          conversationId: input.conversationId,
          deletedAt: null
        }
      : {
          channelId: input.channelId,
          deletedAt: null
        };

  const messages = await prisma.message.findMany({
    where,
    select: {
      id: true,
      channelId: true,
      conversationId: true,
      authorId: true,
      body: true,
      createdAt: true,
      updatedAt: true,
      receipts: {
        where: {
          userId: input.viewerUserId
        },
        take: 1,
        select: messageReceiptSelect
      }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit,
    ...(input.cursor
      ? {
          cursor: { id: input.cursor },
          skip: 1
        }
      : {})
  });

  const nextCursor = messages.length === input.limit ? messages[messages.length - 1].id : null;

  return {
    messages: messages.map((message) => ({
      id: message.id,
      channelId: message.channelId,
      conversationId: message.conversationId,
      authorId: message.authorId,
      body: message.body,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      viewerReceipt: toMessageReceiptState(message.receipts[0] ?? null)
    })),
    nextCursor
  };
}

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

  const { cursor, limit, conversationId } = parsedQuery.data;

  const resolvedScope = await resolveMessageScopeForUser({
    userId: viewerUserId,
    channelId,
    conversationId
  });

  if (!resolvedScope.ok) {
    return mapMessageScopeErrorToChannelResponse(res, resolvedScope.code, "Query");
  }

  const shouldUseConversationScope = Boolean(conversationId && resolvedScope.value.conversationId);

  const listedMessages = await listMessages(
    shouldUseConversationScope
      ? {
          mode: "conversation",
          conversationId: resolvedScope.value.conversationId!,
          viewerUserId,
          cursor,
          limit
        }
      : {
          mode: "channel",
          channelId: resolvedScope.value.channelId,
          viewerUserId,
          cursor,
          limit
        }
  );

  return res.status(200).json(listedMessages);
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

  const { body, clientMessageId, conversationId, channelId: bodyChannelId } = parsedBody.data;

  if (bodyChannelId && bodyChannelId !== channelId) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  const resolvedScope = await resolveMessageScopeForUser({
    userId: authorId,
    channelId,
    conversationId
  });

  if (!resolvedScope.ok) {
    return mapMessageScopeErrorToChannelResponse(res, resolvedScope.code, "Payload");
  }

  const { message, deduplicated } = await createChannelMessageIdempotent({
    channelId: resolvedScope.value.channelId,
    conversationId: resolvedScope.value.conversationId,
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

export async function listConversationMessages(req: Request, res: Response) {
  const viewerUserId = req.authUser?.id;

  if (!viewerUserId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  if (!env.conversationFirstDualWriteEnabled) {
    return res.status(404).json({ message: "Conversación no encontrada" });
  }

  const parsedParams = conversationIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ message: "Parámetros inválidos" });
  }

  const parsedQuery = listMessagesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ message: "Query inválida" });
  }

  const { cursor, limit, conversationId } = parsedQuery.data;

  if (conversationId && conversationId !== parsedParams.data.conversationId) {
    return res.status(404).json({ message: "Conversación no encontrada" });
  }

  const resolvedScope = await resolveMessageScopeForUser({
    userId: viewerUserId,
    conversationId: parsedParams.data.conversationId
  });

  if (!resolvedScope.ok || !resolvedScope.value.conversationId) {
    return mapMessageScopeErrorToConversationResponse(
      res,
      resolvedScope.ok ? "CONVERSATION_NOT_FOUND" : resolvedScope.code,
      "Query"
    );
  }

  const listedMessages = await listMessages({
    mode: "conversation",
    conversationId: resolvedScope.value.conversationId,
    viewerUserId,
    cursor,
    limit
  });

  return res.status(200).json(listedMessages);
}

export async function createConversationMessage(req: Request, res: Response) {
  const authorId = req.authUser?.id;

  if (!authorId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  if (!env.conversationFirstDualWriteEnabled) {
    return res.status(404).json({ message: "Conversación no encontrada" });
  }

  const parsedParams = conversationIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ message: "Parámetros inválidos" });
  }

  const parsedBody = createMessageBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ message: "Payload inválido" });
  }

  if (
    parsedBody.data.conversationId &&
    parsedBody.data.conversationId !== parsedParams.data.conversationId
  ) {
    return res.status(404).json({ message: "Conversación no encontrada" });
  }

  const resolvedScope = await resolveMessageScopeForUser({
    userId: authorId,
    conversationId: parsedParams.data.conversationId,
    channelId: parsedBody.data.channelId
  });

  if (!resolvedScope.ok || !resolvedScope.value.conversationId) {
    return mapMessageScopeErrorToConversationResponse(
      res,
      resolvedScope.ok ? "CONVERSATION_NOT_FOUND" : resolvedScope.code,
      "Payload"
    );
  }

  const { message, deduplicated } = await createChannelMessageIdempotent({
    channelId: resolvedScope.value.channelId,
    conversationId: resolvedScope.value.conversationId,
    authorId,
    body: parsedBody.data.body,
    clientMessageId: parsedBody.data.clientMessageId
  });

  return res.status(201).json({
    message,
    clientMessageId: parsedBody.data.clientMessageId ?? null,
    deduplicated
  });
}
