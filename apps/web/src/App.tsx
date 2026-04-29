import {
  FormEvent,
  UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { io, Socket } from "socket.io-client";

const API_BASE_URL = "http://localhost:4000";
const BACKGROUND_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const CONVERSATION_LIST_REFRESH_INTERVAL_MS = 20 * 1000;
const HISTORY_PAGE_SIZE = 30;
const SCROLL_TOP_LOAD_THRESHOLD_PX = 60;

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
  createdAt?: string;
  joinedAt?: string;
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
  conversationId?: string | null;
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

interface SocketAckResponse {
  ok: boolean;
  message?: string;
}

interface ConversationListMeta {
  conversationId: string | null;
  lastMessageId: string | null;
  lastMessageBody: string | null;
  lastMessageAuthor: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
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

function getTimestampMs(value: string | null | undefined) {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortMessagesChronologically(messages: MessageDto[]) {
  return [...messages].sort((left, right) => {
    const byDate = getTimestampMs(left.createdAt) - getTimestampMs(right.createdAt);
    if (byDate !== 0) {
      return byDate;
    }

    return left.id.localeCompare(right.id);
  });
}

function mergeMessagesChronologically(current: MessageDto[], incoming: MessageDto[]) {
  if (incoming.length === 0) {
    return current;
  }

  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, {
      ...byId.get(message.id),
      ...message
    });
  }

  return sortMessagesChronologically(Array.from(byId.values()));
}

function getLatestMessage(messages: MessageDto[]) {
  if (messages.length === 0) {
    return null;
  }

  return messages.reduce((latest, candidate) => {
    return getTimestampMs(candidate.createdAt) > getTimestampMs(latest.createdAt) ? candidate : latest;
  });
}

function buildMessagesPath(input: {
  channelId: string;
  conversationId?: string | null;
  cursor?: string | null;
  limit: number;
}) {
  const query = new URLSearchParams();
  query.set("limit", String(input.limit));

  if (input.cursor) {
    query.set("cursor", input.cursor);
  }

  if (input.conversationId) {
    return `/api/conversations/${input.conversationId}/messages?${query.toString()}`;
  }

  return `/api/channels/${input.channelId}/messages?${query.toString()}`;
}

function getFallbackChannelActivityAt(channel: ChannelDto) {
  return channel.joinedAt ?? channel.createdAt ?? null;
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
  const [messagesCursor, setMessagesCursor] = useState<string | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [presence, setPresence] = useState<PresenceDto[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const [conversationMetaByChannel, setConversationMetaByChannel] = useState<
    Record<string, ConversationListMeta>
  >({});

  const socketRef = useRef<Socket | null>(null);
  const tokenRef = useRef("");
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const typingActiveRef = useRef(false);
  const selectedChannelIdRef = useRef("");
  const previousSelectedChannelIdRef = useRef("");
  const activeSocketScopeRef = useRef<string | null>(null);
  const activeChannelRequestIdRef = useRef(0);
  const channelsRef = useRef<ChannelDto[]>([]);
  const conversationMetaRef = useRef<Record<string, ConversationListMeta>>({});
  const messagesListRef = useRef<HTMLUListElement | null>(null);
  const pendingScrollRestoreRef = useRef<{ previousHeight: number; previousTop: number } | null>(null);
  const shouldScrollToBottomRef = useRef(false);

  const announceLive = useCallback((message: string) => {
    setLiveAnnouncement((current) => (current === message ? `${message} ` : message));
  }, []);

  const syncConversationMeta = useCallback(
    (channelId: string, updater: (previous: ConversationListMeta) => ConversationListMeta) => {
      setConversationMetaByChannel((current) => {
        const previous =
          current[channelId] ??
          ({
            conversationId: null,
            lastMessageId: null,
            lastMessageBody: null,
            lastMessageAuthor: null,
            lastMessageAt: null,
            unreadCount: 0
          } satisfies ConversationListMeta);

        const next = updater(previous);
        return {
          ...current,
          [channelId]: next
        };
      });
    },
    []
  );

  const joinSocketScope = useCallback(
    (channelId: string) => {
      if (!channelId) {
        return;
      }

      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        return;
      }

      const previousScope = activeSocketScopeRef.current;
      if (previousScope === channelId) {
        return;
      }

      if (previousScope) {
        socket.emit("channel:leave", { channelId: previousScope });
      }

      socket.emit("channel:join", { channelId }, (ack?: SocketAckResponse) => {
        if (ack?.ok) {
          activeSocketScopeRef.current = channelId;
          return;
        }

        activeSocketScopeRef.current = null;
        if (ack?.message) {
          setErrorMessage(ack.message);
        }
      });
    },
    []
  );

  const resetSessionState = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    activeSocketScopeRef.current = null;
    selectedChannelIdRef.current = "";
    previousSelectedChannelIdRef.current = "";
    channelsRef.current = [];
    conversationMetaRef.current = {};
    activeChannelRequestIdRef.current += 1;
    setConnected(false);
    setToken("");
    setUser(null);
    setChannels([]);
    setSelectedChannelId("");
    setDiscoveredChannels([]);
    setOwnerRequests([]);
    setMessages([]);
    setMessagesCursor(null);
    setHasOlderMessages(false);
    setIsLoadingOlderMessages(false);
    setPresence([]);
    setTypingUsers([]);
    setMessageText("");
    setLiveAnnouncement("");
    setConversationMetaByChannel({});
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
    selectedChannelIdRef.current = selectedChannelId;
  }, [selectedChannelId]);

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  useEffect(() => {
    conversationMetaRef.current = conversationMetaByChannel;
  }, [conversationMetaByChannel]);

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

  const sortedChannels = useMemo(() => {
    return [...channels].sort((left, right) => {
      const leftMeta = conversationMetaByChannel[left.id];
      const rightMeta = conversationMetaByChannel[right.id];

      const leftActivity = getTimestampMs(leftMeta?.lastMessageAt ?? getFallbackChannelActivityAt(left));
      const rightActivity = getTimestampMs(rightMeta?.lastMessageAt ?? getFallbackChannelActivityAt(right));
      if (leftActivity !== rightActivity) {
        return rightActivity - leftActivity;
      }

      return left.name.localeCompare(right.name);
    });
  }, [channels, conversationMetaByChannel]);

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
        setSelectedChannelId((current) => {
          if (current && channelsResponse.channels.some((channel) => channel.id === current)) {
            return current;
          }

          return channelsResponse.channels[0]?.id ?? "";
        });
      } catch (error) {
        resetSessionState();
        setErrorMessage(error instanceof Error ? error.message : "No se pudo cargar la sesión");
      }
    })();
  }, [token, authenticatedRequest, resetSessionState]);

  useEffect(() => {
    if (!selectedChannelId) {
      return;
    }

    if (channels.some((channel) => channel.id === selectedChannelId)) {
      return;
    }

    setSelectedChannelId(channels[0]?.id ?? "");
  }, [channels, selectedChannelId]);

  useEffect(() => {
    const activeIds = new Set(channels.map((channel) => channel.id));
    setConversationMetaByChannel((current) => {
      const nextEntries = Object.entries(current).filter(([channelId]) => activeIds.has(channelId));
      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }

      return Object.fromEntries(nextEntries);
    });
  }, [channels]);

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
      activeSocketScopeRef.current = null;
      setConnected(false);
      return;
    }

    const socket = io(`${API_BASE_URL}/chat`, {
      auth: { token }
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      activeSocketScopeRef.current = null;
      joinSocketScope(selectedChannelIdRef.current);
      if (selectedChannelIdRef.current) {
        announceLive("Reconectado al chat en tiempo real");
      }
    });

    socket.on("disconnect", () => {
      setConnected(false);
      activeSocketScopeRef.current = null;
      announceLive("Conexión de chat en tiempo real interrumpida");
    });

    socket.on("auth:expired", () => {
      setErrorMessage("Sesión expirada");
      resetSessionState();
    });

    socket.on("message:new", (incoming: MessageDto) => {
      const currentChannelId = selectedChannelIdRef.current;

      syncConversationMeta(incoming.channelId, (previous) => ({
        conversationId: incoming.conversationId ?? previous.conversationId,
        lastMessageId: incoming.id,
        lastMessageBody: incoming.body,
        lastMessageAuthor: incoming.author?.username ?? incoming.authorId ?? previous.lastMessageAuthor,
        lastMessageAt: incoming.createdAt,
        unreadCount:
          incoming.channelId === currentChannelId ? 0 : Math.max(0, (previous.unreadCount ?? 0) + 1)
      }));

      if (incoming.channelId !== currentChannelId) {
        return;
      }

      const messageList = messagesListRef.current;
      const shouldStickToBottom = messageList
        ? messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80
        : true;

      if (shouldStickToBottom) {
        shouldScrollToBottomRef.current = true;
      }

      setMessages((current) => mergeMessagesChronologically(current, [incoming]));
      announceLive(`Nuevo mensaje de ${incoming.author?.username ?? incoming.authorId ?? "usuario"}`);
    });

    socket.on(
      "typing:update",
      (incoming: { channelId: string; userId: string; username: string; isTyping: boolean }) => {
        if (incoming.channelId !== selectedChannelIdRef.current || incoming.userId === user.id) {
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
        if (incoming.channelId !== selectedChannelIdRef.current) {
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
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      activeSocketScopeRef.current = null;
    };
  }, [token, user, joinSocketScope, announceLive, resetSessionState, syncConversationMeta]);

  useEffect(() => {
    if (!selectedChannelId) {
      return;
    }

    const previousChannelId = previousSelectedChannelIdRef.current;
    if (previousChannelId && previousChannelId !== selectedChannelId) {
      socketRef.current?.emit("channel:leave", { channelId: previousChannelId });
      if (typingActiveRef.current) {
        socketRef.current?.emit("typing:stop", { channelId: previousChannelId });
        typingActiveRef.current = false;
      }
    }

    previousSelectedChannelIdRef.current = selectedChannelId;
    joinSocketScope(selectedChannelId);

    syncConversationMeta(selectedChannelId, (previous) => ({
      ...previous,
      unreadCount: 0
    }));
  }, [selectedChannelId, joinSocketScope, syncConversationMeta]);

  useEffect(() => {
    if (!token || !selectedChannelId) {
      setMessages([]);
      setMessagesCursor(null);
      setHasOlderMessages(false);
      setIsLoadingOlderMessages(false);
      setPresence([]);
      setTypingUsers([]);
      return;
    }

    const requestId = activeChannelRequestIdRef.current + 1;
    activeChannelRequestIdRef.current = requestId;
    setMessagesCursor(null);
    setHasOlderMessages(false);
    setIsLoadingOlderMessages(false);

    void (async () => {
      try {
        const currentConversationId = conversationMetaRef.current[selectedChannelId]?.conversationId;
        const [messagesResponse, presenceResponse] = await Promise.all([
          authenticatedRequest<{ messages: MessageDto[]; nextCursor: string | null }>(
            buildMessagesPath({
              channelId: selectedChannelId,
              conversationId: currentConversationId,
              limit: HISTORY_PAGE_SIZE
            })
          ),
          authenticatedRequest<{ users: PresenceDto[] }>(`/api/presence?channelId=${selectedChannelId}`)
        ]);

        if (requestId !== activeChannelRequestIdRef.current) {
          return;
        }

        const sortedMessages = sortMessagesChronologically(messagesResponse.messages);
        setMessages(sortedMessages);
        setMessagesCursor(messagesResponse.nextCursor);
        setHasOlderMessages(Boolean(messagesResponse.nextCursor));
        setPresence(presenceResponse.users);
        setTypingUsers([]);
        shouldScrollToBottomRef.current = true;

        const latestMessage = getLatestMessage(messagesResponse.messages);
        syncConversationMeta(selectedChannelId, (previous) => ({
          conversationId: latestMessage?.conversationId ?? previous.conversationId,
          lastMessageId: latestMessage?.id ?? previous.lastMessageId,
          lastMessageBody: latestMessage?.body ?? previous.lastMessageBody,
          lastMessageAuthor:
            latestMessage?.author?.username ?? latestMessage?.authorId ?? previous.lastMessageAuthor,
          lastMessageAt:
            latestMessage?.createdAt ??
            previous.lastMessageAt ??
            (selectedChannel ? getFallbackChannelActivityAt(selectedChannel) : null),
          unreadCount: 0
        }));

        announceLive(`Conversación ${selectedChannel ? `#${selectedChannel.name}` : "activa"} cargada`);

        const socket = socketRef.current;
        if (socket?.connected) {
          joinSocketScope(selectedChannelId);
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "No se pudo cargar el canal");
      }
    })();
  }, [token, selectedChannelId, selectedChannel, authenticatedRequest, joinSocketScope, syncConversationMeta, announceLive]);

  useEffect(() => {
    if (!token || channels.length === 0) {
      return;
    }

    const refreshSnapshots = async (incrementUnread: boolean) => {
      await Promise.all(
        channelsRef.current.map(async (channel) => {
          try {
            const response = await authenticatedRequest<{ messages: MessageDto[]; nextCursor: string | null }>(
              buildMessagesPath({ channelId: channel.id, limit: 1 })
            );

            const latestMessage = response.messages[0];
            if (!latestMessage) {
              syncConversationMeta(channel.id, (previous) => ({
                ...previous,
                lastMessageAt: previous.lastMessageAt ?? getFallbackChannelActivityAt(channel),
                unreadCount: channel.id === selectedChannelIdRef.current ? 0 : previous.unreadCount
              }));
              return;
            }

            syncConversationMeta(channel.id, (previous) => {
              const isActiveChannel = channel.id === selectedChannelIdRef.current;
              const hasNewLatestMessage = latestMessage.id !== previous.lastMessageId;
              const unreadCount =
                incrementUnread && !isActiveChannel && hasNewLatestMessage
                  ? previous.unreadCount + 1
                  : isActiveChannel
                    ? 0
                    : previous.unreadCount;

              return {
                conversationId: latestMessage.conversationId ?? previous.conversationId,
                lastMessageId: latestMessage.id,
                lastMessageBody: latestMessage.body,
                lastMessageAuthor:
                  latestMessage.author?.username ?? latestMessage.authorId ?? previous.lastMessageAuthor,
                lastMessageAt: latestMessage.createdAt,
                unreadCount
              };
            });
          } catch {
            // Ignorar fallos de snapshot para no bloquear la experiencia principal.
          }
        })
      );
    };

    void refreshSnapshots(false);

    const intervalId = window.setInterval(() => {
      void refreshSnapshots(true);
    }, CONVERSATION_LIST_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [token, channels, authenticatedRequest, syncConversationMeta]);

  useLayoutEffect(() => {
    const listElement = messagesListRef.current;
    if (!listElement) {
      return;
    }

    const pendingRestore = pendingScrollRestoreRef.current;
    if (pendingRestore) {
      const delta = listElement.scrollHeight - pendingRestore.previousHeight;
      listElement.scrollTop = pendingRestore.previousTop + delta;
      pendingScrollRestoreRef.current = null;
      return;
    }

    if (shouldScrollToBottomRef.current) {
      listElement.scrollTop = listElement.scrollHeight;
      shouldScrollToBottomRef.current = false;
    }
  }, [messages]);

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
    setSelectedChannelId((current) => {
      if (current && response.channels.some((channel) => channel.id === current)) {
        return current;
      }

      return response.channels[0]?.id ?? "";
    });
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
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {liveAnnouncement}
        </div>
        <h1>Live Chat MVP</h1>
        <p className="hint">Restaurando sesión...</p>
      </main>
    );
  }

  function emitTypingStop(scopeChannelId = selectedChannelIdRef.current) {
    if (!scopeChannelId || !typingActiveRef.current) {
      return;
    }

    socketRef.current?.emit("typing:stop", { channelId: scopeChannelId });
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
        conversationId: conversationMetaRef.current[selectedChannelId]?.conversationId ?? undefined,
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

  async function loadOlderMessages() {
    if (!selectedChannelId || !messagesCursor || !hasOlderMessages || isLoadingOlderMessages) {
      return;
    }

    const currentRequestId = activeChannelRequestIdRef.current;
    setIsLoadingOlderMessages(true);

    const listElement = messagesListRef.current;
    if (listElement) {
      pendingScrollRestoreRef.current = {
        previousHeight: listElement.scrollHeight,
        previousTop: listElement.scrollTop
      };
    }

    try {
      const response = await authenticatedRequest<{ messages: MessageDto[]; nextCursor: string | null }>(
        buildMessagesPath({
          channelId: selectedChannelId,
          conversationId: conversationMetaRef.current[selectedChannelId]?.conversationId,
          cursor: messagesCursor,
          limit: HISTORY_PAGE_SIZE
        })
      );

      if (currentRequestId !== activeChannelRequestIdRef.current) {
        return;
      }

      setMessages((current) => mergeMessagesChronologically(current, response.messages));
      setMessagesCursor(response.nextCursor);
      setHasOlderMessages(Boolean(response.nextCursor));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo cargar historial");
      pendingScrollRestoreRef.current = null;
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }

  function handleMessagesScroll(event: UIEvent<HTMLUListElement>) {
    if (!hasOlderMessages || isLoadingOlderMessages) {
      return;
    }

    if (event.currentTarget.scrollTop <= SCROLL_TOP_LOAD_THRESHOLD_PX) {
      void loadOlderMessages();
    }
  }

  if (!token || !user) {
    return (
      <main className="auth-container">
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {liveAnnouncement}
        </div>
        <h1>Live Chat MVP</h1>
        <p className="hint">{mode === "login" ? "Inicia sesión" : "Crea tu cuenta"}</p>

        <form onSubmit={handleAuthSubmit} className="card form-grid">
          {mode === "register" ? (
            <>
              <label htmlFor="auth-username" className="sr-only">
                Username
              </label>
              <input
                id="auth-username"
                placeholder="username"
                value={authForm.username}
                onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
              />
            </>
          ) : null}

          <label htmlFor="auth-email" className="sr-only">
            Email
          </label>
          <input
            id="auth-email"
            type="email"
            placeholder="email"
            value={authForm.email}
            onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))}
          />
          <label htmlFor="auth-password" className="sr-only">
            Password
          </label>
          <input
            id="auth-password"
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
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>
      <aside className="sidebar card">
        <div className="sidebar-head">
          <div>
            <h2>Chats</h2>
            <p className={connected ? "status online" : "status offline"} role="status" aria-live="polite">
              {connected ? "Socket conectado" : "Socket desconectado"}
            </p>
          </div>
          <button className="ghost" onClick={handleLogout} type="button">
            Salir
          </button>
        </div>

        <form onSubmit={handleCreateChannel} className="form-inline">
          <label htmlFor="new-channel-name" className="sr-only">
            Nombre del canal
          </label>
          <input
            id="new-channel-name"
            placeholder="nuevo-canal"
            value={newChannelName}
            onChange={(event) => setNewChannelName(event.target.value)}
          />
          <label htmlFor="new-channel-visibility" className="sr-only">
            Visibilidad del canal
          </label>
          <select
            id="new-channel-visibility"
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
          <label htmlFor="discover-channel-search" className="sr-only">
            Buscar canal
          </label>
          <input
            id="discover-channel-search"
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
          {sortedChannels.map((channel) => {
            const meta = conversationMetaByChannel[channel.id];
            const messagePreview = meta?.lastMessageBody
              ? `${meta.lastMessageAuthor ? `${meta.lastMessageAuthor}: ` : ""}${meta.lastMessageBody}`
              : "Sin mensajes todavía";

            return (
              <li key={channel.id}>
                <button
                  type="button"
                  className={channel.id === selectedChannelId ? "channel active" : "channel"}
                  onClick={() => setSelectedChannelId(channel.id)}
                  aria-label={`Abrir canal ${channel.name}`}
                >
                  <span className="channel-main">
                    <strong>#{channel.name}</strong>
                    <small className="channel-preview">{messagePreview}</small>
                  </span>
                  <span className="channel-meta">
                    {meta?.unreadCount ? <span className="unread-badge">{meta.unreadCount}</span> : null}
                    <small>
                      {channel.role} · {channel.visibility}
                    </small>
                  </span>
                </button>
              </li>
            );
          })}
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

        {hasOlderMessages ? (
          <div className="history-actions">
            <button type="button" className="ghost" onClick={() => void loadOlderMessages()} disabled={isLoadingOlderMessages}>
              {isLoadingOlderMessages ? "Cargando historial..." : "Cargar mensajes anteriores"}
            </button>
          </div>
        ) : null}

        <ul
          className="messages"
          ref={messagesListRef}
          onScroll={handleMessagesScroll}
          aria-label={selectedChannel ? `Mensajes de ${selectedChannel.name}` : "Mensajes"}
        >
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
          <label htmlFor="message-input" className="sr-only">
            Mensaje
          </label>
          <input
            id="message-input"
            value={messageText}
            onBlur={() => emitTypingStop()}
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
