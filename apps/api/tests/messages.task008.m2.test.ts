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
  const email = `${username}@task008-m2.test`;

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
      name: `task008-m2-${uniqueToken()}`,
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

describe("TASK-008 M2 conversation-first dual-write/read", () => {
  it("create/list por conversationId funciona y mantiene coherencia channelId/conversationId", async () => {
    const author = await registerUser("task008conv-author");
    const viewer = await registerUser("task008conv-viewer");
    const channelId = await createChannel(author.token);

    await joinChannel(viewer.token, channelId);

    const conversationId = await getWrapperConversationId(channelId);

    const createResponse = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("authorization", bearerToken(author.token))
      .send({
        body: "mensaje via conversation route"
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.deduplicated).toBe(false);
    expect(createResponse.body.clientMessageId).toBeNull();
    expect(createResponse.body.message).toMatchObject({
      channelId,
      conversationId,
      authorId: author.user.id,
      body: "mensaje via conversation route"
    });

    const createdMessageId = (createResponse.body.message as { id: string }).id;

    const listByConversationResponse = await request(app)
      .get(`/api/conversations/${conversationId}/messages?limit=30`)
      .set("authorization", bearerToken(viewer.token));

    expect(listByConversationResponse.status).toBe(200);

    const listedByConversation = (
      listByConversationResponse.body.messages as Array<Record<string, unknown>>
    ).find((message) => message.id === createdMessageId);

    expect(listedByConversation).toBeDefined();
    expect(listedByConversation).toMatchObject({
      channelId,
      conversationId,
      authorId: author.user.id,
      body: "mensaje via conversation route"
    });

    const listByChannelWithConversationQueryResponse = await request(app)
      .get(`/api/channels/${channelId}/messages?conversationId=${conversationId}&limit=30`)
      .set("authorization", bearerToken(viewer.token));

    expect(listByChannelWithConversationQueryResponse.status).toBe(200);

    const listedByChannelConversationAware = (
      listByChannelWithConversationQueryResponse.body.messages as Array<Record<string, unknown>>
    ).find((message) => message.id === createdMessageId);

    expect(listedByChannelConversationAware).toBeDefined();
    expect(listedByChannelConversationAware).toMatchObject({
      channelId,
      conversationId
    });
  });

  it("fallback legacy con channelId sigue resolviendo wrapper conversation para dual-write", async () => {
    const author = await registerUser("task008fallback-author");
    const channelId = await createChannel(author.token);
    const wrapperConversationId = await getWrapperConversationId(channelId);

    const createResponse = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set("authorization", bearerToken(author.token))
      .send({
        body: "mensaje legacy channel-only"
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.message).toMatchObject({
      channelId,
      conversationId: wrapperConversationId,
      body: "mensaje legacy channel-only"
    });

    const persistedMessage = await prisma.message.findUnique({
      where: {
        id: (createResponse.body.message as { id: string }).id
      },
      select: {
        channelId: true,
        conversationId: true
      }
    });

    expect(persistedMessage).toMatchObject({
      channelId,
      conversationId: wrapperConversationId
    });

    const listResponse = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=30`)
      .set("authorization", bearerToken(author.token));

    expect(listResponse.status).toBe(200);
    expect(Array.isArray(listResponse.body.messages)).toBe(true);
    expect(listResponse.body.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("cliente viejo (sin conversationId) mantiene contrato de create/list", async () => {
    const session = await registerUser("task008legacy-client");
    const channelId = await createChannel(session.token);

    const createResponse = await request(app)
      .post(`/api/channels/${channelId}/messages`)
      .set("authorization", bearerToken(session.token))
      .send({
        body: "mensaje cliente viejo"
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.clientMessageId).toBeNull();
    expect(createResponse.body.deduplicated).toBe(false);
    expect(createResponse.body.message).toMatchObject({
      channelId,
      authorId: session.user.id,
      body: "mensaje cliente viejo"
    });

    const listResponse = await request(app)
      .get(`/api/channels/${channelId}/messages?limit=30`)
      .set("authorization", bearerToken(session.token));

    expect(listResponse.status).toBe(200);

    const listedMessage = (listResponse.body.messages as Array<Record<string, unknown>>).find(
      (message) => message.id === (createResponse.body.message as { id: string }).id
    );

    expect(listedMessage).toBeDefined();
    expect(listedMessage).toMatchObject({
      channelId,
      authorId: session.user.id,
      body: "mensaje cliente viejo"
    });
    expect(listedMessage).toHaveProperty("viewerReceipt");
  });
});
