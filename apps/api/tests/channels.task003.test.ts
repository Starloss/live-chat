import request from "supertest";
import { describe, expect, it } from "vitest";
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
  const email = `${username}@task003.test`;

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

async function createChannel(token: string, visibility: "PUBLIC" | "PRIVATE") {
  const channelName = `task003-${uniqueToken()}`;

  const response = await request(app)
    .post("/api/channels")
    .set("authorization", bearerToken(token))
    .send({
      name: channelName,
      visibility
    });

  expect(response.status).toBe(201);

  return {
    id: response.body.channel.id as string,
    name: channelName
  };
}

describe("TASK-003 private channels and PII", () => {
  it("responde invitacion con 202 generico sin exponer datos del usuario objetivo", async () => {
    const owner = await registerUser("owner");
    const invitee = await registerUser("invitee");

    const privateChannel = await createChannel(owner.token, "PRIVATE");

    const knownUserInviteResponse = await request(app)
      .post(`/api/channels/${privateChannel.id}/invitations`)
      .set("authorization", bearerToken(owner.token))
      .send({
        username: invitee.user.username
      });

    expect(knownUserInviteResponse.status).toBe(202);
    expect(knownUserInviteResponse.body).toEqual({
      message: "Si el usuario existe y es elegible, la invitación será procesada"
    });

    const unknownUserInviteResponse = await request(app)
      .post(`/api/channels/${privateChannel.id}/invitations`)
      .set("authorization", bearerToken(owner.token))
      .send({
        username: `ghost-${uniqueToken()}`
      });

    expect(unknownUserInviteResponse.status).toBe(202);
    expect(unknownUserInviteResponse.body).toEqual(knownUserInviteResponse.body);
    expect(knownUserInviteResponse.body).not.toHaveProperty("invitation");
    expect(unknownUserInviteResponse.body).not.toHaveProperty("invitation");
  });

  it("discover oculta PRIVATE para usuarios no miembros ni invitados", async () => {
    const owner = await registerUser("owner");
    const outsider = await registerUser("outsider");

    const privateChannel = await createChannel(owner.token, "PRIVATE");
    const publicChannel = await createChannel(owner.token, "PUBLIC");

    const discoverResponse = await request(app)
      .get("/api/channels/discover")
      .set("authorization", bearerToken(outsider.token));

    expect(discoverResponse.status).toBe(200);

    const discoveredChannelIds = (discoverResponse.body.channels as Array<{ id: string }>).map(
      (channel) => channel.id
    );

    expect(discoveredChannelIds).toContain(publicChannel.id);
    expect(discoveredChannelIds).not.toContain(privateChannel.id);
  });

  it("permite invitacion del owner y aceptacion por el invitado", async () => {
    const owner = await registerUser("owner");
    const invitee = await registerUser("invitee");

    const privateChannel = await createChannel(owner.token, "PRIVATE");

    const inviteResponse = await request(app)
      .post(`/api/channels/${privateChannel.id}/invitations`)
      .set("authorization", bearerToken(owner.token))
      .send({
        username: invitee.user.username
      });

    expect(inviteResponse.status).toBe(202);
    expect(inviteResponse.body).toEqual({
      message: "Si el usuario existe y es elegible, la invitación será procesada"
    });
    expect(inviteResponse.body).not.toHaveProperty("invitation");

    const discoverResponse = await request(app)
      .get("/api/channels/discover")
      .set("authorization", bearerToken(invitee.token));

    expect(discoverResponse.status).toBe(200);

    const discoveredChannelIds = (discoverResponse.body.channels as Array<{ id: string }>).map(
      (channel) => channel.id
    );

    expect(discoveredChannelIds).toContain(privateChannel.id);

    const acceptResponse = await request(app)
      .post(`/api/channels/${privateChannel.id}/invitations/accept`)
      .set("authorization", bearerToken(invitee.token));

    expect(acceptResponse.status).toBe(200);
    expect(acceptResponse.body.result).toBe("joined");
    expect(acceptResponse.body.membership.channelId).toBe(privateChannel.id);

    const channelsResponse = await request(app)
      .get("/api/channels")
      .set("authorization", bearerToken(invitee.token));

    expect(channelsResponse.status).toBe(200);

    const memberChannelIds = (channelsResponse.body.channels as Array<{ id: string }>).map(
      (channel) => channel.id
    );

    expect(memberChannelIds).toContain(privateChannel.id);
  });

  it("join y accept en PRIVATE sin invitacion son indistinguibles de canal inexistente", async () => {
    const owner = await registerUser("owner");
    const outsider = await registerUser("outsider");

    const privateChannel = await createChannel(owner.token, "PRIVATE");
    const missingChannelId = `missing-${uniqueToken()}`;

    const joinPrivateResponse = await request(app)
      .post(`/api/channels/${privateChannel.id}/join`)
      .set("authorization", bearerToken(outsider.token));

    const joinMissingResponse = await request(app)
      .post(`/api/channels/${missingChannelId}/join`)
      .set("authorization", bearerToken(outsider.token));

    expect(joinPrivateResponse.status).toBe(404);
    expect(joinMissingResponse.status).toBe(joinPrivateResponse.status);
    expect(joinPrivateResponse.body).toEqual({ message: "Canal no encontrado" });
    expect(joinMissingResponse.body).toEqual(joinPrivateResponse.body);

    const acceptPrivateResponse = await request(app)
      .post(`/api/channels/${privateChannel.id}/invitations/accept`)
      .set("authorization", bearerToken(outsider.token));

    const acceptMissingResponse = await request(app)
      .post(`/api/channels/${missingChannelId}/invitations/accept`)
      .set("authorization", bearerToken(outsider.token));

    expect(acceptPrivateResponse.status).toBe(404);
    expect(acceptMissingResponse.status).toBe(acceptPrivateResponse.status);
    expect(acceptPrivateResponse.body).toEqual({ message: "Canal no encontrado" });
    expect(acceptMissingResponse.body).toEqual(acceptPrivateResponse.body);
  });

  it("requests del owner no exponen email del usuario invitado", async () => {
    const owner = await registerUser("owner");
    const invitee = await registerUser("invitee");

    const privateChannel = await createChannel(owner.token, "PRIVATE");

    const inviteResponse = await request(app)
      .post(`/api/channels/${privateChannel.id}/invitations`)
      .set("authorization", bearerToken(owner.token))
      .send({
        username: invitee.user.username
      });

    expect(inviteResponse.status).toBe(202);

    const requestsResponse = await request(app)
      .get(`/api/channels/${privateChannel.id}/requests`)
      .set("authorization", bearerToken(owner.token));

    expect(requestsResponse.status).toBe(200);
    expect((requestsResponse.body.requests as unknown[]).length).toBeGreaterThanOrEqual(1);

    for (const requestItem of requestsResponse.body.requests as Array<Record<string, unknown>>) {
      expect(requestItem).toHaveProperty("id");
      expect(requestItem).toHaveProperty("status");
      expect(requestItem).toHaveProperty("createdAt");
      expect(requestItem).toHaveProperty("user");

      const requestUser = requestItem.user as Record<string, unknown>;

      expect(requestUser).toHaveProperty("id");
      expect(requestUser).toHaveProperty("username");
      expect(requestUser).not.toHaveProperty("email");
    }
  });

  it("no expone email en DTO de miembros", async () => {
    const owner = await registerUser("owner");
    const member = await registerUser("member");

    const publicChannel = await createChannel(owner.token, "PUBLIC");

    const joinResponse = await request(app)
      .post(`/api/channels/${publicChannel.id}/join`)
      .set("authorization", bearerToken(member.token));

    expect(joinResponse.status).toBe(200);
    expect(joinResponse.body.result).toBe("joined");

    const membersResponse = await request(app)
      .get(`/api/channels/${publicChannel.id}/members`)
      .set("authorization", bearerToken(member.token));

    expect(membersResponse.status).toBe(200);
    expect((membersResponse.body.members as unknown[]).length).toBeGreaterThanOrEqual(2);

    for (const listedMember of membersResponse.body.members as Array<Record<string, unknown>>) {
      expect(listedMember).toHaveProperty("id");
      expect(listedMember).toHaveProperty("username");
      expect(listedMember).toHaveProperty("role");
      expect(listedMember).toHaveProperty("joinedAt");
      expect(listedMember).not.toHaveProperty("email");
    }
  });
});
