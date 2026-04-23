import { createServer } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Server } from "socket.io";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { createApp } from "../src/app";
import { registerChatSocket } from "../src/socket/chat.socket";
import * as messageReceipts from "../src/modules/messages/message-receipts";

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

interface MessageReceiptSocketState {
  id: string;
  messageId: string;
  userId: string;
  status: "DELIVERED" | "READ";
  deliveredAt: string;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MessageReceiptSocketPayload {
  channelId: string;
  messageId: string;
  userId: string;
  receipt: MessageReceiptSocketState;
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
  const suffix = uniqueToken().slice(-8);
  const safePrefix = prefix.slice(0, Math.max(0, 30 - suffix.length - 1));
  const username = `${safePrefix}-${suffix}`;
  const email = `${username}@task002-socket.test`;

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
      name: `task002-socket-${uniqueToken()}`,
      visibility: "PUBLIC"
    });

  expect(response.status).toBe(201);

  return response.body.channel.id as string;
}

async function joinChannel(token: string, channelId: string) {
  const response = await request(app)
    .post(`/api/channels/${channelId}/join`)
    .set("authorization", bearerToken(token));

  expect(response.status).toBe(200);
  expect(response.body.result).toBe("joined");
}

async function postChannelMessage(input: { token: string; channelId: string; body: string }) {
  return request(app)
    .post(`/api/channels/${input.channelId}/messages`)
    .set("authorization", bearerToken(input.token))
    .send({
      body: input.body
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

describe("TASK-002 socket delivery/read receipts", () => {
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

  it("emite ack y broadcast para delivered/read con transiciones monotónicas", async () => {
    const author = await registerUser("task002-socket-author");
    const viewer = await registerUser("task002-socket-viewer");
    const channelId = await createChannel(author.token);

    await joinChannel(viewer.token, channelId);

    const createMessageResponse = await postChannelMessage({
      token: author.token,
      channelId,
      body: "mensaje socket receipts"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const authorSocket = await connectChatSocket(author.token);
    const viewerSocket = await connectChatSocket(viewer.token);

    const authorJoinAck = await emitWithAck<{ channelId: string }>(authorSocket, "channel:join", {
      channelId
    });
    expect(authorJoinAck.ok).toBe(true);

    const viewerJoinAck = await emitWithAck<{ channelId: string }>(viewerSocket, "channel:join", {
      channelId
    });
    expect(viewerJoinAck.ok).toBe(true);

    const deliveredBroadcastPromise = onceSocketEvent<MessageReceiptSocketPayload>(
      authorSocket,
      "message:receipt:update"
    );

    const deliveredAck = await emitWithAck<MessageReceiptSocketPayload>(viewerSocket, "message:receipt", {
      channelId,
      messageId,
      status: "DELIVERED"
    });

    expect(deliveredAck.ok).toBe(true);
    const deliveredState = deliveredAck.data as MessageReceiptSocketPayload;
    expect(deliveredState.channelId).toBe(channelId);
    expect(deliveredState.messageId).toBe(messageId);
    expect(deliveredState.userId).toBe(viewer.user.id);
    expect(deliveredState.receipt.status).toBe("DELIVERED");
    expect(deliveredState.receipt.readAt).toBeNull();

    const deliveredBroadcast = await deliveredBroadcastPromise;
    expect(deliveredBroadcast.channelId).toBe(channelId);
    expect(deliveredBroadcast.messageId).toBe(messageId);
    expect(deliveredBroadcast.userId).toBe(viewer.user.id);
    expect(deliveredBroadcast.receipt.status).toBe("DELIVERED");

    const readBroadcastPromise = onceSocketEvent<MessageReceiptSocketPayload>(
      authorSocket,
      "message:receipt:update"
    );

    const readAck = await emitWithAck<MessageReceiptSocketPayload>(viewerSocket, "message:receipt", {
      channelId,
      messageId,
      status: "READ"
    });

    expect(readAck.ok).toBe(true);
    const readState = readAck.data as MessageReceiptSocketPayload;
    expect(readState.receipt.status).toBe("READ");
    expect(readState.receipt.deliveredAt).toBe(deliveredState.receipt.deliveredAt);
    expect(readState.receipt.readAt).toBeTruthy();

    const readBroadcast = await readBroadcastPromise;
    expect(readBroadcast.receipt.status).toBe("READ");
    expect(readBroadcast.receipt.readAt).toBe(readState.receipt.readAt);

    const downgradeAck = await emitWithAck<MessageReceiptSocketPayload>(viewerSocket, "message:receipt", {
      channelId,
      messageId,
      status: "DELIVERED"
    });

    expect(downgradeAck.ok).toBe(true);
    const downgraded = downgradeAck.data as MessageReceiptSocketPayload;
    expect(downgraded.receipt.status).toBe("READ");
    expect(downgraded.receipt.readAt).toBe(readState.receipt.readAt);

    authorSocket.disconnect();
    viewerSocket.disconnect();
    trackedSockets.delete(authorSocket);
    trackedSockets.delete(viewerSocket);
  });

  it("rechaza con FORBIDDEN si el usuario no es miembro del canal", async () => {
    const owner = await registerUser("task002-socket-owner");
    const outsider = await registerUser("task002-socket-outsider");
    const channelId = await createChannel(owner.token);

    const createMessageResponse = await postChannelMessage({
      token: owner.token,
      channelId,
      body: "mensaje privado"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const outsiderSocket = await connectChatSocket(outsider.token);

    const ack = await emitWithAck(outsiderSocket, "message:receipt", {
      channelId,
      messageId,
      status: "DELIVERED"
    });

    expect(ack.ok).toBe(false);
    expect(ack.code).toBe("FORBIDDEN");
    expect(ack.message).toBe("No tienes acceso a este canal");

    outsiderSocket.disconnect();
    trackedSockets.delete(outsiderSocket);
  });

  it("retorna NOT_FOUND cuando el mensaje no pertenece al canal del payload", async () => {
    const member = await registerUser("task002-socket-notfound");
    const sourceChannelId = await createChannel(member.token);
    const targetChannelId = await createChannel(member.token);

    const createMessageResponse = await postChannelMessage({
      token: member.token,
      channelId: sourceChannelId,
      body: "mensaje origen"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const socket = await connectChatSocket(member.token);

    const joinAck = await emitWithAck<{ channelId: string }>(socket, "channel:join", {
      channelId: targetChannelId
    });
    expect(joinAck.ok).toBe(true);

    const ack = await emitWithAck(socket, "message:receipt", {
      channelId: targetChannelId,
      messageId,
      status: "READ"
    });

    expect(ack.ok).toBe(false);
    expect(ack.code).toBe("NOT_FOUND");
    expect(ack.message).toBe("Mensaje no encontrado");

    socket.disconnect();
    trackedSockets.delete(socket);
  });

  it("retorna BAD_PAYLOAD cuando el payload de message:receipt es inválido", async () => {
    const member = await registerUser("task002-socket-badpayload");
    const socket = await connectChatSocket(member.token);

    const ack = await emitWithAck(socket, "message:receipt", {});

    expect(ack.ok).toBe(false);
    expect(ack.code).toBe("BAD_PAYLOAD");
    expect(ack.message).toBe("Payload inválido");

    socket.disconnect();
    trackedSockets.delete(socket);
  });

  it("retorna RATE_LIMITED en message:receipt al superar la cuota", async () => {
    const member = await registerUser("task002-socket-ratelimit");
    const socket = await connectChatSocket(member.token);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ack = await emitWithAck(socket, "message:receipt", {});
      expect(ack.ok).toBe(false);
      expect(ack.code).toBe("BAD_PAYLOAD");
    }

    const limitedAck = await emitWithAck(socket, "message:receipt", {});

    expect(limitedAck.ok).toBe(false);
    expect(limitedAck.code).toBe("RATE_LIMITED");
    expect(limitedAck.message).toBe("Demasiadas solicitudes, intenta de nuevo en unos segundos");

    socket.disconnect();
    trackedSockets.delete(socket);
  });

  it("retorna INTERNAL_ERROR y no filtra detalles internos en message:receipt", async () => {
    const author = await registerUser("task002-socket-internal-author");
    const viewer = await registerUser("task002-socket-internal-viewer");
    const channelId = await createChannel(author.token);

    await joinChannel(viewer.token, channelId);

    const createMessageResponse = await postChannelMessage({
      token: author.token,
      channelId,
      body: "mensaje para internal error"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const socket = await connectChatSocket(viewer.token);
    const joinAck = await emitWithAck<{ channelId: string }>(socket, "channel:join", { channelId });
    expect(joinAck.ok).toBe(true);

    const transitionSpy = vi
      .spyOn(messageReceipts, "applyMessageReceiptTransition")
      .mockRejectedValueOnce(new Error("forced-internal-error"));

    try {
      const ack = await emitWithAck(socket, "message:receipt", {
        channelId,
        messageId,
        status: "READ"
      });

      expect(ack.ok).toBe(false);
      expect(ack.code).toBe("INTERNAL_ERROR");
      expect(ack.message).toBe("Ocurrió un error interno");
      expect(ack.message).not.toContain("forced-internal-error");
    } finally {
      transitionSpy.mockRestore();
      socket.disconnect();
      trackedSockets.delete(socket);
    }
  });
});
