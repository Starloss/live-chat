import { expect, test } from "@playwright/test";

const API_ORIGIN = "http://localhost:4000";
const ACCESS_TOKEN = "qa-access-token";

const user = {
  id: "user-qa",
  username: "qa-user",
  email: "qa@example.com"
};

const channels = [
  {
    id: "ch-general",
    name: "general",
    visibility: "PUBLIC",
    role: "MEMBER",
    createdAt: "2026-04-29T09:00:00.000Z",
    joinedAt: "2026-04-29T09:00:00.000Z"
  },
  {
    id: "ch-soporte",
    name: "soporte",
    visibility: "PUBLIC",
    role: "MEMBER",
    createdAt: "2026-04-29T09:01:00.000Z",
    joinedAt: "2026-04-29T09:01:00.000Z"
  }
] as const;

const messagesByChannel: Record<string, Array<Record<string, unknown>>> = {
  "ch-general": [
    {
      id: "m-general-1",
      channelId: "ch-general",
      conversationId: null,
      body: "Hola desde general",
      createdAt: "2026-04-29T10:00:00.000Z",
      author: {
        id: "user-alice",
        username: "alice"
      }
    }
  ],
  "ch-soporte": [
    {
      id: "m-soporte-1",
      channelId: "ch-soporte",
      conversationId: null,
      body: "Necesito ayuda con mi pedido",
      createdAt: "2026-04-29T10:01:00.000Z",
      author: {
        id: "user-bob",
        username: "soporte-bot"
      }
    }
  ]
};

const presenceByChannel: Record<string, Array<Record<string, string>>> = {
  "ch-general": [
    { userId: "user-qa", username: "qa-user", status: "online" },
    { userId: "user-alice", username: "alice", status: "online" }
  ],
  "ch-soporte": [
    { userId: "user-qa", username: "qa-user", status: "online" },
    { userId: "user-bob", username: "soporte-bot", status: "online" }
  ]
};

interface MockApiFixtures {
  apiOrigin: string;
  accessToken: string;
  userFixture: typeof user;
  channelsFixture: typeof channels;
  messagesFixture: typeof messagesByChannel;
  presenceFixture: typeof presenceByChannel;
}

test("flujo crítico: sesión no autenticada, login y navegación de conversación", async ({ page }) => {
  await page.addInitScript(
    (fixtures: MockApiFixtures) => {
      const originalFetch = window.fetch.bind(window);

      const jsonResponse = (status: number, body: unknown) => {
        return new Response(JSON.stringify(body), {
          status,
          headers: {
            "Content-Type": "application/json"
          }
        });
      };

      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (!requestUrl.startsWith(`${fixtures.apiOrigin}/api/`)) {
          return originalFetch(...args);
        }

        const method = (
          init?.method ??
          (typeof input === "string" || input instanceof URL ? "GET" : input.method ?? "GET")
        ).toUpperCase();
        const url = new URL(requestUrl);

        if (url.pathname === "/api/auth/refresh" && method === "POST") {
          return jsonResponse(401, { message: "No autenticado" });
        }

        if (url.pathname === "/api/auth/login" && method === "POST") {
          return jsonResponse(200, {
            user: fixtures.userFixture,
            accessToken: fixtures.accessToken
          });
        }

        if (url.pathname === "/api/auth/me" && method === "GET") {
          return jsonResponse(200, { user: fixtures.userFixture });
        }

        if (url.pathname === "/api/channels" && method === "GET") {
          return jsonResponse(200, { channels: fixtures.channelsFixture });
        }

        if (url.pathname === "/api/channels/discover" && method === "GET") {
          const query = (url.searchParams.get("query") ?? "").toLowerCase();
          const discovered = fixtures.channelsFixture
            .filter((channel) => channel.name.includes(query))
            .map((channel) => ({
              id: channel.id,
              name: channel.name,
              visibility: channel.visibility,
              memberCount: fixtures.presenceFixture[channel.id]?.length ?? 1,
              isOwner: false,
              membershipRole: "MEMBER",
              joinRequest: null
            }));

          return jsonResponse(200, { channels: discovered });
        }

        const channelMessagesMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
        if (channelMessagesMatch && method === "GET") {
          const channelId = channelMessagesMatch[1];
          const allMessages = fixtures.messagesFixture[channelId] ?? [];
          const limit = Number(url.searchParams.get("limit") ?? "30");
          const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 30;

          return jsonResponse(200, {
            messages: allMessages.slice(-safeLimit),
            nextCursor: null
          });
        }

        if (url.pathname === "/api/presence" && method === "GET") {
          const channelId = url.searchParams.get("channelId") ?? "";
          return jsonResponse(200, {
            users: fixtures.presenceFixture[channelId] ?? []
          });
        }

        return jsonResponse(404, { message: `Ruta mock no implementada: ${method} ${url.pathname}` });
      };
    },
    {
      apiOrigin: API_ORIGIN,
      accessToken: ACCESS_TOKEN,
      userFixture: user,
      channelsFixture: channels,
      messagesFixture: messagesByChannel,
      presenceFixture: presenceByChannel
    } satisfies MockApiFixtures
  );

  await page.goto("/");

  await expect(page.getByText("Inicia sesión")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();

  await page.getByLabel("Email").fill("qa@example.com");
  await page.getByLabel("Password").fill("super-secret");
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page.getByText("Usuario: qa-user")).toBeVisible();
  await expect(page.getByRole("heading", { name: "#general" })).toBeVisible();
  await expect(page.getByLabel("Mensajes de general")).toContainText("Hola desde general");

  await page.getByRole("button", { name: "Abrir canal soporte" }).click();

  await expect(page.getByRole("heading", { name: "#soporte" })).toBeVisible();
  await expect(page.getByLabel("Mensajes de soporte")).toContainText("Necesito ayuda con mi pedido");
});