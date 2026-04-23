import { createServer } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { createApp } from "../src/app";
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
  const email = `${username}@task001-socket.test`;

  const response = await request(app).post("/api/auth/register").send({
    username,
    email,
    password: "password123"
  });

  expect(response.status).toBe(201);
  expect(response.body).toHaveProperty("accessToken");

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
      name: `task001-socket-${uniqueToken()}`,
      visibility: "PUBLIC"
    });

  expect(response.status).toBe(201);

  return response.body.channel.id as string;
}

async function postChannelMessage(input: {
  token: string;
  channelId: string;
  body: string;
  clientMessageId?: string;
}) {
  return request(app)
    .post(`/api/channels/${input.channelId}/messages`)
    .set("authorization", bearerToken(input.token))
    .send({
      body: input.body,
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {})
    });
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

describe("TASK-001 socket message idempotency", () => {
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

  it("reintento con mismo clientMessageId retorna mismo id y deduplicated=true en segundo intento", async () => {
    const session = await registerUser("task001socksame");
    const channelId = await createChannel(session.token);
    const clientMessageId = `cmid-socket-${uniqueToken()}`;
    const socket = await connectChatSocket(session.token);

    const joinAck = await emitWithAck<{ channelId: string }>(socket, "channel:join", { channelId });
    expect(joinAck.ok).toBe(true);

    const firstEventPromise = onceSocketEvent<MessageSocketPayload>(socket, "message:new");
    const firstAck = await emitWithAck<MessageSocketPayload>(socket, "message:send", {
      channelId,
      body: "mensaje socket original",
      clientMessageId
    });

    expect(firstAck.ok).toBe(true);
    const firstMessage = firstAck.data as MessageSocketPayload;
    expect(firstMessage.clientMessageId).toBe(clientMessageId);
    expect(firstMessage.deduplicated).toBe(false);

    const firstEvent = await firstEventPromise;
    expect(firstEvent.id).toBe(firstMessage.id);
    expect(firstEvent.clientMessageId).toBe(clientMessageId);
    expect(firstEvent.deduplicated).toBe(false);

    const secondEventPromise = onceSocketEvent<MessageSocketPayload>(socket, "message:new");
    const secondAck = await emitWithAck<MessageSocketPayload>(socket, "message:send", {
      channelId,
      body: "mensaje socket reintentado",
      clientMessageId
    });

    expect(secondAck.ok).toBe(true);
    const secondMessage = secondAck.data as MessageSocketPayload;
    expect(secondMessage.clientMessageId).toBe(clientMessageId);
    expect(secondMessage.deduplicated).toBe(true);
    expect(secondMessage.id).toBe(firstMessage.id);
    expect(secondMessage.body).toBe(firstMessage.body);

    const secondEvent = await secondEventPromise;
    expect(secondEvent.id).toBe(firstMessage.id);
    expect(secondEvent.body).toBe(firstMessage.body);
    expect(secondEvent.clientMessageId).toBe(clientMessageId);
    expect(secondEvent.deduplicated).toBe(true);

    socket.disconnect();
    trackedSockets.delete(socket);
  });

  it("cuando el mensaje ya existe por HTTP, socket deduplicado mantiene contrato y emite message:new", async () => {
    const session = await registerUser("task001cross");
    const channelId = await createChannel(session.token);
    const clientMessageId = `cmid-cross-${uniqueToken()}`;

    const httpResponse = await postChannelMessage({
      token: session.token,
      channelId,
      body: "mensaje creado por http",
      clientMessageId
    });

    expect(httpResponse.status).toBe(201);
    expect(httpResponse.body.clientMessageId).toBe(clientMessageId);
    expect(httpResponse.body.deduplicated).toBe(false);

    const httpMessage = httpResponse.body.message as { id: string; body: string };

    const socket = await connectChatSocket(session.token);
    const joinAck = await emitWithAck<{ channelId: string }>(socket, "channel:join", { channelId });
    expect(joinAck.ok).toBe(true);

    const dedupEventPromise = onceSocketEvent<MessageSocketPayload>(socket, "message:new");
    const dedupAck = await emitWithAck<MessageSocketPayload>(socket, "message:send", {
      channelId,
      body: "mensaje socket en retry",
      clientMessageId
    });

    expect(dedupAck.ok).toBe(true);
    const dedupMessage = dedupAck.data as MessageSocketPayload;
    expect(dedupMessage.id).toBe(httpMessage.id);
    expect(dedupMessage.body).toBe(httpMessage.body);
    expect(dedupMessage.clientMessageId).toBe(clientMessageId);
    expect(dedupMessage.deduplicated).toBe(true);

    const dedupEvent = await dedupEventPromise;
    expect(dedupEvent.id).toBe(httpMessage.id);
    expect(dedupEvent.body).toBe(httpMessage.body);
    expect(dedupEvent.clientMessageId).toBe(clientMessageId);
    expect(dedupEvent.deduplicated).toBe(true);

    socket.disconnect();
    trackedSockets.delete(socket);
  });
});