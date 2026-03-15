# Live Chat MVP Blueprint (Interview Ready)

## 1) Alcance MVP

- Registro/login con JWT.
- Crear y unirse a canales.
- Mensajes en tiempo real por canal.
- Presencia `online/offline`.
- Typing indicator por canal.
- Historial paginado (últimos N mensajes).

## 2) Stack y arquitectura

- Monorepo:
  - `apps/web` (React + Vite + TypeScript)
  - `apps/api` (Express + Socket.IO + TypeScript)
  - `packages/shared` (tipos compartidos)
- Base de datos: PostgreSQL + Prisma.
- Auth:
  - REST para login/register.
  - JWT en `Authorization: Bearer <token>` para REST y handshake de socket.

## 3) Modelo de datos (Prisma)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id           String             @id @default(cuid())
  username     String             @unique
  email        String             @unique
  passwordHash String
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt

  memberships  ChannelMember[]
  messages     Message[]
  presences    UserPresence[]
  typingStates TypingState[]
}

model Channel {
  id          String          @id @default(cuid())
  name        String          @unique
  createdById String
  createdAt   DateTime        @default(now())

  createdBy   User            @relation(fields: [createdById], references: [id])
  members     ChannelMember[]
  messages    Message[]
  typing      TypingState[]
}

model ChannelMember {
  id        String   @id @default(cuid())
  channelId String
  userId    String
  role      ChannelRole @default(MEMBER)
  joinedAt  DateTime @default(now())

  channel   Channel  @relation(fields: [channelId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([channelId, userId])
  @@index([userId])
}

model Message {
  id         String   @id @default(cuid())
  channelId  String
  authorId   String
  body       String
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  deletedAt  DateTime?

  channel    Channel  @relation(fields: [channelId], references: [id], onDelete: Cascade)
  author     User     @relation(fields: [authorId], references: [id], onDelete: Cascade)

  @@index([channelId, createdAt(sort: Desc)])
  @@index([authorId])
}

model UserPresence {
  id         String         @id @default(cuid())
  userId     String
  status     PresenceStatus @default(OFFLINE)
  lastSeenAt DateTime?
  updatedAt  DateTime       @updatedAt

  user       User           @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId])
}

model TypingState {
  id         String   @id @default(cuid())
  channelId  String
  userId     String
  isTyping   Boolean  @default(false)
  updatedAt  DateTime @updatedAt

  channel    Channel  @relation(fields: [channelId], references: [id], onDelete: Cascade)
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([channelId, userId])
  @@index([channelId, isTyping])
}

enum ChannelRole {
  OWNER
  MEMBER
}

enum PresenceStatus {
  ONLINE
  OFFLINE
}
```

## 4) Contratos API (REST)

Base URL: `/api`

### Auth

- `POST /auth/register`
  - body: `{ username, email, password }`
  - 201: `{ user, accessToken }`
- `POST /auth/login`
  - body: `{ email, password }`
  - 200: `{ user, accessToken }`
- `GET /auth/me`
  - header: `Authorization`
  - 200: `{ user }`

### Channels

- `GET /channels`
  - 200: `{ channels: ChannelSummary[] }` (solo canales del usuario)
- `POST /channels`
  - body: `{ name }`
  - 201: `{ channel }` (crea canal + agrega al creador como OWNER)
- `POST /channels/:channelId/join`
  - 200: `{ membership }`
- `GET /channels/:channelId/members`
  - 200: `{ members: ChannelMemberDto[] }`

### Messages

- `GET /channels/:channelId/messages?cursor=<messageId>&limit=30`
  - orden descendente por `createdAt`
  - 200: `{ messages: MessageDto[], nextCursor: string | null }`
- `POST /channels/:channelId/messages`
  - body: `{ body }`
  - 201: `{ message }`

### Presence

- `GET /presence?channelId=<id>`
  - 200: `{ users: PresenceDto[] }`

## 5) Socket.IO namespace/eventos

Namespace recomendado: `/chat`

Autenticación en handshake:

```ts
io.of('/chat').use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  // verificar JWT y adjuntar user a socket.data
  next();
});
```

### Eventos cliente -> servidor

- `channel:join`
  - payload: `{ channelId: string }`
  - ack: `{ ok: true }`
- `channel:leave`
  - payload: `{ channelId: string }`
  - ack: `{ ok: true }`
- `message:send`
  - payload: `{ channelId: string, body: string, clientId?: string }`
  - ack: `{ ok: true, message: MessageDto }`
- `typing:start`
  - payload: `{ channelId: string }`
- `typing:stop`
  - payload: `{ channelId: string }`

### Eventos servidor -> cliente

- `message:new`
  - payload: `MessageDto`
  - emit: a room `channel:<channelId>`
- `presence:update`
  - payload: `{ userId: string, status: 'online' | 'offline', lastSeenAt?: string }`
- `typing:update`
  - payload: `{ channelId: string, userId: string, isTyping: boolean }`
- `channel:joined`
  - payload: `{ channelId: string }`
- `error:domain`
  - payload: `{ code: string, message: string }`

## 6) Rooms y estrategia de broadcast

- Room por canal: `channel:<channelId>`.
- Room por usuario: `user:<userId>` (útil para notificaciones privadas/futuras).
- Al `channel:join`: validar membresía en DB y luego `socket.join(room)`.
- `message:new`: `io.to(room).emit(...)`.

## 7) Validaciones y reglas de autorización

- Solo miembros de canal pueden:
  - obtener mensajes,
  - enviar mensajes,
  - recibir typing/presence de ese canal.
- `body` de mensaje:
  - trim,
  - longitud 1..2000.
- `channel.name`:
  - único, longitud 3..50, minúsculas + guiones recomendado.

## 8) Estrategia de reconexión y consistencia UI

Frontend:

- `socket.io-client` con reconexión automática.
- Al reconectar:
  1. Revalidar sesión (`GET /auth/me` o token local válido).
  2. Rejoin de canales abiertos (`channel:join`).
  3. Rehidratar mensajes con `GET /messages` usando cursor.

Evitar duplicados:

- Guardar `message.id` en estado (map/set) antes de insertar en lista.

## 9) DTOs recomendados (shared)

```ts
export type Presence = 'online' | 'offline';

export interface UserDto {
  id: string;
  username: string;
  email: string;
}

export interface ChannelSummary {
  id: string;
  name: string;
  role: 'OWNER' | 'MEMBER';
}

export interface MessageDto {
  id: string;
  channelId: string;
  author: {
    id: string;
    username: string;
  };
  body: string;
  createdAt: string;
}
```

## 10) Orden de implementación (rápido y seguro)

1. Prisma schema + migración inicial.
2. Auth (`register`, `login`, hash con bcrypt, JWT).
3. Canales (`create`, `list`, `join`).
4. Mensajes REST paginados.
5. Socket auth + rooms + `message:send`/`message:new`.
6. Presence `online/offline`.
7. Typing start/stop con timeout cliente (ej. 2s sin tecleo -> stop).

## 11) Checklist de entrevista técnica

- Justificar por qué WebSocket + REST híbrido.
- Explicar paginación por cursor vs offset.
- Explicar autorización por canal en cada capa (REST + Socket).
- Mostrar cómo manejas reconexión y eventos duplicados.
- Explicar cómo escalarías con Redis adapter (siguiente fase).
