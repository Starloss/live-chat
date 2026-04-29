import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { errorHandler, notFoundHandler } from "../src/middlewares/error.middleware";

describe("API smoke", () => {
  const app = createApp();

  it("responde health", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("devuelve 401 en /api/auth/me sin token", async () => {
    const response = await request(app).get("/api/auth/me");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: "Token requerido" });
  });

  it("valida payload en register", async () => {
    const response = await request(app).post("/api/auth/register").send({
      email: "no-valido",
      password: "123"
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: "Payload inválido" });
  });

  it("responde 404 uniforme en rutas no existentes", async () => {
    const response = await request(app).get("/api/no-existe");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Ruta no encontrada" });
  });

  it("sanitiza errores 500 y mantiene logging interno estructurado", async () => {
    const secureApp = express();
    secureApp.get("/boom", (_req, _res, next) => {
      next(new Error("detalle interno sensible"));
    });
    secureApp.use(notFoundHandler);
    secureApp.use(errorHandler);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await request(secureApp).get("/boom");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: "Error interno del servidor" });

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const loggedEntry = consoleErrorSpy.mock.calls[0]?.[0];
      expect(typeof loggedEntry).toBe("string");

      const parsedLog = JSON.parse(loggedEntry as string) as Record<string, unknown>;
      expect(parsedLog.event).toBe("http.request.error");
      expect(parsedLog.status).toBe(500);
      expect(parsedLog.message).toBe("detalle interno sensible");
      expect(parsedLog).toHaveProperty("stack");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
