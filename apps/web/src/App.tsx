import { FormEvent, useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";

const socket = io("http://localhost:4000", {
  autoConnect: false
});

export function App() {
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    socket.connect();

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("system:message", (incoming: string) => {
      setMessages((current) => [...current, `[system] ${incoming}`]);
    });
    socket.on("chat:message", (incoming: string) => {
      setMessages((current) => [...current, incoming]);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("system:message");
      socket.off("chat:message");
      socket.disconnect();
    };
  }, []);

  const statusText = useMemo(() => {
    return connected ? "Conectado" : "Desconectado";
  }, [connected]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    socket.emit("chat:message", trimmed);
    setMessage("");
  }

  return (
    <main className="container">
      <h1>Live Chat MVP</h1>
      <p className={connected ? "status online" : "status offline"}>{statusText}</p>

      <form onSubmit={handleSubmit} className="composer">
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Escribe un mensaje"
        />
        <button type="submit">Enviar</button>
      </form>

      <ul className="messages">
        {messages.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </main>
  );
}
