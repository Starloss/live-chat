# live-chat

Monorepo base para un Realtime Chat orientado a entrevistas.

## Estructura

- `apps/web`: frontend con React + Vite + TypeScript.
- `apps/api`: backend con Express + Socket.IO + TypeScript.
- `packages/shared`: tipos compartidos entre frontend y backend.

## Stack inicial

- Frontend: React 19, Vite, TypeScript, socket.io-client.
- Backend: Node.js, Express, Socket.IO, TypeScript.
- Workspace: pnpm workspaces.

## Primer arranque

1. Instalar dependencias:

	```bash
	pnpm install
	```

2. Configurar variables del API:

	- Copiar `apps/api/.env.example` a `apps/api/.env`.

3. Levantar PostgreSQL con Docker:

	```bash
	pnpm db:up
	```

4. Ejecutar Prisma:

	```bash
	pnpm --filter @live-chat/api prisma:migrate --name init
	pnpm --filter @live-chat/api prisma:generate
	```

5. Levantar frontend + backend:

	```bash
	pnpm dev
	```

7. (Opcional) Ejecutar smoke tests del API:

	```bash
	pnpm test:api
	```

8. CI en GitHub:

	- Workflow en `.github/workflows/ci.yml`.
	- Corre en cada push/PR a `main`.
	- Ejecuta: instalación, `prisma generate`, migraciones, `typecheck` y tests de API.

6. URLs:

- Web: http://localhost:5173
- API: http://localhost:4000
- PostgreSQL (Docker): localhost:5433

## Auth endpoints (MVP)

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh` (usa refresh token en cookie HttpOnly)
- `POST /api/auth/logout` (revoca refresh token actual y limpia cookie)
- `GET /api/auth/me` (Bearer token)

### Sesion segura (TASK-004)

- Access token de corta duracion (configurable con `ACCESS_TOKEN_TTL_MINUTES`, default 15 min).
- Refresh token rotatorio de larga duracion (configurable con `REFRESH_TOKEN_TTL_DAYS`, default 30 dias sliding).
- Refresh token almacenado hasheado en DB para revocacion y rotacion por uso.
- El refresh token nunca se expone a JavaScript; viaja solo en cookie HttpOnly.

## Channels endpoints (MVP)

- `GET /api/channels` (Bearer token)
- `GET /api/channels/discover?query=<text>` (Bearer token, búsqueda de canales activos)
- `POST /api/channels` (Bearer token, body: `{ "name": "general", "visibility": "PUBLIC" | "PRIVATE" }`)
- `POST /api/channels/:channelId/invitations` (Bearer token, solo OWNER en canales PRIVATE, body: `{ "username": "usuario" }` o `{ "email": "correo@dominio" }`)
- `POST /api/channels/:channelId/invitations/accept` (Bearer token, acepta invitación pendiente en canales PRIVATE)
- `POST /api/channels/:channelId/join` (Bearer token, público=join directo; privado=solo si existe invitación pendiente)
- `GET /api/channels/:channelId/members` (Bearer token, requiere membresía)
- `GET /api/channels/:channelId/requests` (Bearer token, solo OWNER, listado de invitaciones pendientes)
- `POST /api/channels/:channelId/requests/:requestId/approve` (Bearer token, solo OWNER, gestión manual opcional)
- `POST /api/channels/:channelId/requests/:requestId/deny` (Bearer token, solo OWNER, gestión manual opcional)

## Messages endpoints (MVP)

- `GET /api/channels/:channelId/messages?cursor=<messageId>&limit=30` (Bearer token, requiere membresía; incluye `viewerReceipt` por mensaje para el usuario autenticado)
- `POST /api/channels/:channelId/messages` (Bearer token, body: `{ "body": "hola" }`, requiere membresía)
- `POST /api/channels/:channelId/messages/:messageId/receipt` (Bearer token, body: `{ "status": "DELIVERED" | "READ" }`, requiere membresía)

## Presence endpoint (MVP)

- `GET /api/presence?channelId=<id>` (Bearer token, requiere membresía en el canal)

## Socket.IO (MVP)

- Namespace: `/chat`
- Auth en handshake: `auth: { token: <JWT> }`
- Eventos cliente -> servidor:
	- `channel:join` con `{ channelId }`
	- `message:send` con `{ channelId, body }`
	- `message:receipt` con `{ channelId, messageId, status: "DELIVERED" | "READ" }`
	- `typing:start` con `{ channelId }`
	- `typing:stop` con `{ channelId }`
- Eventos servidor -> cliente:
	- `channel:joined`
	- `message:new`
	- `message:receipt:update`
	- `presence:update`
	- `typing:update`
	- `system:message`

## Hardening básico

- Rate limiting en `/api` y límites más estrictos en `/api/auth`.
- Manejo global uniforme de errores (`404` y `500` JSON).
- Wrappers async en rutas para capturar excepciones de controladores.

## Siguiente paso sugerido

Implementar autenticación, canales y persistencia con PostgreSQL + Prisma.