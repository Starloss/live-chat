import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { getChannelAccess } from "../channels/channel-access";

const presenceQuerySchema = z.object({
  channelId: z.string().trim().min(1)
});

function normalizePresence(status: "ONLINE" | "OFFLINE") {
  return status === "ONLINE" ? "online" : "offline";
}

export async function listPresenceByChannel(req: Request, res: Response) {
  const userId = req.authUser?.id;
  if (!userId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  const parsedQuery = presenceQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ message: "Query inválida" });
  }

  const { channelId } = parsedQuery.data;

  const access = await getChannelAccess(userId, channelId);
  if (!access.channelExists) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  if (!access.membership) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  const members = await prisma.channelMember.findMany({
    where: { channelId },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          username: true,
          presences: {
            orderBy: { updatedAt: "desc" },
            take: 1,
            select: {
              status: true,
              lastSeenAt: true,
              updatedAt: true
            }
          }
        }
      }
    },
    orderBy: { joinedAt: "asc" }
  });

  return res.status(200).json({
    users: members.map((member) => {
      const presence = member.user.presences[0];
      return {
        userId: member.user.id,
        username: member.user.username,
        role: member.role,
        status: presence ? normalizePresence(presence.status) : "offline",
        lastSeenAt: presence?.lastSeenAt ?? null,
        updatedAt: presence?.updatedAt ?? null
      };
    })
  });
}
