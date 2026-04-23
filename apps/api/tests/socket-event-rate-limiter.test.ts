import { describe, expect, it } from "vitest";
import {
  SocketEventRateLimiter,
  type SocketEventRateLimitConfig
} from "../src/socket/socket-event-rate-limiter";

const testConfig: SocketEventRateLimitConfig = {
  "channel:join": {
    windowMs: 1_000,
    maxEvents: 2
  },
  "message:send": {
    windowMs: 1_000,
    maxEvents: 2
  },
  "message:receipt": {
    windowMs: 1_000,
    maxEvents: 2
  },
  "typing:start": {
    windowMs: 1_000,
    maxEvents: 1
  },
  "typing:stop": {
    windowMs: 1_000,
    maxEvents: 1
  }
};

function createLimiter() {
  return new SocketEventRateLimiter(testConfig, 1);
}

describe("socket-event-rate-limiter", () => {
  it("bloquea cuando se supera el limite del evento", () => {
    const limiter = createLimiter();

    expect(
      limiter.consume({
        event: "message:send",
        userId: "user-1",
        socketId: "socket-1",
        now: 1
      }).allowed
    ).toBe(true);

    expect(
      limiter.consume({
        event: "message:send",
        userId: "user-1",
        socketId: "socket-1",
        now: 2
      }).allowed
    ).toBe(true);

    const blockedAttempt = limiter.consume({
      event: "message:send",
      userId: "user-1",
      socketId: "socket-1",
      now: 3
    });

    expect(blockedAttempt.allowed).toBe(false);
    expect(blockedAttempt.retryAfterMs).toBeGreaterThan(0);
  });

  it("reinicia la cuota cuando expira la ventana", () => {
    const limiter = createLimiter();

    limiter.consume({
      event: "channel:join",
      userId: "user-1",
      socketId: "socket-1",
      now: 100
    });

    limiter.consume({
      event: "channel:join",
      userId: "user-1",
      socketId: "socket-1",
      now: 200
    });

    expect(
      limiter.consume({
        event: "channel:join",
        userId: "user-1",
        socketId: "socket-1",
        now: 300
      }).allowed
    ).toBe(false);

    const attemptAfterReset = limiter.consume({
      event: "channel:join",
      userId: "user-1",
      socketId: "socket-1",
      now: 1_101
    });

    expect(attemptAfterReset.allowed).toBe(true);
    expect(attemptAfterReset.retryAfterMs).toBe(0);
  });

  it("mantiene cuotas independientes por evento", () => {
    const limiter = createLimiter();

    limiter.consume({
      event: "channel:join",
      userId: "user-1",
      socketId: "socket-1",
      now: 10
    });

    limiter.consume({
      event: "channel:join",
      userId: "user-1",
      socketId: "socket-1",
      now: 11
    });

    const blockedJoin = limiter.consume({
      event: "channel:join",
      userId: "user-1",
      socketId: "socket-1",
      now: 12
    });

    const messageStillAllowed = limiter.consume({
      event: "message:send",
      userId: "user-1",
      socketId: "socket-1",
      now: 13
    });

    const receiptStillAllowed = limiter.consume({
      event: "message:receipt",
      userId: "user-1",
      socketId: "socket-1",
      now: 14
    });

    expect(blockedJoin.allowed).toBe(false);
    expect(messageStillAllowed.allowed).toBe(true);
    expect(receiptStillAllowed.allowed).toBe(true);
  });

  it("prioriza userId sobre IP y socket cuando existe autenticacion", () => {
    const limiter = createLimiter();

    expect(
      limiter.consume({
        event: "typing:start",
        userId: "user-42",
        ip: "10.0.0.1",
        socketId: "socket-a",
        now: 1
      }).allowed
    ).toBe(true);

    expect(
      limiter.consume({
        event: "typing:start",
        userId: "user-42",
        ip: "10.0.0.2",
        socketId: "socket-b",
        now: 2
      }).allowed
    ).toBe(false);
  });

  it("usa fallback por IP y luego por socket cuando no hay userId", () => {
    const limiter = createLimiter();

    expect(
      limiter.consume({
        event: "typing:stop",
        ip: "192.168.1.10",
        socketId: "socket-a",
        now: 1
      }).allowed
    ).toBe(true);

    expect(
      limiter.consume({
        event: "typing:stop",
        ip: "192.168.1.10",
        socketId: "socket-b",
        now: 2
      }).allowed
    ).toBe(false);

    expect(
      limiter.consume({
        event: "typing:stop",
        socketId: "socket-z",
        now: 3
      }).allowed
    ).toBe(true);

    expect(
      limiter.consume({
        event: "typing:stop",
        socketId: "socket-z",
        now: 4
      }).allowed
    ).toBe(false);
  });
});