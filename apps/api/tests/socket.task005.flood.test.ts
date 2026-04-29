import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Server } from "socket.io";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { signAccessToken } from "../src/modules/auth/auth.utils";
import { registerChatSocket } from "../src/socket/chat.socket";

interface SocketAckResponse<TData = unknown> {
  ok: boolean;
  message?: string;
  code?: string;
  data?: TData;
}

const app = createApp();
const trackedSockets = new Set<Socket>();

let socketHttpServer: ReturnType<typeof createServer> | undefined;
let ioServer: Server | undefined;
let socketServerBaseUrl = "";

function uniqueToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function createSocketToken() {
  const suffix = uniqueToken().slice(-8);

  return signAccessToken({
    id: `task005-user-${suffix}`,
    username: `task005-${suffix}`,
    email: `task005-${suffix}@socket.test`
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

describe("TASK-005 socket anti-abuse flood validation", () => {
  beforeAll(async () => {
    vi.spyOn(prisma.userPresence, "upsert").mockResolvedValue({} as never);
    vi.spyOn(prisma.channelMember, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.typingState, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.typingState, "updateMany").mockResolvedValue({ count: 0 });

    socketHttpServer = createServer(app);
    ioServer = new Server(socketHttpServer, {
      cors: {
        origin: "http://localhost:5173",
        methods: ["GET", "POST"]
      }
    });

    registerChatSocket(ioServer);

    await new Promise<void>((resolve, reject) => {
      socketHttpServer?.once("error", reject);
      socketHttpServer?.listen(0, "127.0.0.1", () => {
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

  it("responde RATE_LIMITED bajo burst/flood concurrente de message:receipt y mantiene estabilidad", async () => {
    const socket = await connectChatSocket(createSocketToken());

    const burstSize = 60;
    const burstAcks = await Promise.all(
      Array.from({ length: burstSize }, (_value, index) =>
        emitWithAck(socket, "message:receipt", {
          sequence: index
        })
      )
    );

    const rateLimitedCount = burstAcks.filter((ack) => ack.code === "RATE_LIMITED").length;
    const badPayloadCount = burstAcks.filter((ack) => ack.code === "BAD_PAYLOAD").length;
    const invalidAckCount = burstAcks.filter(
      (ack) => ack.ok || (ack.code !== "BAD_PAYLOAD" && ack.code !== "RATE_LIMITED")
    ).length;

    expect(rateLimitedCount).toBeGreaterThan(0);
    expect(badPayloadCount).toBeGreaterThan(0);
    expect(invalidAckCount).toBe(0);

    const followUpAcks = await Promise.all(
      Array.from({ length: 10 }, () => emitWithAck(socket, "message:receipt", {}))
    );

    for (const ack of followUpAcks) {
      expect(ack.ok).toBe(false);
      expect(["BAD_PAYLOAD", "RATE_LIMITED"]).toContain(ack.code);
    }

    expect(socket.connected).toBe(true);

    socket.disconnect();
    trackedSockets.delete(socket);
  });
});