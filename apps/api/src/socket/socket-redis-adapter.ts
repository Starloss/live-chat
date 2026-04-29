import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import type { Server } from "socket.io";
import { env } from "../config/env";

type RedisRealtimeMode = "disabled" | "enabled" | "fallback";
type AppRedisClient = ReturnType<typeof createClient>;

export interface RedisRealtimeStatus {
  enabledByConfig: boolean;
  mode: RedisRealtimeMode;
  connected: boolean;
  lastError: string | null;
}

export interface RedisReadinessCheck {
  enabled: boolean;
  ok: boolean;
  status: "disabled" | "ready" | "not_connected" | "error";
  error?: "REDIS_NOT_CONNECTED" | "REDIS_UNREACHABLE";
}

const redisRealtimeStatus: RedisRealtimeStatus = {
  enabledByConfig: env.redisEnabled,
  mode: env.redisEnabled ? "fallback" : "disabled",
  connected: false,
  lastError: null
};

let publisherClient: AppRedisClient | null = null;
let subscriberClient: AppRedisClient | null = null;

function sanitizeCredentialsInText(value: string) {
  return value.replace(/:\/\/([^:@\s]+):([^@\s]+)@/g, "://$1:***@");
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return sanitizeCredentialsInText(error.message);
  }

  return "unknown_error";
}

function sanitizeRedisUrl(redisUrl: string) {
  try {
    const parsed = new URL(redisUrl);
    if (parsed.password) {
      parsed.password = "***";
    }

    return parsed.toString();
  } catch {
    return "invalid_redis_url";
  }
}

async function closeRedisClient(client: AppRedisClient | null) {
  if (!client) {
    return;
  }

  if (!client.isOpen) {
    return;
  }

  await client.quit();
}

function setRedisStatus(nextState: Partial<RedisRealtimeStatus>) {
  Object.assign(redisRealtimeStatus, nextState, {
    enabledByConfig: env.redisEnabled
  });
}

export function getRedisRealtimeStatus(): RedisRealtimeStatus {
  return { ...redisRealtimeStatus };
}

export async function initializeSocketRedisAdapter(io: Server) {
  if (!env.redisEnabled) {
    setRedisStatus({
      mode: "disabled",
      connected: false,
      lastError: null
    });
    return;
  }

  const redisUrl = env.redisUrl;
  const nextPublisherClient = createClient({ url: redisUrl });
  const nextSubscriberClient = nextPublisherClient.duplicate();

  try {
    await Promise.all([nextPublisherClient.connect(), nextSubscriberClient.connect()]);

    io.adapter(createAdapter(nextPublisherClient, nextSubscriberClient));

    publisherClient = nextPublisherClient;
    subscriberClient = nextSubscriberClient;

    setRedisStatus({
      mode: "enabled",
      connected: true,
      lastError: null
    });

    console.log(
      JSON.stringify({
        level: "info",
        event: "socket.redis.adapter_enabled",
        redisEnabled: true,
        redisUrl: sanitizeRedisUrl(redisUrl),
        timestamp: new Date().toISOString()
      })
    );
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    setRedisStatus({
      mode: "fallback",
      connected: false,
      lastError: errorMessage
    });

    await Promise.allSettled([
      closeRedisClient(nextPublisherClient),
      closeRedisClient(nextSubscriberClient)
    ]);

    console.error(
      JSON.stringify({
        level: "error",
        event: "socket.redis.adapter_init_failed",
        redisEnabled: true,
        redisUrl: sanitizeRedisUrl(redisUrl),
        error: errorMessage,
        fallback: "single_instance",
        timestamp: new Date().toISOString()
      })
    );
  }
}

export async function closeSocketRedisAdapter() {
  const currentPublisher = publisherClient;
  const currentSubscriber = subscriberClient;

  publisherClient = null;
  subscriberClient = null;

  await Promise.allSettled([closeRedisClient(currentPublisher), closeRedisClient(currentSubscriber)]);

  if (!env.redisEnabled) {
    setRedisStatus({
      mode: "disabled",
      connected: false,
      lastError: null
    });
    return;
  }

  setRedisStatus({
    mode: "fallback",
    connected: false
  });
}

export async function checkRedisReadiness(): Promise<RedisReadinessCheck> {
  if (!env.redisEnabled) {
    return {
      enabled: false,
      ok: true,
      status: "disabled"
    };
  }

  if (redisRealtimeStatus.mode !== "enabled" || !publisherClient || !publisherClient.isOpen) {
    return {
      enabled: true,
      ok: false,
      status: "not_connected",
      error: "REDIS_NOT_CONNECTED"
    };
  }

  try {
    const pingResult = await publisherClient.ping();

    if (pingResult !== "PONG") {
      return {
        enabled: true,
        ok: false,
        status: "error",
        error: "REDIS_UNREACHABLE"
      };
    }

    return {
      enabled: true,
      ok: true,
      status: "ready"
    };
  } catch (error) {
    setRedisStatus({
      connected: false,
      lastError: getErrorMessage(error)
    });

    return {
      enabled: true,
      ok: false,
      status: "error",
      error: "REDIS_UNREACHABLE"
    };
  }
}