import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadinessStatus } from "../src/observability/readiness";
import { createApp } from "../src/app";

const { getReadinessStatusMock } = vi.hoisted(() => ({
  getReadinessStatusMock: vi.fn<() => Promise<ReadinessStatus>>()
}));

vi.mock("../src/observability/readiness", () => ({
  getReadinessStatus: getReadinessStatusMock
}));

describe("TASK-013 readiness endpoint", () => {
  const app = createApp();

  beforeEach(() => {
    getReadinessStatusMock.mockReset();
  });

  it("responde 200 cuando todas las dependencias estan listas", async () => {
    const readiness: ReadinessStatus = {
      ok: true,
      checks: {
        database: {
          ok: true,
          status: "ready"
        },
        redis: {
          enabled: false,
          ok: true,
          status: "disabled"
        }
      }
    };

    getReadinessStatusMock.mockResolvedValue(readiness);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await request(app).get("/readyz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      status: "ready",
      checks: readiness.checks
    });
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("responde 503 y payload claro cuando alguna dependencia no esta lista", async () => {
    const readiness: ReadinessStatus = {
      ok: false,
      checks: {
        database: {
          ok: true,
          status: "ready"
        },
        redis: {
          enabled: true,
          ok: false,
          status: "not_connected",
          error: "REDIS_NOT_CONNECTED"
        }
      }
    };

    getReadinessStatusMock.mockResolvedValue(readiness);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await request(app).get("/readyz");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      ok: false,
      status: "not_ready",
      checks: readiness.checks
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const firstLogCall = errorSpy.mock.calls[0]?.[0];
    expect(typeof firstLogCall).toBe("string");
    expect(JSON.parse(firstLogCall as string)).toMatchObject({
      level: "error",
      event: "readiness.failed"
    });

    errorSpy.mockRestore();
  });

  it("responde 503 cuando el chequeo de readiness falla de forma inesperada", async () => {
    getReadinessStatusMock.mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await request(app).get("/readyz");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      status: "not_ready"
    });
    expect(response.body.checks.database.error).toBe("DATABASE_UNREACHABLE");
    expect(response.body.checks.redis.error).toBe("REDIS_UNREACHABLE");
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const firstLogCall = errorSpy.mock.calls[0]?.[0];
    expect(typeof firstLogCall).toBe("string");
    expect(JSON.parse(firstLogCall as string)).toMatchObject({
      level: "error",
      event: "readiness.failed"
    });

    errorSpy.mockRestore();
  });
});
