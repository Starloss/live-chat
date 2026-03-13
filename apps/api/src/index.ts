import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.emit("system:message", "Conectado al servidor de chat");

  socket.on("chat:message", (message: string) => {
    io.emit("chat:message", message);
  });
});

const port = Number(process.env.PORT ?? 4000);
httpServer.listen(port, () => {
  console.log(`API corriendo en http://localhost:${port}`);
});
