import { createServer } from "node:http";
import { Server } from "socket.io";
import { createApp } from "./app";
import { env } from "./config/env";
import { registerChatSocket } from "./socket/chat.socket";
import { initializeSocketRedisAdapter } from "./socket/socket-redis-adapter";

async function bootstrap() {
  const app = createApp();
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: env.webOrigin,
      methods: ["GET", "POST"]
    }
  });

  await initializeSocketRedisAdapter(io);
  registerChatSocket(io);

  httpServer.listen(env.port, () => {
    console.log(`API corriendo en http://localhost:${env.port}`);
  });
}

void bootstrap().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "api.bootstrap_failed",
      error: error instanceof Error ? error.message : "unknown_error",
      timestamp: new Date().toISOString()
    })
  );

  process.exitCode = 1;
});
