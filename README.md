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

2. Levantar frontend + backend:

	```bash
	pnpm dev
	```

3. URLs:

- Web: http://localhost:5173
- API: http://localhost:4000

## Siguiente paso sugerido

Implementar autenticación, canales y persistencia con PostgreSQL + Prisma.