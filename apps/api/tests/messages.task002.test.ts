import request from "supertest";
import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";

interface AuthSession {
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
  };
}

interface ReceiptResponse {
  id: string;
  messageId: string;
  userId: string;
  status: "DELIVERED" | "READ";
  deliveredAt: string;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const app = createApp();

function uniqueToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function bearerToken(token: string) {
  return `Bearer ${token}`;
}

async function registerUser(prefix: string): Promise<AuthSession> {
  const suffix = uniqueToken();
  const username = `${prefix}${suffix}`.slice(0, 30);
  const email = `${username}@task002.test`;

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
      name: `task002-${uniqueToken()}`,
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

async function markReceipt(input: {
  token: string;
  channelId: string;
  messageId: string;
  status: "DELIVERED" | "READ";
}) {
  return request(app)
    .post(`/api/channels/${input.channelId}/messages/${input.messageId}/receipt`)
    .set("authorization", bearerToken(input.token))
    .send({
      status: input.status
    });
}

describe("TASK-002 message delivery/read receipts", () => {
  it("aplica transiciones deterministas delivered->read sin degradar e idempotentes", async () => {
    const author = await registerUser("task002author");
    const viewer = await registerUser("task002viewer");
    const channelId = await createChannel(author.token);

    await joinChannel(viewer.token, channelId);

    const createMessageResponse = await postChannelMessage({
      token: author.token,
      channelId,
      body: "mensaje para receipts"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const deliveredFirstResponse = await markReceipt({
      token: viewer.token,
      channelId,
      messageId,
      status: "DELIVERED"
    });

    expect(deliveredFirstResponse.status).toBe(200);
    const deliveredFirst = deliveredFirstResponse.body.receipt as ReceiptResponse;
    expect(deliveredFirst.status).toBe("DELIVERED");
    expect(deliveredFirst.readAt).toBeNull();
    expect(deliveredFirst.deliveredAt).toBeTruthy();

    const deliveredSecondResponse = await markReceipt({
      token: viewer.token,
      channelId,
      messageId,
      status: "DELIVERED"
    });

    expect(deliveredSecondResponse.status).toBe(200);
    const deliveredSecond = deliveredSecondResponse.body.receipt as ReceiptResponse;
    expect(deliveredSecond.status).toBe("DELIVERED");
    expect(deliveredSecond.deliveredAt).toBe(deliveredFirst.deliveredAt);
    expect(deliveredSecond.readAt).toBeNull();

    const readFirstResponse = await markReceipt({
      token: viewer.token,
      channelId,
      messageId,
      status: "READ"
    });

    expect(readFirstResponse.status).toBe(200);
    const readFirst = readFirstResponse.body.receipt as ReceiptResponse;
    expect(readFirst.status).toBe("READ");
    expect(readFirst.deliveredAt).toBe(deliveredFirst.deliveredAt);
    expect(readFirst.readAt).toBeTruthy();

    const readSecondResponse = await markReceipt({
      token: viewer.token,
      channelId,
      messageId,
      status: "READ"
    });

    expect(readSecondResponse.status).toBe(200);
    const readSecond = readSecondResponse.body.receipt as ReceiptResponse;
    expect(readSecond.status).toBe("READ");
    expect(readSecond.deliveredAt).toBe(readFirst.deliveredAt);
    expect(readSecond.readAt).toBe(readFirst.readAt);

    const downgradeResponse = await markReceipt({
      token: viewer.token,
      channelId,
      messageId,
      status: "DELIVERED"
    });

    expect(downgradeResponse.status).toBe(200);
    const downgraded = downgradeResponse.body.receipt as ReceiptResponse;
    expect(downgraded.status).toBe("READ");
    expect(downgraded.deliveredAt).toBe(readFirst.deliveredAt);
    expect(downgraded.readAt).toBe(readFirst.readAt);

    const persistedReceipt = await prisma.messageReceipt.findUnique({
      where: {
        messageId_userId: {
          messageId,
          userId: viewer.user.id
        }
      },
      select: {
        deliveredAt: true,
        readAt: true
      }
    });

    expect(persistedReceipt).not.toBeNull();
    expect(persistedReceipt?.deliveredAt).not.toBeNull();
    expect(persistedReceipt?.readAt).not.toBeNull();

    const listMessagesResponse = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=30`)
      .set("authorization", bearerToken(viewer.token));

    expect(listMessagesResponse.status).toBe(200);

    const listedMessage = (listMessagesResponse.body.messages as Array<Record<string, unknown>>).find(
      (message) => message.id === messageId
    );

    expect(listedMessage).toBeDefined();
    expect(listedMessage).toHaveProperty("viewerReceipt");

    const viewerReceipt = (listedMessage as { viewerReceipt: ReceiptResponse }).viewerReceipt;
    expect(viewerReceipt.status).toBe("READ");
    expect(viewerReceipt.readAt).toBe(readFirst.readAt);
  });

  it("permite READ-first y completa deliveredAt sin delivered previo", async () => {
    const author = await registerUser("task002readfirst-author");
    const viewer = await registerUser("task002readfirst-viewer");
    const channelId = await createChannel(author.token);

    await joinChannel(viewer.token, channelId);

    const createMessageResponse = await postChannelMessage({
      token: author.token,
      channelId,
      body: "mensaje para read-first"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const readFirstResponse = await markReceipt({
      token: viewer.token,
      channelId,
      messageId,
      status: "READ"
    });

    expect(readFirstResponse.status).toBe(200);
    const readFirst = readFirstResponse.body.receipt as ReceiptResponse;
    expect(readFirst.status).toBe("READ");
    expect(readFirst.deliveredAt).toBeTruthy();
    expect(readFirst.readAt).toBeTruthy();

    const persistedReceipt = await prisma.messageReceipt.findUnique({
      where: {
        messageId_userId: {
          messageId,
          userId: viewer.user.id
        }
      },
      select: {
        deliveredAt: true,
        readAt: true
      }
    });

    expect(persistedReceipt).not.toBeNull();
    expect(persistedReceipt?.deliveredAt).not.toBeNull();
    expect(persistedReceipt?.readAt).not.toBeNull();
  });

  it("retorna 400 cuando el payload de receipt es inválido", async () => {
    const author = await registerUser("task002badpayload-author");
    const viewer = await registerUser("task002badpayload-viewer");
    const channelId = await createChannel(author.token);

    await joinChannel(viewer.token, channelId);

    const createMessageResponse = await postChannelMessage({
      token: author.token,
      channelId,
      body: "mensaje payload inválido"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const response = await request(app)
      .post(`/api/channels/${channelId}/messages/${messageId}/receipt`)
      .set("authorization", bearerToken(viewer.token))
      .send({
        status: "SEEN"
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: "Payload inválido" });
  });

  it("retorna 400 cuando messageId no cumple formato esperado", async () => {
    const author = await registerUser("task002badid-author");
    const viewer = await registerUser("task002badid-viewer");
    const channelId = await createChannel(author.token);

    await joinChannel(viewer.token, channelId);

    const response = await request(app)
      .post(`/api/channels/${channelId}/messages/message-id-invalido/receipt`)
      .set("authorization", bearerToken(viewer.token))
      .send({
        status: "READ"
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: "Parámetros inválidos" });
  });

  it("retorna 401 cuando falta autenticación en endpoint de receipt", async () => {
    const author = await registerUser("task002noauth-author");
    const channelId = await createChannel(author.token);

    const createMessageResponse = await postChannelMessage({
      token: author.token,
      channelId,
      body: "mensaje sin auth"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const response = await request(app)
      .post(`/api/channels/${channelId}/messages/${messageId}/receipt`)
      .send({
        status: "READ"
      });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: "Token requerido" });
  });

  it("no expone viewerReceipt de otro miembro al listar mensajes", async () => {
    const author = await registerUser("task002privacy-author");
    const viewerA = await registerUser("task002privacy-viewera");
    const viewerB = await registerUser("task002privacy-viewerb");
    const channelId = await createChannel(author.token);

    await joinChannel(viewerA.token, channelId);
    await joinChannel(viewerB.token, channelId);

    const createMessageResponse = await postChannelMessage({
      token: author.token,
      channelId,
      body: "mensaje privacidad viewerReceipt"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const viewerAReceiptResponse = await markReceipt({
      token: viewerA.token,
      channelId,
      messageId,
      status: "READ"
    });

    expect(viewerAReceiptResponse.status).toBe(200);

    const viewerBListResponse = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=30`)
      .set("authorization", bearerToken(viewerB.token));

    expect(viewerBListResponse.status).toBe(200);

    const viewerBMessage = (
      viewerBListResponse.body.messages as Array<{ id: string; viewerReceipt: ReceiptResponse | null }>
    ).find((message) => message.id === messageId);

    expect(viewerBMessage).toBeDefined();
    expect(viewerBMessage?.viewerReceipt).toBeNull();

    const viewerAListResponse = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=30`)
      .set("authorization", bearerToken(viewerA.token));

    expect(viewerAListResponse.status).toBe(200);

    const viewerAMessage = (
      viewerAListResponse.body.messages as Array<{ id: string; viewerReceipt: ReceiptResponse | null }>
    ).find((message) => message.id === messageId);

    expect(viewerAMessage).toBeDefined();
    expect(viewerAMessage?.viewerReceipt).not.toBeNull();
    expect(viewerAMessage?.viewerReceipt?.userId).toBe(viewerA.user.id);
  });

  it("usa 404 indistinguible cuando el usuario no pertenece al canal en receipts", async () => {
    const author = await registerUser("task002forbid-author");
    const outsider = await registerUser("task002forbid-outsider");
    const channelId = await createChannel(author.token);

    const createMessageResponse = await postChannelMessage({
      token: author.token,
      channelId,
      body: "mensaje restringido"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const response = await markReceipt({
      token: outsider.token,
      channelId,
      messageId,
      status: "DELIVERED"
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Canal no encontrado" });
  });

  it("retorna 404 cuando el mensaje no pertenece al canal indicado", async () => {
    const session = await registerUser("task002notfound");

    const sourceChannelId = await createChannel(session.token);
    const targetChannelId = await createChannel(session.token);

    const createMessageResponse = await postChannelMessage({
      token: session.token,
      channelId: sourceChannelId,
      body: "mensaje en canal origen"
    });

    expect(createMessageResponse.status).toBe(201);
    const messageId = (createMessageResponse.body.message as { id: string }).id;

    const response = await markReceipt({
      token: session.token,
      channelId: targetChannelId,
      messageId,
      status: "READ"
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Mensaje no encontrado" });
  });
});
