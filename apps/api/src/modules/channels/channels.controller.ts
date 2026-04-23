import { ChannelRequestStatus, ChannelVisibility, Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";

const createChannelSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "El nombre debe tener minúsculas, números o guiones"),
  visibility: z.enum(["PUBLIC", "PRIVATE"]).default("PUBLIC")
});

const channelIdParamsSchema = z.object({
  channelId: z.string().trim().min(1)
});

const requestDecisionParamsSchema = z.object({
  channelId: z.string().trim().min(1),
  requestId: z.string().trim().min(1)
});

const discoverChannelsQuerySchema = z.object({
  query: z.string().trim().max(50).optional()
});

const createChannelInvitationSchema = z
  .object({
    username: z.string().trim().min(3).max(30).optional(),
    email: z.string().trim().email().optional()
  })
  .refine((data) => Boolean(data.username || data.email), {
    message: "Payload inválido"
  });

const channelMembershipSelect = {
  id: true,
  channelId: true,
  userId: true,
  role: true,
  joinedAt: true
} satisfies Prisma.ChannelMemberSelect;

async function acceptPendingPrivateInvitation(channelId: string, userId: string) {
  return prisma.$transaction(async (transaction) => {
    const invitation = await transaction.channelJoinRequest.findFirst({
      where: {
        channelId,
        userId,
        status: ChannelRequestStatus.PENDING
      },
      select: {
        id: true
      }
    });

    if (!invitation) {
      return null;
    }

    await transaction.channelJoinRequest.update({
      where: {
        id: invitation.id
      },
      data: {
        status: ChannelRequestStatus.APPROVED
      }
    });

    return transaction.channelMember.upsert({
      where: {
        channelId_userId: {
          channelId,
          userId
        }
      },
      update: {},
      create: {
        channelId,
        userId,
        role: "MEMBER"
      },
      select: channelMembershipSelect
    });
  });
}

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

  const { name, visibility } = parsedBody.data;

  try {
    const channel = await prisma.$transaction(async (transaction) => {
      const createdChannel = await transaction.channel.create({
        data: {
          name,
          createdById: userId,
          visibility
        },
        select: {
          id: true,
          name: true,
          visibility: true,
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
        visibility: channel.visibility,
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
          visibility: true,
          createdAt: true
        }
      }
    }
  });

  const channels = memberships.map((membership) => ({
    id: membership.channel.id,
    name: membership.channel.name,
    visibility: membership.channel.visibility,
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
    select: {
      id: true,
      visibility: true
    }
  });

  if (!channel) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  const existingMembership = await prisma.channelMember.findFirst({
    where: {
      channelId,
      userId
    },
    select: channelMembershipSelect
  });

  if (existingMembership) {
    return res.status(200).json({
      result: "joined",
      membership: existingMembership
    });
  }

  if (channel.visibility === ChannelVisibility.PUBLIC) {
    const membership = await prisma.channelMember.create({
      data: {
        channelId,
        userId,
        role: "MEMBER"
      },
      select: channelMembershipSelect
    });

    return res.status(200).json({
      result: "joined",
      membership
    });
  }

  const membership = await acceptPendingPrivateInvitation(channelId, userId);

  if (!membership) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  return res.status(200).json({
    result: "joined",
    membership
  });
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
          username: true
        }
      }
    }
  });

  return res.status(200).json({
    members: members.map((member) => ({
      id: member.user.id,
      username: member.user.username,
      role: member.role,
      joinedAt: member.joinedAt
    }))
  });
}

export async function discoverChannels(req: Request, res: Response) {
  const userId = getAuthUserId(req);
  if (!userId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  const parsedQuery = discoverChannelsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ message: "Query inválida" });
  }

  const query = parsedQuery.data.query?.toLowerCase() ?? "";

  const channels = await prisma.channel.findMany({
    where: {
      OR: [
        {
          visibility: ChannelVisibility.PUBLIC
        },
        {
          members: {
            some: {
              userId
            }
          }
        },
        {
          joinRequests: {
            some: {
              userId,
              status: ChannelRequestStatus.PENDING
            }
          }
        }
      ],
      ...(query
        ? {
            name: {
              contains: query,
              mode: "insensitive"
            }
          }
        : {})
    },
    orderBy: [{ createdAt: "desc" }],
    take: 30,
    select: {
      id: true,
      name: true,
      visibility: true,
      createdById: true,
      _count: {
        select: {
          members: true
        }
      },
      members: {
        where: {
          userId
        },
        select: {
          role: true
        },
        take: 1
      },
      joinRequests: {
        where: {
          userId,
          status: ChannelRequestStatus.PENDING
        },
        select: {
          id: true,
          status: true,
          updatedAt: true
        },
        take: 1
      }
    }
  });

  return res.status(200).json({
    channels: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      visibility: channel.visibility,
      isOwner: channel.createdById === userId,
      memberCount: channel._count.members,
      membershipRole: channel.members[0]?.role ?? null,
      joinRequest: channel.joinRequests[0] ?? null
    }))
  });
}

export async function inviteChannelMember(req: Request, res: Response) {
  const userId = getAuthUserId(req);
  if (!userId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  const parsedParams = channelIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ message: "Parámetros inválidos" });
  }

  const parsedBody = createChannelInvitationSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ message: "Payload inválido" });
  }

  const { channelId } = parsedParams.data;
  const { username, email } = parsedBody.data;

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      createdById: true,
      visibility: true
    }
  });

  if (!channel) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  if (channel.createdById !== userId) {
    return res.status(403).json({ message: "Solo el owner puede invitar miembros" });
  }

  if (channel.visibility !== ChannelVisibility.PRIVATE) {
    return res.status(400).json({ message: "Solo los canales privados usan invitaciones" });
  }

  const targetUser = await prisma.user.findFirst({
    where:
      username && email
        ? {
            username,
            email
          }
        : username
          ? {
              username
            }
          : {
              email
            },
    select: {
      id: true
    }
  });

  if (targetUser && targetUser.id !== userId) {
    const existingMember = await prisma.channelMember.findFirst({
      where: {
        channelId,
        userId: targetUser.id
      },
      select: {
        id: true
      }
    });

    if (!existingMember) {
      await prisma.channelJoinRequest.upsert({
        where: {
          channelId_userId: {
            channelId,
            userId: targetUser.id
          }
        },
        update: {
          status: ChannelRequestStatus.PENDING
        },
        create: {
          channelId,
          userId: targetUser.id,
          status: ChannelRequestStatus.PENDING
        }
      });
    }
  }

  return res.status(202).json({
    message: "Si el usuario existe y es elegible, la invitación será procesada"
  });
}

export async function acceptChannelInvitation(req: Request, res: Response) {
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
    select: {
      id: true,
      visibility: true
    }
  });

  if (!channel) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  if (channel.visibility !== ChannelVisibility.PRIVATE) {
    return res.status(400).json({ message: "Canal público no requiere invitación" });
  }

  const existingMembership = await prisma.channelMember.findFirst({
    where: {
      channelId,
      userId
    },
    select: channelMembershipSelect
  });

  if (existingMembership) {
    return res.status(200).json({
      result: "joined",
      membership: existingMembership
    });
  }

  const membership = await acceptPendingPrivateInvitation(channelId, userId);

  if (!membership) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  return res.status(200).json({
    result: "joined",
    membership
  });
}

export async function listChannelJoinRequests(req: Request, res: Response) {
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
    select: {
      id: true,
      createdById: true
    }
  });

  if (!channel) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  if (channel.createdById !== userId) {
    return res.status(403).json({ message: "Solo el owner puede ver solicitudes" });
  }

  const requests = await prisma.channelJoinRequest.findMany({
    where: {
      channelId,
      status: ChannelRequestStatus.PENDING
    },
    orderBy: {
      createdAt: "asc"
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          username: true
        }
      }
    }
  });

  return res.status(200).json({
    requests: requests.map((request) => ({
      id: request.id,
      status: request.status,
      createdAt: request.createdAt,
      user: request.user
    }))
  });
}

async function resolveJoinRequest(req: Request, res: Response, status: "APPROVED" | "DENIED") {
  const userId = getAuthUserId(req);
  if (!userId) {
    return res.status(401).json({ message: "No autenticado" });
  }

  const parsedParams = requestDecisionParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ message: "Parámetros inválidos" });
  }

  const { channelId, requestId } = parsedParams.data;

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      createdById: true
    }
  });

  if (!channel) {
    return res.status(404).json({ message: "Canal no encontrado" });
  }

  if (channel.createdById !== userId) {
    return res.status(403).json({ message: "Solo el owner puede gestionar solicitudes" });
  }

  const request = await prisma.channelJoinRequest.findFirst({
    where: {
      id: requestId,
      channelId
    },
    select: {
      id: true,
      userId: true,
      status: true
    }
  });

  if (!request) {
    return res.status(404).json({ message: "Solicitud no encontrada" });
  }

  const result = await prisma.$transaction(async (transaction) => {
    const updatedRequest = await transaction.channelJoinRequest.update({
      where: {
        id: request.id
      },
      data: {
        status
      },
      select: {
        id: true,
        status: true,
        userId: true,
        updatedAt: true
      }
    });

    if (status === ChannelRequestStatus.APPROVED) {
      await transaction.channelMember.upsert({
        where: {
          channelId_userId: {
            channelId,
            userId: request.userId
          }
        },
        update: {},
        create: {
          channelId,
          userId: request.userId,
          role: "MEMBER"
        }
      });
    }

    return updatedRequest;
  });

  return res.status(200).json({ request: result });
}

export async function approveChannelJoinRequest(req: Request, res: Response) {
  return resolveJoinRequest(req, res, ChannelRequestStatus.APPROVED);
}

export async function denyChannelJoinRequest(req: Request, res: Response) {
  return resolveJoinRequest(req, res, ChannelRequestStatus.DENIED);
}
