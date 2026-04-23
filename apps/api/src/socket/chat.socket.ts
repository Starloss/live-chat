import { z } from "zod";
import type { Server, Socket } from "socket.io";
import { prisma } from "../lib/prisma";
import { getChannelAccess } from "../modules/channels/channel-access";
import { verifyAccessToken } from "../modules/auth/auth.utils";
import { createChannelMessageIdempotent } from "../modules/messages/message-idempotency";
import { messageReceiptSocketPayloadSchema } from "../modules/messages/message-receipt.schema";
import {
  applyMessageReceiptTransition,
  MessageReceiptTransitionError
} from "../modules/messages/message-receipts";
import { messageSendPayloadSchema } from "../modules/messages/message-send.schema";
import {
  SocketEventRateLimiter,
  type RateLimitedSocketEvent,
  type SocketEventRateLimitConfig
} from "./socket-event-rate-limiter";

const channelJoinSchema = z.object({
  channelId: z.string().trim().min(1)
});

const typingSchema = z.object({
  channelId: z.string().trim().min(1)
});

type Ack = (response: { ok: boolean; message?: string; code?: string; data?: unknown }) => void;

interface SocketAuthUser {
  id: string;
  email: string;
  username: string;
  tokenExpiresAtMs: number;
}

const SOCKET_EVENT_RATE_LIMITS = {
  "channel:join": {
    windowMs: 10_000,
    maxEvents: 8
  },
  "message:send": {
    windowMs: 10_000,
    maxEvents: 12
  },
  "message:receipt": {
    windowMs: 10_000,
    maxEvents: 20
  },
  "typing:start": {
    windowMs: 10_000,
    maxEvents: 40
  },
  "typing:stop": {
    windowMs: 10_000,
    maxEvents: 40
  }
} satisfies SocketEventRateLimitConfig;

const RATE_LIMIT_MESSAGE = "Demasiadas solicitudes, intenta de nuevo en unos segundos";
const TOKEN_EXPIRED_MESSAGE = "Token inválido o expirado";
const INTERNAL_ERROR_MESSAGE = "Ocurrió un error interno";

const socketEventRateLimiter = new SocketEventRateLimiter(SOCKET_EVENT_RATE_LIMITS);

const activeConnectionsByUser = new Map<string, number>();

function getChannelRoom(channelId: string) {
  return `channel:${channelId}`;
}

function normalizeIdentity(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getSocketIp(socket: Socket) {
  const forwardedFor = socket.handshake.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string") {
    const firstForwarded = forwardedFor.split(",")[0];
    const normalizedForwardedIp = normalizeIdentity(firstForwarded);
    if (normalizedForwardedIp) {
      return normalizedForwardedIp;
    }
  }

  if (Array.isArray(forwardedFor)) {
    for (const forwardedValue of forwardedFor) {
      const firstForwarded = forwardedValue.split(",")[0];
      const normalizedForwardedIp = normalizeIdentity(firstForwarded);
      if (normalizedForwardedIp) {
        return normalizedForwardedIp;
      }
    }
  }

  return normalizeIdentity(socket.handshake.address);
}

function isRateLimited(
  socket: Socket,
  user: SocketAuthUser | undefined,
  event: RateLimitedSocketEvent
) {
  return !socketEventRateLimiter.consume({
    event,
    userId: user?.id,
    ip: getSocketIp(socket),
    socketId: socket.id
  }).allowed;
}

function respondRateLimited(ack?: Ack) {
  ack?.({
    ok: false,
    code: "RATE_LIMITED",
    message: RATE_LIMIT_MESSAGE
  });
}

function disconnectIfTokenExpired(socket: Socket, user: SocketAuthUser, ack?: Ack) {
  if (Date.now() < user.tokenExpiresAtMs) {
    return false;
  }

  ack?.({
    ok: false,
    code: "TOKEN_EXPIRED",
    message: TOKEN_EXPIRED_MESSAGE
  });
  socket.emit("auth:expired", { message: TOKEN_EXPIRED_MESSAGE });
  socket.disconnect(true);

  return true;
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
      const tokenExpiresAtMs = payload.exp * 1000;
      if (tokenExpiresAtMs <= Date.now()) {
        return next(new Error("UNAUTHORIZED"));
      }

      socket.data.user = {
        id: payload.sub,
        email: payload.email,
        username: payload.username,
        tokenExpiresAtMs
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

    if (disconnectIfTokenExpired(socket, user)) {
      return;
    }

    const msUntilTokenExpiry = Math.max(1, user.tokenExpiresAtMs - Date.now());
    const tokenExpiryTimer = setTimeout(() => {
      socket.emit("auth:expired", { message: TOKEN_EXPIRED_MESSAGE });
      socket.disconnect(true);
    }, msUntilTokenExpiry);
    tokenExpiryTimer.unref?.();

    const currentConnections = activeConnectionsByUser.get(user.id) ?? 0;
    const nextConnections = currentConnections + 1;
    activeConnectionsByUser.set(user.id, nextConnections);

    if (nextConnections === 1) {
      void setPresenceOnline(chat, user);
    }

    socket.emit("system:message", "Conectado al namespace /chat");

    socket.on("channel:join", async (rawPayload: unknown, ack?: Ack) => {
      if (disconnectIfTokenExpired(socket, user, ack)) {
        return;
      }

      if (isRateLimited(socket, user, "channel:join")) {
        respondRateLimited(ack);
        return;
      }

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
      if (disconnectIfTokenExpired(socket, user, ack)) {
        return;
      }

      if (isRateLimited(socket, user, "message:send")) {
        respondRateLimited(ack);
        return;
      }

      const parsed = messageSendPayloadSchema.safeParse(rawPayload);
      if (!parsed.success) {
        ack?.({ ok: false, code: "BAD_PAYLOAD", message: "Payload inválido" });
        return;
      }

      const { channelId, body, clientMessageId } = parsed.data;
      const canAccess = await userCanAccessChannel(user.id, channelId);
      if (!canAccess) {
        ack?.({ ok: false, code: "FORBIDDEN", message: "No tienes acceso a este canal" });
        return;
      }

      const { message, deduplicated } = await createChannelMessageIdempotent({
        channelId,
        authorId: user.id,
        body,
        clientMessageId
      });

      const payload = {
        id: message.id,
        channelId: message.channelId,
        body: message.body,
        createdAt: message.createdAt,
        clientMessageId: clientMessageId ?? null,
        deduplicated,
        author: {
          id: user.id,
          username: user.username
        }
      };

      chat.to(getChannelRoom(channelId)).emit("message:new", payload);

      ack?.({ ok: true, data: payload });
    });

    socket.on("typing:start", async (rawPayload: unknown, ack?: Ack) => {
      if (disconnectIfTokenExpired(socket, user, ack)) {
        return;
      }

      if (isRateLimited(socket, user, "typing:start")) {
        respondRateLimited(ack);
        return;
      }

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

    socket.on("message:receipt", async (rawPayload: unknown, ack?: Ack) => {
      try {
        if (disconnectIfTokenExpired(socket, user, ack)) {
          return;
        }

        if (isRateLimited(socket, user, "message:receipt")) {
          respondRateLimited(ack);
          return;
        }

        const parsed = messageReceiptSocketPayloadSchema.safeParse(rawPayload);
        if (!parsed.success) {
          ack?.({ ok: false, code: "BAD_PAYLOAD", message: "Payload inválido" });
          return;
        }

        const { channelId, messageId, status } = parsed.data;
        const canAccess = await userCanAccessChannel(user.id, channelId);
        if (!canAccess) {
          ack?.({ ok: false, code: "FORBIDDEN", message: "No tienes acceso a este canal" });
          return;
        }

        const receipt = await applyMessageReceiptTransition({
          channelId,
          messageId,
          userId: user.id,
          status
        });

        const payload = {
          channelId,
          messageId,
          userId: user.id,
          receipt
        };

        chat.to(getChannelRoom(channelId)).emit("message:receipt:update", payload);
        ack?.({ ok: true, data: payload });
      } catch (error) {
        if (error instanceof MessageReceiptTransitionError && error.code === "MESSAGE_NOT_FOUND") {
          ack?.({ ok: false, code: "NOT_FOUND", message: "Mensaje no encontrado" });
          return;
        }

        ack?.({
          ok: false,
          code: "INTERNAL_ERROR",
          message: INTERNAL_ERROR_MESSAGE
        });
      }
    });

    socket.on("typing:stop", async (rawPayload: unknown, ack?: Ack) => {
      if (disconnectIfTokenExpired(socket, user, ack)) {
        return;
      }

      if (isRateLimited(socket, user, "typing:stop")) {
        respondRateLimited(ack);
        return;
      }

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
      clearTimeout(tokenExpiryTimer);

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
