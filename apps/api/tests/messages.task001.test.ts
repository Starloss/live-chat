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
  const email = `${username}@task001.test`;

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
      name: `task001-${uniqueToken()}`,
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

describe("TASK-001 message idempotency", () => {
  it("reintentos con mismo clientMessageId devuelven el mismo mensaje persistido", async () => {
    const session = await registerUser("task001same");
    const channelId = await createChannel(session.token);
    const clientMessageId = `cmid-${uniqueToken()}`;

    const firstResponse = await postChannelMessage({
      token: session.token,
      channelId,
      body: "mensaje original",
      clientMessageId
    });

    const secondResponse = await postChannelMessage({
      token: session.token,
      channelId,
      body: "mensaje reintentado",
      clientMessageId
    });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(firstResponse.body.clientMessageId).toBe(clientMessageId);
    expect(secondResponse.body.clientMessageId).toBe(clientMessageId);
    expect(firstResponse.body.deduplicated).toBe(false);
    expect(secondResponse.body.deduplicated).toBe(true);

    const firstMessage = firstResponse.body.message as { id: string; body: string };
    const secondMessage = secondResponse.body.message as { id: string; body: string };

    expect(secondMessage.id).toBe(firstMessage.id);
    expect(secondMessage.body).toBe(firstMessage.body);

    const persistedCount = await prisma.message.count({
      where: {
        channelId,
        authorId: session.user.id,
        clientMessageId
      }
    });

    expect(persistedCount).toBe(1);
  });

  it("envios con distinto clientMessageId crean mensajes distintos", async () => {
    const session = await registerUser("task001diff");
    const channelId = await createChannel(session.token);
    const firstClientMessageId = `cmid-a-${uniqueToken()}`;
    const secondClientMessageId = `cmid-b-${uniqueToken()}`;

    const firstResponse = await postChannelMessage({
      token: session.token,
      channelId,
      body: "mensaje A",
      clientMessageId: firstClientMessageId
    });

    const secondResponse = await postChannelMessage({
      token: session.token,
      channelId,
      body: "mensaje B",
      clientMessageId: secondClientMessageId
    });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(firstResponse.body.clientMessageId).toBe(firstClientMessageId);
    expect(secondResponse.body.clientMessageId).toBe(secondClientMessageId);
    expect(firstResponse.body.deduplicated).toBe(false);
    expect(secondResponse.body.deduplicated).toBe(false);

    const firstMessage = firstResponse.body.message as { id: string };
    const secondMessage = secondResponse.body.message as { id: string };

    expect(secondMessage.id).not.toBe(firstMessage.id);

    const persistedCount = await prisma.message.count({
      where: {
        channelId,
        authorId: session.user.id,
        clientMessageId: {
          in: [firstClientMessageId, secondClientMessageId]
        }
      }
    });

    expect(persistedCount).toBe(2);
  });

  it("sin clientMessageId conserva comportamiento legacy y no deduplica", async () => {
    const session = await registerUser("task001legacy");
    const channelId = await createChannel(session.token);

    const firstResponse = await postChannelMessage({
      token: session.token,
      channelId,
      body: "legacy 1"
    });

    const secondResponse = await postChannelMessage({
      token: session.token,
      channelId,
      body: "legacy 2"
    });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(firstResponse.body.clientMessageId).toBeNull();
    expect(secondResponse.body.clientMessageId).toBeNull();
    expect(firstResponse.body.deduplicated).toBe(false);
    expect(secondResponse.body.deduplicated).toBe(false);

    const firstMessage = firstResponse.body.message as { id: string };
    const secondMessage = secondResponse.body.message as { id: string };

    expect(secondMessage.id).not.toBe(firstMessage.id);

    const persistedCount = await prisma.message.count({
      where: {
        channelId,
        authorId: session.user.id,
        clientMessageId: null
      }
    });

    expect(persistedCount).toBe(2);
  });
});
