import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";

const createChannelSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "El nombre debe tener minúsculas, números o guiones")
});

const channelIdParamsSchema = z.object({
  channelId: z.string().trim().min(1)
});

function getAuthUserId(req: Request) {
  return req.authUser?.id;
}

export async function createChannel(req: Request, res: Response) {
  const userId = getAuthUserId(req);
  if (!userId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  const parsedBody = createChannelSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ message: "Payload inválido" });
  }

  const { name } = parsedBody.data;

  try {
    const channel = await prisma.$transaction(async (transaction) => {
      const createdChannel = await transaction.channel.create({
        data: {
          name,
          createdById: userId
        },
        select: {
          id: true,
          name: true,
          createdAt: true
        }
      });

      await transaction.channelMember.create({
        data: {
          channelId: createdChannel.id,
          userId,
          role: "OWNER"
        }
      });

      return createdChannel;
    });

    return res.status(201).json({
      channel: {
        id: channel.id,
        name: channel.name,
        createdAt: channel.createdAt,
        role: "OWNER"
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return res.status(409).json({ message: "El canal ya existe" });
    }

    return res.status(500).json({ message: "No se pudo crear el canal" });
  }
}

export async function listChannels(req: Request, res: Response) {
  const userId = getAuthUserId(req);
  if (!userId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  const memberships = await prisma.channelMember.findMany({
    where: { userId },
    orderBy: { joinedAt: "desc" },
    select: {
      role: true,
      joinedAt: true,
      channel: {
        select: {
          id: true,
          name: true,
          createdAt: true
        }
      }
    }
  });

  const channels = memberships.map((membership) => ({
    id: membership.channel.id,
    name: membership.channel.name,
    createdAt: membership.channel.createdAt,
    joinedAt: membership.joinedAt,
    role: membership.role
  }));

  return res.status(200).json({ channels });
}

export async function joinChannel(req: Request, res: Response) {
  const userId = getAuthUserId(req);
  if (!userId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  const parsedParams = channelIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ message: "Parámetros inválidos" });
  }

  const { channelId } = parsedParams.data;

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true }
  });

  if (!channel) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  try {
    const membership = await prisma.channelMember.create({
      data: {
        channelId,
        userId,
        role: "MEMBER"
      },
      select: {
        id: true,
        channelId: true,
        userId: true,
        role: true,
        joinedAt: true
      }
    });

    return res.status(200).json({ membership });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existingMembership = await prisma.channelMember.findFirst({
        where: {
          channelId,
          userId
        },
        select: {
          id: true,
          channelId: true,
          userId: true,
          role: true,
          joinedAt: true
        }
      });

      return res.status(200).json({ membership: existingMembership });
    }

    return res.status(500).json({ message: "No se pudo unir al canal" });
  }
}

export async function getChannelMembers(req: Request, res: Response) {
  const channelId = req.channelAccess?.channelId;

  if (!channelId) {
    return res.status(403).json({ message: "No tienes acceso a este canal" });
  }

  const members = await prisma.channelMember.findMany({
    where: { channelId },
    orderBy: { joinedAt: "asc" },
    select: {
      role: true,
      joinedAt: true,
      user: {
        select: {
          id: true,
          username: true,
          email: true
        }
      }
    }
  });

  return res.status(200).json({
    members: members.map((member) => ({
      id: member.user.id,
      username: member.user.username,
      email: member.user.email,
      role: member.role,
      joinedAt: member.joinedAt
    }))
  });
}
