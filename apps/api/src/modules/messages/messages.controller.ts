import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";

const listMessagesQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30)
});

const createMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(2000)
});

export async function listChannelMessages(req: Request, res: Response) {
  const channelId = req.channelAccess?.channelId;

  if (!channelId) {
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
      updatedAt: message.updatedAt
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

  const { body } = parsedBody.data;

  const message = await prisma.message.create({
    data: {
      channelId,
      authorId,
      body
    },
    select: {
      id: true,
      channelId: true,
      authorId: true,
      body: true,
      createdAt: true,
      updatedAt: true
    }
  });

  return res.status(201).json({ message });
}
