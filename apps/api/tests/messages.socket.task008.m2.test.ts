import { createServer } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { registerChatSocket } from "../src/socket/chat.socket";

interface AuthSession {
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
  };
}

interface SocketAckResponse<TData = unknown> {
  ok: boolean;
  message?: string;
  code?: string;
  data?: TData;
}

interface MessageSocketPayload {
  id: string;
  channelId: string;
  conversationId: string | null;
  body: string;
  createdAt: string | Date;
  clientMessageId: string | null;
  deduplicated: boolean;
  author: {
    id: string;
    username: string;
  };
}

const app = createApp();
const trackedSockets = new Set<Socket>();

let socketHttpServer: ReturnType<typeof createServer> | undefined;
let ioServer: Server | undefined;
let socketServerBaseUrl = "";

function uniqueToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function bearerToken(token: string) {
  return `Bearer ${token}`;
}

async function registerUser(prefix: string): Promise<AuthSession> {
  const suffix = uniqueToken();
  const username = `${prefix}${suffix}`.slice(0, 30);
  const email = `${username}@task008-m2-socket.test`;

  const response = await request(app).post("/api/auth/register").send({
    username,
    email,
    password: "password123"
  });

  expect(response.status).toBe(201);

  return {
    token: response.body.accessToken as string,
    user: response.body.user as AuthSession["user"]
  };
}

async function createChannel(token: string) {
  const response = await request(app)
    .post("/api/channels")
    .set("authorization", bearerToken(token))
    .send({
      name: `task008-socket-${uniqueToken()}`,
      visibility: "PUBLIC"
    });

  expect(response.status).toBe(201);

  return response.body.channel.id as string;
}

async function getWrapperConversationId(channelId: string) {
  const wrapperConversation = await prisma.conversation.findUnique({
    where: {
      channelId
    },
    select: {
      id: true
    }
  });

  expect(wrapperConversation?.id).toBeTruthy();

  return wrapperConversation!.id;
}

async function connectChatSocket(token: string) {
  const socket = createSocketClient(`${socketServerBaseUrl}/chat`, {
    auth: { token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false
  });

  trackedSockets.add(socket);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      reject(new Error("Timeout conectando al socket /chat"));
    }, 5_000);

    const onConnect = () => {
      clearTimeout(timeout);
      socket.off("connect_error", onError);
      resolve();
    };

    const onError = (error: Error) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
  });

  return socket;
}

function onceSocketEvent<TPayload>(socket: Socket, eventName: string) {
  return new Promise<TPayload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timeout esperando evento ${eventName}`));
    }, 5_000);

    const onEvent = (payload: TPayload) => {
      clearTimeout(timeout);
      resolve(payload);
    };

    socket.once(eventName, onEvent);
  });
}

function emitWithAck<TData>(socket: Socket, eventName: string, payload: unknown) {
  return new Promise<SocketAckResponse<TData>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout esperando ack para ${eventName}`));
    }, 5_000);

    socket.emit(eventName, payload, (ack: SocketAckResponse<TData>) => {
      clearTimeout(timeout);
      resolve(ack);
    });
  });
}

describe("TASK-008 M2 socket conversation-first", () => {
  beforeAll(async () => {
    socketHttpServer = createServer(app);
    ioServer = new Server(socketHttpServer, {
      cors: {
        origin: "http://localhost:5173",
        methods: ["GET", "POST"]
      }
    });

    registerChatSocket(ioServer);

    await new Promise<void>((resolve, reject) => {
      socketHttpServer.once("error", reject);
      socketHttpServer.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });

    const address = socketHttpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("No se pudo resolver puerto del servidor de socket");
    }

    socketServerBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const socket of trackedSockets) {
      socket.disconnect();
    }
    trackedSockets.clear();

    if (ioServer) {
      await new Promise<void>((resolve) => {
        ioServer?.close(() => resolve());
      });
      ioServer = undefined;
    }

    if (socketHttpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        socketHttpServer?.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
    socketHttpServer = undefined;
  });

  it("permite message:send por conversationId sin channelId y mantiene payload legacy", async () => {
    const session = await registerUser("task008socket-conv");
    const channelId = await createChannel(session.token);
    const conversationId = await getWrapperConversationId(channelId);
    const socket = await connectChatSocket(session.token);

    const joinAck = await emitWithAck<{ channelId: string }>(socket, "channel:join", { channelId });
    expect(joinAck.ok).toBe(true);

    const messageEventPromise = onceSocketEvent<MessageSocketPayload>(socket, "message:new");
    const sendAck = await emitWithAck<MessageSocketPayload>(socket, "message:send", {
      conversationId,
      body: "mensaje socket conversation-only"
    });

    expect(sendAck.ok).toBe(true);

    const ackPayload = sendAck.data as MessageSocketPayload;
    expect(ackPayload.channelId).toBe(channelId);
    expect(ackPayload.conversationId).toBe(conversationId);
    expect(ackPayload.body).toBe("mensaje socket conversation-only");

    const eventPayload = await messageEventPromise;
    expect(eventPayload.id).toBe(ackPayload.id);
    expect(eventPayload.channelId).toBe(channelId);
    expect(eventPayload.conversationId).toBe(conversationId);

    socket.disconnect();
    trackedSockets.delete(socket);
  });

  it("mantiene compatibilidad socket legacy por channelId", async () => {
    const session = await registerUser("task008socket-legacy");
    const channelId = await createChannel(session.token);
    const socket = await connectChatSocket(session.token);

    const joinAck = await emitWithAck<{ channelId: string }>(socket, "channel:join", { channelId });
    expect(joinAck.ok).toBe(true);

    const sendAck = await emitWithAck<MessageSocketPayload>(socket, "message:send", {
      channelId,
      body: "mensaje socket legacy"
    });

    expect(sendAck.ok).toBe(true);

    const ackPayload = sendAck.data as MessageSocketPayload;
    expect(ackPayload.channelId).toBe(channelId);
    expect(ackPayload.body).toBe("mensaje socket legacy");
    expect(ackPayload.conversationId).toBeTruthy();

    socket.disconnect();
    trackedSockets.delete(socket);
  });
});
