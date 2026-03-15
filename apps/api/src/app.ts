import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware";
import { createRateLimitMiddleware } from "./middlewares/rate-limit.middleware";
import { authRouter } from "./modules/auth/auth.routes";
import { channelsRouter } from "./modules/channels/channels.routes";
import { presenceRouter } from "./modules/presence/presence.routes";

const apiRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  maxRequests: 180,
  message: "Demasiadas solicitudes, intenta de nuevo en un minuto"
});

const authRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  maxRequests: 30,
  message: "Demasiados intentos de autenticación, intenta más tarde"
});

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.webOrigin }));
  app.use(express.json());

  app.use("/api", apiRateLimit);
  app.use("/api/auth", authRateLimit);

  app.use("/api/auth", authRouter);
  app.use("/api/channels", channelsRouter);
  app.use("/api/presence", presenceRouter);

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
