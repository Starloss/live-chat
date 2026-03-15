import { z } from "zod";
import type { Server } from "socket.io";
import { prisma } from "../lib/prisma";
import { getChannelAccess } from "../modules/channels/channel-access";
import { verifyAccessToken } from "../modules/auth/auth.utils";

const channelJoinSchema = z.object({
  channelId: z.string().trim().min(1)
});

const messageSendSchema = z.object({
  channelId: z.string().trim().min(1),
  body: z.string().trim().min(1).max(2000)
});

const typingSchema = z.object({
  channelId: z.string().trim().min(1)
});

type Ack = (response: { ok: boolean; message?: string; code?: string; data?: unknown }) => void;

interface SocketAuthUser {
  id: string;
  email: string;
  username: string;
}

const activeConnectionsByUser = new Map<string, number>();

function getChannelRoom(channelId: string) {
  return `channel:${channelId}`;
}

async function userCanAccessChannel(userId: string, channelId: string) {
  const access = await getChannelAccess(userId, channelId);
  return Boolean(access.membership);
}

async function broadcastPresenceToUserChannels(
  chat: ReturnType<Server["of"]>,
  user: SocketAuthUser,
  status: "online" | "offline",
  lastSeenAt: Date | null
) {
  const memberships = await prisma.channelMember.findMany({
    where: { userId: user.id },
    select: { channelId: true }
  });

  const uniqueChannelIds = Array.from(new Set(memberships.map((membership) => membership.channelId)));
  for (const channelId of uniqueChannelIds) {
    chat.to(getChannelRoom(channelId)).emit("presence:update", {
      channelId,
      userId: user.id,
      username: user.username,
      status,
      lastSeenAt
    });
  }
}

async function setPresenceOnline(chat: ReturnType<Server["of"]>, user: SocketAuthUser) {
  await prisma.userPresence.upsert({
    where: { userId: user.id },
    update: {
      status: "ONLINE",
      lastSeenAt: null
    },
    create: {
      userId: user.id,
      status: "ONLINE"
    }
  });

  await broadcastPresenceToUserChannels(chat, user, "online", null);
}

async function setPresenceOffline(chat: ReturnType<Server["of"]>, user: SocketAuthUser) {
  const now = new Date();
  await prisma.userPresence.upsert({
    where: { userId: user.id },
    update: {
      status: "OFFLINE",
      lastSeenAt: now
    },
    create: {
      userId: user.id,
      status: "OFFLINE",
      lastSeenAt: now
    }
  });

  const activeTypingStates = await prisma.typingState.findMany({
    where: {
      userId: user.id,
      isTyping: true
    },
    select: {
      channelId: true
    }
  });

  await prisma.typingState.updateMany({
    where: {
      userId: user.id,
      isTyping: true
    },
    data: {
      isTyping: false
    }
  });

  for (const typingState of activeTypingStates) {
    chat.to(getChannelRoom(typingState.channelId)).emit("typing:update", {
      channelId: typingState.channelId,
      userId: user.id,
      username: user.username,
      isTyping: false
    });
  }

  await broadcastPresenceToUserChannels(chat, user, "offline", now);
}

function getTokenFromHandshake(handshake: {
  auth?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}) {
  const authToken = handshake.auth?.token;
  if (typeof authToken === "string" && authToken.trim()) {
    return authToken.trim();
  }

  const authorizationHeader = handshake.headers?.authorization;
  if (typeof authorizationHeader === "string" && authorizationHeader.startsWith("Bearer ")) {
    return authorizationHeader.slice("Bearer ".length).trim();
  }

  return null;
}

export function registerChatSocket(io: Server) {
  const chat = io.of("/chat");

  chat.use((socket, next) => {
    const token = getTokenFromHandshake({
      auth: socket.handshake.auth as Record<string, unknown> | undefined,
      headers: socket.handshake.headers as Record<string, string | string[] | undefined> | undefined
    });

    if (!token) {
      return next(new Error("UNAUTHORIZED"));
    }

    try {
      const payload = verifyAccessToken(token);
      socket.data.user = {
        id: payload.sub,
        email: payload.email,
        username: payload.username
      } satisfies SocketAuthUser;

      return next();
    } catch {
      return next(new Error("UNAUTHORIZED"));
    }
  });

  chat.on("connection", (socket) => {
    const user = socket.data.user as SocketAuthUser | undefined;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    const currentConnections = activeConnectionsByUser.get(user.id) ?? 0;
    const nextConnections = currentConnections + 1;
    activeConnectionsByUser.set(user.id, nextConnections);

    if (nextConnections === 1) {
      void setPresenceOnline(chat, user);
    }

    socket.emit("system:message", "Conectado al namespace /chat");

    socket.on("channel:join", async (rawPayload: unknown, ack?: Ack) => {
      const parsed = channelJoinSchema.safeParse(rawPayload);
      if (!parsed.success) {
        ack?.({ ok: false, code: "BAD_PAYLOAD", message: "Payload inválido" });
        return;
      }

      const { channelId } = parsed.data;
      const canAccess = await userCanAccessChannel(user.id, channelId);
      if (!canAccess) {
        ack?.({ ok: false, code: "FORBIDDEN", message: "No tienes acceso a este canal" });
        return;
      }

      socket.join(getChannelRoom(channelId));
      socket.emit("channel:joined", { channelId });
      ack?.({ ok: true, data: { channelId } });
    });

    socket.on("message:send", async (rawPayload: unknown, ack?: Ack) => {
      const parsed = messageSendSchema.safeParse(rawPayload);
      if (!parsed.success) {
        ack?.({ ok: false, code: "BAD_PAYLOAD", message: "Payload inválido" });
        return;
      }

      const { channelId, body } = parsed.data;
      const canAccess = await userCanAccessChannel(user.id, channelId);
      if (!canAccess) {
        ack?.({ ok: false, code: "FORBIDDEN", message: "No tienes acceso a este canal" });
        return;
      }

      const message = await prisma.message.create({
        data: {
          channelId,
          authorId: user.id,
          body
        },
        select: {
          id: true,
          channelId: true,
          body: true,
          createdAt: true,
          author: {
            select: {
              id: true,
              username: true
            }
          }
        }
      });

      const payload = {
        id: message.id,
        channelId: message.channelId,
        body: message.body,
        createdAt: message.createdAt,
        author: message.author
      };

      chat.to(getChannelRoom(channelId)).emit("message:new", payload);
      ack?.({ ok: true, data: payload });
    });

    socket.on("typing:start", async (rawPayload: unknown, ack?: Ack) => {
      const parsed = typingSchema.safeParse(rawPayload);
      if (!parsed.success) {
        ack?.({ ok: false, code: "BAD_PAYLOAD", message: "Payload inválido" });
        return;
      }

      const { channelId } = parsed.data;
      const canAccess = await userCanAccessChannel(user.id, channelId);
      if (!canAccess) {
        ack?.({ ok: false, code: "FORBIDDEN", message: "No tienes acceso a este canal" });
        return;
      }

      await prisma.typingState.upsert({
        where: {
          channelId_userId: {
            channelId,
            userId: user.id
          }
        },
        update: {
          isTyping: true
        },
        create: {
          channelId,
          userId: user.id,
          isTyping: true
        }
      });

      chat.to(getChannelRoom(channelId)).emit("typing:update", {
        channelId,
        userId: user.id,
        username: user.username,
        isTyping: true
      });

      ack?.({ ok: true, data: { channelId, isTyping: true } });
    });

    socket.on("typing:stop", async (rawPayload: unknown, ack?: Ack) => {
      const parsed = typingSchema.safeParse(rawPayload);
      if (!parsed.success) {
        ack?.({ ok: false, code: "BAD_PAYLOAD", message: "Payload inválido" });
        return;
      }

      const { channelId } = parsed.data;
      const canAccess = await userCanAccessChannel(user.id, channelId);
      if (!canAccess) {
        ack?.({ ok: false, code: "FORBIDDEN", message: "No tienes acceso a este canal" });
        return;
      }

      await prisma.typingState.upsert({
        where: {
          channelId_userId: {
            channelId,
            userId: user.id
          }
        },
        update: {
          isTyping: false
        },
        create: {
          channelId,
          userId: user.id,
          isTyping: false
        }
      });

      chat.to(getChannelRoom(channelId)).emit("typing:update", {
        channelId,
        userId: user.id,
        username: user.username,
        isTyping: false
      });

      ack?.({ ok: true, data: { channelId, isTyping: false } });
    });

    socket.on("disconnect", () => {
      const current = activeConnectionsByUser.get(user.id) ?? 1;
      const next = Math.max(0, current - 1);

      if (next === 0) {
        activeConnectionsByUser.delete(user.id);
        void setPresenceOffline(chat, user);
        return;
      }

      activeConnectionsByUser.set(user.id, next);
    });
  });
}
