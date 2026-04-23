import request from "supertest";
import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";

const app = createApp();
const REFRESH_COOKIE_NAME = "live_chat_rt";

function uniqueToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getSetCookieHeaders(response: { headers: Record<string, string | string[] | undefined> }) {
  const rawSetCookie = response.headers["set-cookie"];

  if (!rawSetCookie) {
    return [] as string[];
  }

  return Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie];
}

function getCookieHeaderFromResponse(
  response: { headers: Record<string, string | string[] | undefined> },
  cookieName: string
) {
  return getSetCookieHeaders(response).find((cookieHeader) => cookieHeader.startsWith(`${cookieName}=`));
}

function getCookieValue(cookieHeader: string, cookieName: string) {
  const prefix = `${cookieName}=`;
  const withoutPrefix = cookieHeader.startsWith(prefix) ? cookieHeader.slice(prefix.length) : "";
  const separatorIndex = withoutPrefix.indexOf(";");

  if (separatorIndex === -1) {
    return withoutPrefix;
  }

  return withoutPrefix.slice(0, separatorIndex);
}

async function registerUser(prefix: string) {
  const suffix = uniqueToken();
  const username = `${prefix}${suffix}`.slice(0, 30);
  const email = `${username}@task004.test`;

  const response = await request(app).post("/api/auth/register").send({
    username,
    email,
    password: "password123"
  });

  expect(response.status).toBe(201);
  expect(response.body).toHaveProperty("accessToken");
  expect(response.body).not.toHaveProperty("token");

  const refreshCookieHeader = getCookieHeaderFromResponse(response, REFRESH_COOKIE_NAME);
  expect(refreshCookieHeader).toBeDefined();

  return {
    user: response.body.user as { id: string; username: string; email: string },
    accessToken: response.body.accessToken as string,
    refreshCookieHeader: refreshCookieHeader as string
  };
}

describe("TASK-004 session hardening", () => {
  it("guarda refresh token hasheado en DB y emite cookie HttpOnly", async () => {
    const session = await registerUser("task004hash");

    expect(session.accessToken).toBeTypeOf("string");
    expect(session.accessToken.length).toBeGreaterThan(20);
    expect(session.refreshCookieHeader).toContain("HttpOnly");
    expect(session.refreshCookieHeader).toContain("SameSite=Lax");

    const persistedRefreshToken = await prisma.refreshToken.findFirst({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      select: {
        tokenHash: true,
        revokedAt: true
      }
    });

    const rawRefreshToken = getCookieValue(session.refreshCookieHeader, REFRESH_COOKIE_NAME);

    expect(rawRefreshToken).not.toHaveLength(0);
    expect(persistedRefreshToken).not.toBeNull();
    expect(persistedRefreshToken?.revokedAt).toBeNull();
    expect(persistedRefreshToken?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persistedRefreshToken?.tokenHash).not.toBe(rawRefreshToken);
  });

  it("consume refresh token una sola vez incluso con refresh concurrente", async () => {
    const session = await registerUser("task004race");

    const [refreshA, refreshB] = await Promise.all([
      request(app).post("/api/auth/refresh").set("cookie", session.refreshCookieHeader).send({}),
      request(app).post("/api/auth/refresh").set("cookie", session.refreshCookieHeader).send({})
    ]);

    const successfulRefreshes = [refreshA, refreshB].filter((response) => response.status === 200);
    const rejectedRefreshes = [refreshA, refreshB].filter((response) => response.status === 401);

    expect(successfulRefreshes).toHaveLength(1);
    expect(rejectedRefreshes).toHaveLength(1);
    expect(successfulRefreshes[0].body).toHaveProperty("accessToken");
    expect(successfulRefreshes[0].body).not.toHaveProperty("token");

    const activeSessions = await prisma.refreshToken.count({
      where: {
        userId: session.user.id,
        revokedAt: null
      }
    });

    expect(activeSessions).toBeLessThanOrEqual(1);
  });

  it("detecta reuse de refresh revocado y revoca sesiones activas del usuario", async () => {
    const session = await registerUser("task004reuse");

    const firstRefreshResponse = await request(app)
      .post("/api/auth/refresh")
      .set("cookie", session.refreshCookieHeader)
      .send({});

    expect(firstRefreshResponse.status).toBe(200);
    expect(firstRefreshResponse.body).toHaveProperty("accessToken");
    expect(firstRefreshResponse.body).not.toHaveProperty("token");

    const rotatedCookieHeader = getCookieHeaderFromResponse(firstRefreshResponse, REFRESH_COOKIE_NAME);
    expect(rotatedCookieHeader).toBeDefined();

    const reusedRefreshResponse = await request(app)
      .post("/api/auth/refresh")
      .set("cookie", session.refreshCookieHeader)
      .send({});

    expect(reusedRefreshResponse.status).toBe(401);
    expect(reusedRefreshResponse.body).toEqual({ message: "Sesión inválida" });

    const activeSessionsAfterReuse = await prisma.refreshToken.count({
      where: {
        userId: session.user.id,
        revokedAt: null
      }
    });

    expect(activeSessionsAfterReuse).toBe(0);

    const refreshAfterReuseResponse = await request(app)
      .post("/api/auth/refresh")
      .set("cookie", rotatedCookieHeader as string)
      .send({});

    expect(refreshAfterReuseResponse.status).toBe(401);
    expect(refreshAfterReuseResponse.body).toEqual({ message: "Sesión inválida" });
  });

  it("expone solo accessToken como campo canónico en respuestas auth", async () => {
    const suffix = uniqueToken();
    const username = `task004shape${suffix}`.slice(0, 30);
    const email = `${username}@task004.test`;
    const password = "password123";

    const registerResponse = await request(app).post("/api/auth/register").send({
      username,
      email,
      password
    });

    expect(registerResponse.status).toBe(201);
    expect(registerResponse.body).toHaveProperty("accessToken");
    expect(registerResponse.body).not.toHaveProperty("token");

    const loginResponse = await request(app).post("/api/auth/login").send({ email, password });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body).toHaveProperty("accessToken");
    expect(loginResponse.body).not.toHaveProperty("token");

    const loginRefreshCookieHeader = getCookieHeaderFromResponse(loginResponse, REFRESH_COOKIE_NAME);
    expect(loginRefreshCookieHeader).toBeDefined();

    const refreshResponse = await request(app)
      .post("/api/auth/refresh")
      .set("cookie", loginRefreshCookieHeader as string)
      .send({});

    expect(refreshResponse.status).toBe(200);
    expect(refreshResponse.body).toHaveProperty("accessToken");
    expect(refreshResponse.body).not.toHaveProperty("token");
  });

  it("invalida refresh token en logout y bloquea refresh posterior", async () => {
    const session = await registerUser("task004logout");

    const logoutResponse = await request(app)
      .post("/api/auth/logout")
      .set("cookie", session.refreshCookieHeader)
      .send({});

    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.body).toEqual({ message: "Sesión cerrada" });

    const refreshAfterLogoutResponse = await request(app)
      .post("/api/auth/refresh")
      .set("cookie", session.refreshCookieHeader)
      .send({});

    expect(refreshAfterLogoutResponse.status).toBe(401);
    expect(refreshAfterLogoutResponse.body).toEqual({ message: "Sesión inválida" });
  });
});
