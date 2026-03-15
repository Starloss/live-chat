import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

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
});
