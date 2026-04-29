import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware";
import { createRateLimitMiddleware } from "./middlewares/rate-limit.middleware";
import { authRouter } from "./modules/auth/auth.routes";
import { channelsRouter } from "./modules/channels/channels.routes";
import { conversationMessagesRouter } from "./modules/messages/conversation-messages.routes";
import { presenceRouter } from "./modules/presence/presence.routes";
import { getReadinessStatus } from "./observability/readiness";

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

  app.use(
    cors({
      origin: env.webOrigin,
      credentials: true
    })
  );
  app.use(express.json());

  app.use("/api", apiRateLimit);
  app.use("/api/auth", authRateLimit);

  app.use("/api/auth", authRouter);
  app.use("/api/channels", channelsRouter);
  app.use("/api/conversations", conversationMessagesRouter);
  app.use("/api/presence", presenceRouter);

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/readyz", async (_req, res) => {
    try {
      const readiness = await getReadinessStatus();

      if (!readiness.ok) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "readiness.failed",
            checks: readiness.checks,
            timestamp: new Date().toISOString()
          })
        );

        return res.status(503).json({
          ok: false,
          status: "not_ready",
          checks: readiness.checks
        });
      }

      return res.status(200).json({
        ok: true,
        status: "ready",
        checks: readiness.checks
      });
    } catch {
      const checks = {
        database: {
          ok: false,
          status: "error",
          error: "DATABASE_UNREACHABLE"
        },
        redis: {
          enabled: env.redisEnabled,
          ok: false,
          status: "error",
          error: "REDIS_UNREACHABLE"
        }
      };

      console.error(
        JSON.stringify({
          level: "error",
          event: "readiness.failed",
          checks,
          timestamp: new Date().toISOString()
        })
      );

      return res.status(503).json({
        ok: false,
        status: "not_ready",
        checks
      });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
