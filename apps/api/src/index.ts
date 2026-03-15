import { createServer } from "node:http";
import { Server } from "socket.io";
import { createApp } from "./app";
import { env } from "./config/env";
import { registerChatSocket } from "./socket/chat.socket";

const app = createApp();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: env.webOrigin,
    methods: ["GET", "POST"]
  }
});

registerChatSocket(io);

httpServer.listen(env.port, () => {
  console.log(`API corriendo en http://localhost:${env.port}`);
});
