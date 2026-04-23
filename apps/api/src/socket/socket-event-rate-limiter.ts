export type RateLimitedSocketEvent =
  | "channel:join"
  | "message:send"
  | "message:receipt"
  | "typing:start"
  | "typing:stop";

export interface SocketEventRateLimitRule {
  windowMs: number;
  maxEvents: number;
}

export type SocketEventRateLimitConfig = Record<RateLimitedSocketEvent, SocketEventRateLimitRule>;

export interface ConsumeRateLimitInput {
  event: RateLimitedSocketEvent;
  userId?: string | null;
  ip?: string | null;
  socketId?: string | null;
  now?: number;
}

export interface ConsumeRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

function normalizeIdentity(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveActorKey(input: ConsumeRateLimitInput) {
  const userId = normalizeIdentity(input.userId);
  if (userId) {
    return `user:${userId}`;
  }

  const ip = normalizeIdentity(input.ip);
  if (ip) {
    return `ip:${ip}`;
  }

  const socketId = normalizeIdentity(input.socketId);
  if (socketId) {
    return `socket:${socketId}`;
  }

  return "anonymous";
}

export class SocketEventRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private lastCleanupAt = 0;

  constructor(
    private readonly config: SocketEventRateLimitConfig,
    private readonly cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS
  ) {}

  consume(input: ConsumeRateLimitInput): ConsumeRateLimitResult {
    const rule = this.config[input.event];
    const now = input.now ?? Date.now();

    this.maybeCleanup(now);

    const actorKey = resolveActorKey(input);
    const bucketKey = `${input.event}:${actorKey}`;
    const existing = this.buckets.get(bucketKey);

    if (!existing || now >= existing.resetAt) {
      this.buckets.set(bucketKey, {
        count: 1,
        resetAt: now + rule.windowMs
      });

      return {
        allowed: true,
        remaining: Math.max(0, rule.maxEvents - 1),
        retryAfterMs: 0
      };
    }

    if (existing.count >= rule.maxEvents) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, existing.resetAt - now)
      };
    }

    existing.count += 1;
    this.buckets.set(bucketKey, existing);

    return {
      allowed: true,
      remaining: Math.max(0, rule.maxEvents - existing.count),
      retryAfterMs: 0
    };
  }

  private maybeCleanup(now: number) {
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) {
      return;
    }

    for (const [bucketKey, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(bucketKey);
      }
    }

    this.lastCleanupAt = now;
  }
}