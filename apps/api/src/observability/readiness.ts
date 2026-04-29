import { prisma } from "../lib/prisma";
import { checkRedisReadiness, type RedisReadinessCheck } from "../socket/socket-redis-adapter";

interface DatabaseReadinessCheck {
  ok: boolean;
  status: "ready" | "error";
  error?: "DATABASE_UNREACHABLE";
}

export interface ReadinessStatus {
  ok: boolean;
  checks: {
    database: DatabaseReadinessCheck;
    redis: RedisReadinessCheck;
  };
}

async function checkDatabaseReadiness(): Promise<DatabaseReadinessCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      ok: true,
      status: "ready"
    };
  } catch {
    return {
      ok: false,
      status: "error",
      error: "DATABASE_UNREACHABLE"
    };
  }
}

export async function getReadinessStatus(): Promise<ReadinessStatus> {
  const [database, redis] = await Promise.all([checkDatabaseReadiness(), checkRedisReadiness()]);

  return {
    ok: database.ok && redis.ok,
    checks: {
      database,
      redis
    }
  };
}