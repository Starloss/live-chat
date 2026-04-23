import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

const API_BASE_URL = "http://localhost:4000";
const BACKGROUND_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

interface UserDto {
  id: string;
  username: string;
  email: string;
}

interface ChannelDto {
  id: string;
  name: string;
  visibility: "PUBLIC" | "PRIVATE";
  role: "OWNER" | "MEMBER";
}

interface DiscoveredChannelDto {
  id: string;
  name: string;
  visibility: "PUBLIC" | "PRIVATE";
  memberCount: number;
  isOwner: boolean;
  membershipRole: "OWNER" | "MEMBER" | null;
  joinRequest: {
    id: string;
    status: "PENDING" | "APPROVED" | "DENIED";
  } | null;
}

interface ChannelJoinRequestDto {
  id: string;
  status: "PENDING" | "APPROVED" | "DENIED";
  createdAt: string;
  user: {
    id: string;
    username: string;
  };
}

interface MessageDto {
  id: string;
  channelId: string;
  body: string;
  createdAt: string;
  author?: {
    id: string;
    username: string;
  };
  authorId?: string;
}

interface PresenceDto {
  userId: string;
  username: string;
  status: "online" | "offline";
}

interface ApiErrorResponse {
  message?: string;
}

class ApiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
  }
}

async function apiRequest<TResponse>(
  path: string,
  options?: {
    method?: "GET" | "POST";
    token?: string;
    body?: unknown;
  }
) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    credentials: "include",
    ...(options?.body ? { body: JSON.stringify(options.body) } : {})
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    throw new ApiHttpError(response.status, error.message ?? `Error HTTP ${response.status}`);
  }

  return (await response.json().catch(() => ({}))) as TResponse;
}

export function App() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [authForm, setAuthForm] = useState({
    username: "",
    email: "",
    password: ""
  });
  const [token, setToken] = useState<string>("");
  const [user, setUser] = useState<UserDto | null>(null);
  const [isSessionReady, setIsSessionReady] = useState(false);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelVisibility, setNewChannelVisibility] = useState<"PUBLIC" | "PRIVATE">("PUBLIC");
  const [channelSearchTerm, setChannelSearchTerm] = useState("");
  const [discoveredChannels, setDiscoveredChannels] = useState<DiscoveredChannelDto[]>([]);
  const [ownerRequests, setOwnerRequests] = useState<ChannelJoinRequestDto[]>([]);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [messageText, setMessageText] = useState("");
  const [presence, setPresence] = useState<PresenceDto[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const socketRef = useRef<Socket | null>(null);
  const tokenRef = useRef("");
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const typingActiveRef = useRef(false);

  const resetSessionState = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setConnected(false);
    setToken("");
    setUser(null);
    setChannels([]);
    setSelectedChannelId("");
    setDiscoveredChannels([]);
    setOwnerRequests([]);
    setMessages([]);
    setPresence([]);
    setTypingUsers([]);
    setMessageText("");
    typingActiveRef.current = false;

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }, []);

  const refreshAccessToken = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }

    const refreshPromise = (async () => {
      try {
        const response = await apiRequest<{ user: UserDto; accessToken: string }>("/api/auth/refresh", {
          method: "POST"
        });

        setToken(response.accessToken);
        setUser(response.user);
        return response.accessToken;
      } catch {
        resetSessionState();
        return null;
      } finally {
        refreshInFlightRef.current = null;
      }
    })();

    refreshInFlightRef.current = refreshPromise;
    return refreshPromise;
  }, [resetSessionState]);

  const authenticatedRequest = useCallback(
    async <TResponse,>(
      path: string,
      options?: {
        method?: "GET" | "POST";
        body?: unknown;
      }
    ) => {
      const currentToken = tokenRef.current;
      if (!currentToken) {
        throw new Error("No autenticado");
      }

      try {
        return await apiRequest<TResponse>(path, {
          method: options?.method,
          body: options?.body,
          token: currentToken
        });
      } catch (error) {
        if (!(error instanceof ApiHttpError) || error.status !== 401) {
          throw error;
        }

        const rotatedToken = await refreshAccessToken();
        if (!rotatedToken) {
          throw new Error("Sesión expirada");
        }

        return apiRequest<TResponse>(path, {
          method: options?.method,
          body: options?.body,
          token: rotatedToken
        });
      }
    },
    [refreshAccessToken]
  );

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    let isMounted = true;

    void (async () => {
      await refreshAccessToken();

      if (isMounted) {
        setIsSessionReady(true);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [refreshAccessToken]);

  useEffect(() => {
    if (!token || !user) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshAccessToken();
    }, BACKGROUND_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [token, user, refreshAccessToken]);

  const selectedChannel = useMemo(() => {
    return channels.find((channel) => channel.id === selectedChannelId) ?? null;
  }, [channels, selectedChannelId]);

  const isSelectedChannelOwner = selectedChannel?.role === "OWNER";

  useEffect(() => {
    if (!token) {
      setUser(null);
      setChannels([]);
      setSelectedChannelId("");
      return;
    }

    void (async () => {
      try {
        const [meResponse, channelsResponse] = await Promise.all([
          authenticatedRequest<{ user: UserDto }>("/api/auth/me"),
          authenticatedRequest<{ channels: ChannelDto[] }>("/api/channels")
        ]);

        setUser(meResponse.user);
        setChannels(channelsResponse.channels);
        if (!selectedChannelId && channelsResponse.channels.length > 0) {
          setSelectedChannelId(channelsResponse.channels[0].id);
        }
      } catch (error) {
        resetSessionState();
        setErrorMessage(error instanceof Error ? error.message : "No se pudo cargar la sesión");
      }
    })();
  }, [token, selectedChannelId, authenticatedRequest, resetSessionState]);

  useEffect(() => {
    if (!token) {
      setDiscoveredChannels([]);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await authenticatedRequest<{ channels: DiscoveredChannelDto[] }>(
            `/api/channels/discover?query=${encodeURIComponent(channelSearchTerm)}`
          );
          setDiscoveredChannels(response.channels);
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : "No se pudo buscar canales");
        }
      })();
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [token, channelSearchTerm, authenticatedRequest]);

  useEffect(() => {
    if (!token || !user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      return;
    }

    const socket = io(`${API_BASE_URL}/chat`, {
      auth: { token }
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      if (selectedChannelId) {
        socket.emit("channel:join", { channelId: selectedChannelId });
      }
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.on("message:new", (incoming: MessageDto) => {
      if (incoming.channelId !== selectedChannelId) {
        return;
      }

      setMessages((current) => {
        if (current.some((message) => message.id === incoming.id)) {
          return current;
        }

        return [...current, incoming];
      });
    });

    socket.on(
      "typing:update",
      (incoming: { channelId: string; userId: string; username: string; isTyping: boolean }) => {
        if (incoming.channelId !== selectedChannelId || incoming.userId === user.id) {
          return;
        }

        setTypingUsers((current) => {
          if (incoming.isTyping) {
            return current.includes(incoming.username) ? current : [...current, incoming.username];
          }

          return current.filter((username) => username !== incoming.username);
        });
      }
    );

    socket.on(
      "presence:update",
      (incoming: { channelId: string; userId: string; username: string; status: "online" | "offline" }) => {
        if (incoming.channelId !== selectedChannelId) {
          return;
        }

        setPresence((current) => {
          const index = current.findIndex((presenceUser) => presenceUser.userId === incoming.userId);
          if (index === -1) {
            return [...current, { userId: incoming.userId, username: incoming.username, status: incoming.status }];
          }

          const clone = [...current];
          clone[index] = {
            ...clone[index],
            status: incoming.status
          };
          return clone;
        });
      }
    );

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, user, selectedChannelId]);

  useEffect(() => {
    if (!token || !selectedChannelId) {
      setMessages([]);
      setPresence([]);
      setTypingUsers([]);
      return;
    }

    void (async () => {
      try {
        const [messagesResponse, presenceResponse] = await Promise.all([
          authenticatedRequest<{ messages: MessageDto[]; nextCursor: string | null }>(
            `/api/channels/${selectedChannelId}/messages?limit=30`
          ),
          authenticatedRequest<{ users: PresenceDto[] }>(`/api/presence?channelId=${selectedChannelId}`)
        ]);

        setMessages([...messagesResponse.messages].reverse());
        setPresence(presenceResponse.users);
        setTypingUsers([]);

        const socket = socketRef.current;
        if (socket?.connected) {
          socket.emit("channel:join", { channelId: selectedChannelId });
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "No se pudo cargar el canal");
      }
    })();
  }, [token, selectedChannelId, authenticatedRequest]);

  useEffect(() => {
    if (!token || !selectedChannelId || !isSelectedChannelOwner) {
      setOwnerRequests([]);
      return;
    }

    void (async () => {
      try {
        const response = await authenticatedRequest<{ requests: ChannelJoinRequestDto[] }>(
          `/api/channels/${selectedChannelId}/requests`
        );
        setOwnerRequests(response.requests);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "No se pudieron cargar solicitudes");
      }
    })();
  }, [token, selectedChannelId, isSelectedChannelOwner, authenticatedRequest]);

  async function refreshChannels() {
    if (!tokenRef.current) {
      return;
    }

    const response = await authenticatedRequest<{ channels: ChannelDto[] }>("/api/channels");
    setChannels(response.channels);

    if (!selectedChannelId && response.channels.length > 0) {
      setSelectedChannelId(response.channels[0].id);
    }
  }

  async function handleAuthSubmit(event: FormEvent) {
    event.preventDefault();
    setErrorMessage("");

    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload =
        mode === "login"
          ? {
              email: authForm.email,
              password: authForm.password
            }
          : {
              username: authForm.username,
              email: authForm.email,
              password: authForm.password
            };

      const response = await apiRequest<{ user: UserDto; accessToken: string }>(endpoint, {
        method: "POST",
        body: payload
      });

      setToken(response.accessToken);
      setUser(response.user);
      setAuthForm({ username: "", email: "", password: "" });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo autenticar");
    }
  }

  async function handleLogout() {
    try {
      await apiRequest<{ message: string }>("/api/auth/logout", {
        method: "POST",
        token: tokenRef.current || undefined
      });
    } catch {
      // Logout local aun si falla la red para no dejar sesion activa en UI.
    }

    resetSessionState();
  }

  async function handleCreateChannel(event: FormEvent) {
    event.preventDefault();
    const value = newChannelName.trim().toLowerCase();
    if (!value || !token) {
      return;
    }

    setErrorMessage("");

    try {
      const response = await authenticatedRequest<{ channel: ChannelDto }>("/api/channels", {
        method: "POST",
        body: {
          name: value,
          visibility: newChannelVisibility
        }
      });

      await refreshChannels();
      setSelectedChannelId(response.channel.id);
      setNewChannelName("");
      setNewChannelVisibility("PUBLIC");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo crear el canal");
    }
  }

  async function handleJoinChannel(channelId: string) {
    if (!channelId || !token) {
      return;
    }

    setErrorMessage("");

    try {
      const response = await authenticatedRequest<{
        result: "joined" | "requested";
        request?: { id: string; status: "PENDING" | "APPROVED" | "DENIED" };
      }>(`/api/channels/${channelId}/join`, {
        method: "POST"
      });

      if (response.result === "joined") {
        await refreshChannels();
        setSelectedChannelId(channelId);
        setErrorMessage("");
      } else {
        setErrorMessage("Solicitud enviada. Espera aprobación del owner.");
      }

      const discoverResponse = await authenticatedRequest<{ channels: DiscoveredChannelDto[] }>(
        `/api/channels/discover?query=${encodeURIComponent(channelSearchTerm)}`
      );
      setDiscoveredChannels(discoverResponse.channels);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo unir al canal");
    }
  }

  async function handleResolveRequest(requestId: string, action: "approve" | "deny") {
    if (!token || !selectedChannelId || !isSelectedChannelOwner) {
      return;
    }

    setErrorMessage("");

    try {
      await authenticatedRequest(`/api/channels/${selectedChannelId}/requests/${requestId}/${action}`, {
        method: "POST"
      });

      const [requestsResponse] = await Promise.all([
        authenticatedRequest<{ requests: ChannelJoinRequestDto[] }>(`/api/channels/${selectedChannelId}/requests`),
        refreshChannels()
      ]);

      setOwnerRequests(requestsResponse.requests);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo resolver la solicitud");
    }
  }

  if (!isSessionReady) {
    return (
      <main className="auth-container">
        <h1>Live Chat MVP</h1>
        <p className="hint">Restaurando sesión...</p>
      </main>
    );
  }

  function emitTypingStop() {
    if (!selectedChannelId || !typingActiveRef.current) {
      return;
    }

    socketRef.current?.emit("typing:stop", { channelId: selectedChannelId });
    typingActiveRef.current = false;
  }

  function scheduleTypingStop() {
    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = window.setTimeout(() => {
      emitTypingStop();
    }, 1200);
  }

  function handleMessageInput(value: string) {
    setMessageText(value);

    if (!selectedChannelId || !socketRef.current?.connected) {
      return;
    }

    if (!typingActiveRef.current && value.trim().length > 0) {
      socketRef.current.emit("typing:start", { channelId: selectedChannelId });
      typingActiveRef.current = true;
    }

    if (value.trim().length === 0) {
      emitTypingStop();
      return;
    }

    scheduleTypingStop();
  }

  function handleMessageSubmit(event: FormEvent) {
    event.preventDefault();
    const body = messageText.trim();
    if (!selectedChannelId || !body) {
      return;
    }

    setErrorMessage("");
    emitTypingStop();

    socketRef.current?.emit(
      "message:send",
      {
        channelId: selectedChannelId,
        body
      },
      (response: { ok: boolean; message?: string }) => {
        if (!response.ok) {
          setErrorMessage(response.message ?? "No se pudo enviar el mensaje");
          return;
        }

        setMessageText("");
      }
    );
  }

  if (!token || !user) {
    return (
      <main className="auth-container">
        <h1>Live Chat MVP</h1>
        <p className="hint">{mode === "login" ? "Inicia sesión" : "Crea tu cuenta"}</p>

        <form onSubmit={handleAuthSubmit} className="card form-grid">
          {mode === "register" ? (
            <input
              placeholder="username"
              value={authForm.username}
              onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
            />
          ) : null}

          <input
            type="email"
            placeholder="email"
            value={authForm.email}
            onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))}
          />
          <input
            type="password"
            placeholder="password"
            value={authForm.password}
            onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
          />

          <button type="submit">{mode === "login" ? "Entrar" : "Registrarme"}</button>
        </form>

        <button
          className="ghost"
          type="button"
          onClick={() => setMode((current) => (current === "login" ? "register" : "login"))}
        >
          {mode === "login" ? "No tengo cuenta" : "Ya tengo cuenta"}
        </button>

        {errorMessage ? <p className="error">{errorMessage}</p> : null}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar card">
        <div className="sidebar-head">
          <div>
            <h2>Canales</h2>
            <p className={connected ? "status online" : "status offline"}>
              {connected ? "Socket conectado" : "Socket desconectado"}
            </p>
          </div>
          <button className="ghost" onClick={handleLogout} type="button">
            Salir
          </button>
        </div>

        <form onSubmit={handleCreateChannel} className="form-inline">
          <input
            placeholder="nuevo-canal"
            value={newChannelName}
            onChange={(event) => setNewChannelName(event.target.value)}
          />
          <select
            value={newChannelVisibility}
            onChange={(event) => setNewChannelVisibility(event.target.value as "PUBLIC" | "PRIVATE")}
          >
            <option value="PUBLIC">PUBLIC</option>
            <option value="PRIVATE">PRIVATE</option>
          </select>
          <button type="submit">Crear</button>
        </form>

        <div className="discover card-muted">
          <h3>Canales activos</h3>
          <input
            placeholder="Buscar canal por nombre"
            value={channelSearchTerm}
            onChange={(event) => setChannelSearchTerm(event.target.value)}
          />

          <ul className="discover-list">
            {discoveredChannels.map((channel) => {
              const alreadyMember = Boolean(channel.membershipRole);
              const pendingRequest = channel.joinRequest?.status === "PENDING";
              const isPrivateChannel = channel.visibility === "PRIVATE";

              return (
                <li key={channel.id}>
                  <div>
                    <strong>#{channel.name}</strong>
                    <p className="hint compact">
                      {channel.visibility} · {channel.memberCount} miembros
                    </p>
                  </div>

                  {alreadyMember ? (
                    <button type="button" className="ghost" onClick={() => setSelectedChannelId(channel.id)}>
                      Abrir
                    </button>
                  ) : isPrivateChannel && pendingRequest ? (
                    <button type="button" onClick={() => void handleJoinChannel(channel.id)}>
                      Aceptar invitación
                    </button>
                  ) : isPrivateChannel ? (
                    <span className="pill pending">Solo invitación</span>
                  ) : pendingRequest ? (
                    <span className="pill pending">Pendiente</span>
                  ) : (
                    <button type="button" onClick={() => void handleJoinChannel(channel.id)}>
                      Unirme
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <ul className="channel-list">
          {channels.map((channel) => (
            <li key={channel.id}>
              <button
                type="button"
                className={channel.id === selectedChannelId ? "channel active" : "channel"}
                onClick={() => setSelectedChannelId(channel.id)}
              >
                <span>#{channel.name}</span>
                <small>
                  {channel.role} · {channel.visibility}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat card">
        <header className="chat-head">
          <div>
            <h2>{selectedChannel ? `#${selectedChannel.name}` : "Selecciona un canal"}</h2>
            <p className="hint">Usuario: {user.username}</p>
          </div>
          <div className="presence">
            {presence.map((presenceUser) => (
              <span key={presenceUser.userId} className={presenceUser.status === "online" ? "dot online" : "dot offline"}>
                {presenceUser.username}
              </span>
            ))}
          </div>
        </header>

        <ul className="messages">
          {messages.map((message) => (
            <li key={message.id}>
              <strong>{message.author?.username ?? message.authorId ?? "user"}</strong>
              <p>{message.body}</p>
            </li>
          ))}
        </ul>

        {isSelectedChannelOwner ? (
          <section className="requests card-muted">
            <h3>Solicitudes pendientes</h3>
            {ownerRequests.length === 0 ? <p className="hint compact">Sin solicitudes pendientes</p> : null}
            <ul className="request-list">
              {ownerRequests.map((request) => (
                <li key={request.id}>
                  <div>
                    <strong>{request.user.username}</strong>
                  </div>
                  <div className="request-actions">
                    <button type="button" onClick={() => void handleResolveRequest(request.id, "approve")}>
                      Aprobar
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void handleResolveRequest(request.id, "deny")}
                    >
                      Denegar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {typingUsers.length > 0 ? <p className="hint">{typingUsers.join(", ")} está escribiendo...</p> : null}

        <form onSubmit={handleMessageSubmit} className="composer">
          <input
            value={messageText}
            onBlur={emitTypingStop}
            onChange={(event) => handleMessageInput(event.target.value)}
            placeholder={selectedChannel ? "Escribe un mensaje" : "Selecciona un canal"}
            disabled={!selectedChannel}
          />
          <button type="submit" disabled={!selectedChannel}>
            Enviar
          </button>
        </form>

        {errorMessage ? <p className="error">{errorMessage}</p> : null}
      </section>
    </main>
  );
}
