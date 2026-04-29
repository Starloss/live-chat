# Discoveries - Live Chat Gap Review

Date: 2026-04-22
Scope: Backend, Frontend, Security, QA
Method: Code review + specialist delegation

## Stakeholder Decisions (2026-04-22)
- DM 1:1 is a mandatory product capability.
- Private channels must be invitation-only.
- Session UX target: strong security with long-lived login experience (avoid frequent manual re-login).
- Member PII policy detail still open.

## Canonical Findings

### BE-001
- Severity: Critical
- Area: Backend Realtime Reliability
- Summary: Message send lacks idempotency key and deduplication guard, which can produce duplicates on retries/reconnect.
- Evidence:
  - [apps/api/src/socket/chat.socket.ts#L205](apps/api/src/socket/chat.socket.ts#L205)
  - [apps/api/src/modules/messages/messages.controller.ts#L73](apps/api/src/modules/messages/messages.controller.ts#L73)
  - [apps/api/prisma/schema.prisma#L70](apps/api/prisma/schema.prisma#L70)
- Impact: Duplicate messages and inconsistent timelines under unstable networks.

### BE-002
- Severity: Critical
- Area: Backend Product Completeness
- Summary: No delivery or read receipt model/events; not enough for WhatsApp-like message lifecycle.
- Evidence:
  - [apps/api/prisma/schema.prisma#L70](apps/api/prisma/schema.prisma#L70)
  - [apps/api/src/socket/chat.socket.ts#L247](apps/api/src/socket/chat.socket.ts#L247)
  - [README.md#L103](README.md#L103)
- Impact: No delivered/read state, unread reliability, or receipt UX.

### SEC-001
- Severity: Critical
- Area: Privacy / Authorization
- Summary: Channel discover returns metadata for private channels to authenticated users.
- Evidence:
  - [apps/api/src/modules/channels/channels.routes.ts#L21](apps/api/src/modules/channels/channels.routes.ts#L21)
  - [apps/api/src/modules/channels/channels.controller.ts#L269](apps/api/src/modules/channels/channels.controller.ts#L269)
  - [apps/api/src/modules/channels/channels.controller.ts#L321](apps/api/src/modules/channels/channels.controller.ts#L321)
- Impact: Privacy leak and channel enumeration risk.

### SEC-002
- Severity: High
- Area: Session Security
- Summary: Access token stored in localStorage and issued with long TTL (7d), increasing hijack window in XSS scenarios.
- Evidence:
  - [apps/web/src/App.tsx#L98](apps/web/src/App.tsx#L98)
  - [apps/web/src/App.tsx#L347](apps/web/src/App.tsx#L347)
  - [apps/api/src/modules/auth/auth.utils.ts#L13](apps/api/src/modules/auth/auth.utils.ts#L13)
- Impact: Session theft blast radius is high.

### SEC-003
- Severity: High
- Area: Abuse Prevention
- Summary: No socket-level rate limiting or per-event quotas for message and typing events.
- Evidence:
  - [apps/api/src/socket/chat.socket.ts#L205](apps/api/src/socket/chat.socket.ts#L205)
  - [apps/api/src/socket/chat.socket.ts#L251](apps/api/src/socket/chat.socket.ts#L251)
  - [apps/api/src/app.ts#L28](apps/api/src/app.ts#L28)
- Impact: Elevated DoS and spam risk.

### BE-003
- Severity: High
- Area: Scalability
- Summary: Presence and rate limit state are process-local (Map), not distributed for multi-instance deployment.
- Evidence:
  - [apps/api/src/socket/chat.socket.ts#L28](apps/api/src/socket/chat.socket.ts#L28)
  - [apps/api/src/middlewares/rate-limit.middleware.ts#L15](apps/api/src/middlewares/rate-limit.middleware.ts#L15)
  - [apps/api/src/index.ts#L10](apps/api/src/index.ts#L10)
- Impact: Inconsistent behavior when scaling horizontally.

### BE-004
- Severity: High
- Area: Backend Domain Model
- Summary: Domain is channel-centric only; no first-class DM/conversation model.
- Evidence:
  - [apps/api/prisma/schema.prisma#L26](apps/api/prisma/schema.prisma#L26)
  - [apps/api/src/app.ts#L31](apps/api/src/app.ts#L31)
- Impact: Cannot reach WhatsApp core UX without major later refactor.

### FE-001
- Severity: High
- Area: Frontend Realtime Stability
- Summary: Socket connection is recreated when selected channel changes.
- Evidence:
  - [apps/web/src/App.tsx#L183](apps/web/src/App.tsx#L183)
  - [apps/web/src/App.tsx#L255](apps/web/src/App.tsx#L255)
  - [apps/web/src/App.tsx#L258](apps/web/src/App.tsx#L258)
- Impact: Connection churn, transient event loss, and inconsistent presence behavior.

### FE-002
- Severity: High
- Area: Frontend Product Completeness
- Summary: Missing conversation UX primitives: unread counters, last message preview, ordering by recency.
- Evidence:
  - [apps/web/src/App.tsx#L14](apps/web/src/App.tsx#L14)
  - [apps/web/src/App.tsx#L638](apps/web/src/App.tsx#L638)
- Impact: Poor navigation and weak chat-product usability at scale.

### FE-003
- Severity: Medium
- Area: Frontend Message Timeline
- Summary: Cursor pagination exists in API shape but is not used in UI for infinite history.
- Evidence:
  - [apps/web/src/App.tsx#L271](apps/web/src/App.tsx#L271)
  - [apps/web/src/styles.css#L256](apps/web/src/styles.css#L256)
- Impact: Limited history UX and degraded performance for large conversations.

### FE-004
- Severity: Medium
- Area: Frontend Accessibility
- Summary: Inputs rely on placeholders and dynamic updates lack explicit live region semantics.
- Evidence:
  - [apps/web/src/App.tsx#L533](apps/web/src/App.tsx#L533)
  - [apps/web/src/App.tsx#L709](apps/web/src/App.tsx#L709)
- Impact: Accessibility debt and compliance risk.

### QA-001
- Severity: Critical
- Area: Test Quality
- Summary: Test suite is smoke-only and does not cover core business/realtime flows.
- Evidence:
  - [apps/api/tests/api.smoke.test.ts#L5](apps/api/tests/api.smoke.test.ts#L5)
  - [apps/api/tests/api.smoke.test.ts#L32](apps/api/tests/api.smoke.test.ts#L32)
- Impact: High regression risk across auth, channels, socket, and messaging.

### OPS-001
- Severity: Medium
- Area: Operability
- Summary: Health endpoint returns static ok and does not validate critical dependencies.
- Evidence:
  - [apps/api/src/app.ts#L35](apps/api/src/app.ts#L35)
  - [apps/api/src/app.ts#L36](apps/api/src/app.ts#L36)
- Impact: False-positive health under partial outages.

### SEC-004
- Severity: Medium
- Area: Data Minimization
- Summary: Member listing includes emails for channel members.
- Evidence:
  - [apps/api/src/modules/channels/channels.controller.ts#L239](apps/api/src/modules/channels/channels.controller.ts#L239)
  - [apps/api/src/modules/channels/channels.controller.ts#L249](apps/api/src/modules/channels/channels.controller.ts#L249)
- Impact: Unnecessary PII exposure.

## Deduplication Notes
- Backend and security reviews reported the same privacy issue for discover; canonicalized as SEC-001.
- Backend and QA reviews reported insufficient realtime reliability controls; canonicalized as BE-001, SEC-003, QA-001.
- Frontend and QA reviews both flagged socket lifecycle churn; canonicalized as FE-001.

## Execution Findings Update (2026-04-22 - Phase 1 TASK-001)

### QA-T001-001
- Severity: High
- Area: Realtime consistency
- Summary: Riesgo de inconsistencia cross-transport si un mensaje es creado por HTTP y luego llega retry deduplicado por socket sin emisión realtime.
- Status: Mitigated in implementation hardening (socket emite `message:new` también en deduplicados).
- Evidence:
  - [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts)

### QA-T001-002
- Severity: High
- Area: Test coverage
- Summary: No había cobertura socket de contrato idempotente para `clientMessageId`.
- Status: Mitigated (se agregaron pruebas de integración socket TASK-001).
- Evidence:
  - [apps/api/tests/messages.socket.task001.test.ts](apps/api/tests/messages.socket.task001.test.ts)

### QA-T001-003
- Severity: Medium
- Area: API/socket contract clarity
- Summary: `clientMessageId` no estaba reflejado en respuestas/acks, dificultando correlación cliente.
- Status: Mitigated (respuestas/acks incluyen `clientMessageId` y `deduplicated`).
- Evidence:
  - [apps/api/src/modules/messages/messages.controller.ts](apps/api/src/modules/messages/messages.controller.ts)
  - [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts)

### QA-T001-004
- Severity: Medium
- Area: Validation completeness
- Summary: Validación runtime y concurrencia de TASK-001 estaban bloqueadas por infraestructura local.
- Status: Mitigated (DB local operativa y suites TASK-001 API/socket validadas).
- Evidence:
  - [apps/api/tests/messages.task001.test.ts](apps/api/tests/messages.task001.test.ts)
  - [apps/api/tests/messages.socket.task001.test.ts](apps/api/tests/messages.socket.task001.test.ts)

## Execution Findings Update (2026-04-22 - Phase 1 TASK-002)

### QA-T002-001
- Severity: High
- Area: Realtime reliability
- Summary: Riesgo de ACK colgado en `message:receipt` ante errores inesperados del servidor.
- Status: Mitigated (handler ahora responde `INTERNAL_ERROR` en errores no tipados).
- Evidence:
  - [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts)
  - [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts)

### QA-T002-002
- Severity: Medium
- Area: Test coverage
- Summary: Faltaban casos de borde para receipts (BAD_PAYLOAD, RATE_LIMITED, INTERNAL_ERROR, 400/401, READ-first, privacidad de viewerReceipt).
- Status: Mitigated (se agregaron casos en suites TASK-002 API y socket).
- Evidence:
  - [apps/api/tests/messages.task002.test.ts](apps/api/tests/messages.task002.test.ts)
  - [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts)

### QA-T002-003
- Severity: Medium
- Area: Validation completeness
- Summary: Validación runtime E2E de TASK-002 estaba bloqueada por indisponibilidad de DB local.
- Status: Mitigated (DB local operativa y suites TASK-002 API/socket validadas).
- Evidence:
  - [apps/api/tests/messages.task002.test.ts](apps/api/tests/messages.task002.test.ts)
  - [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts)

### QA-T002-004
- Severity: Medium
- Area: Test stability
- Summary: Suites socket de TASK-001/TASK-002 presentaban inestabilidad por teardown no idempotente y colisiones de fixtures de usuario.
- Status: Mitigated (teardown defensivo y aislamiento de username en pruebas socket).
- Evidence:
  - [apps/api/tests/messages.socket.task001.test.ts](apps/api/tests/messages.socket.task001.test.ts)
  - [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts)

### SEC-T002-001
- Severity: Medium
- Area: Error handling / information disclosure
- Summary: Middleware global de errores HTTP puede devolver detalles internos en respuestas 500.
- Status: Mitigated (respuestas 500 sanitizadas para cliente y logging interno estructurado).
- Evidence:
  - [apps/api/src/middlewares/error.middleware.ts](apps/api/src/middlewares/error.middleware.ts)
  - [apps/api/src/modules/messages/messages.controller.ts](apps/api/src/modules/messages/messages.controller.ts)
  - [apps/api/tests/api.smoke.test.ts](apps/api/tests/api.smoke.test.ts)

### SEC-T002-002
- Severity: Low
- Area: Resource enumeration signal
- Summary: Diferenciación 404/403 en middleware de membresía puede filtrar señal de existencia de canal.
- Status: Mitigated (scope sensible estandarizado a 404 indistinguible para no revelar existencia).
- Evidence:
  - [apps/api/src/middlewares/channel-membership.middleware.ts](apps/api/src/middlewares/channel-membership.middleware.ts)
  - [apps/api/src/modules/channels/channels.routes.ts](apps/api/src/modules/channels/channels.routes.ts)
  - [apps/api/tests/channels.task003.test.ts](apps/api/tests/channels.task003.test.ts)

### SEC-T002-003
- Severity: Low
- Area: Input hardening
- Summary: Validación de `channelId`/`messageId` en schemas de receipts es mínima (solo no vacío).
- Status: Mitigated (validación estricta CUID para IDs de receipts en HTTP y socket).
- Evidence:
  - [apps/api/src/modules/messages/message-receipt.schema.ts](apps/api/src/modules/messages/message-receipt.schema.ts)
  - [apps/api/tests/messages.task002.test.ts](apps/api/tests/messages.task002.test.ts)
  - [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts)

## Execution Findings Update (2026-04-29 - Phase 0 TASK-005)

### QA-T005-001
- Severity: Medium
- Area: Anti-abuse load validation
- Summary: Faltaba evidencia de burst/flood real en integración socket para confirmar comportamiento RATE_LIMITED bajo carga concurrente.
- Status: Mitigated (se agregó suite de integración flood con validación de throttling y estabilidad post-flood).
- Evidence:
  - [apps/api/tests/socket.task005.flood.test.ts](apps/api/tests/socket.task005.flood.test.ts)
  - [apps/api/tests/socket-event-rate-limiter.test.ts](apps/api/tests/socket-event-rate-limiter.test.ts)

### QA-T007-001
- Severity: Low
- Area: Validation environment dependency
- Summary: Re-ejecución de regresiones socket DB-backed estaba condicionada por disponibilidad local de Docker/Postgres.
- Status: Mitigated (re-runs DB-backed completados con Docker activo; suites socket en verde).
- Evidence:
  - [apps/api/tests/messages.socket.task001.test.ts](apps/api/tests/messages.socket.task001.test.ts)
  - [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts)

### QA-T007-002
- Severity: Low
- Area: Frontend E2E gate
- Summary: TASK-007 requería un E2E mínimo frontend para cerrar la matriz crítica.
- Status: Mitigated (Playwright E2E integrado y ejecutado en verde con flujo crítico determinista).
- Evidence:
  - [apps/web/e2e/critical-flow.spec.ts](apps/web/e2e/critical-flow.spec.ts)
  - [apps/web/playwright.config.ts](apps/web/playwright.config.ts)
  - [apps/web/package.json](apps/web/package.json)

## Execution Findings Update (2026-04-29 - Frontend TASK-009/010/011/012 Slices)

### FE-T009-001
- Severity: High
- Area: Frontend realtime lifecycle
- Summary: Conexión socket se recreaba en cambios de canal.
- Status: Mitigated in slice (una conexión por sesión y join/leave por scope implementado).
- Evidence:
  - [apps/web/src/App.tsx](apps/web/src/App.tsx)

### FE-T010-001
- Severity: Medium
- Area: Conversation list parity
- Summary: Faltaban preview de último mensaje, contador de no leídos y orden por actividad.
- Status: In Progress (primitivas implementadas con estrategia de snapshot periódico; queda afinado de precisión en no leídos).
- Evidence:
  - [apps/web/src/App.tsx](apps/web/src/App.tsx)
  - [apps/web/src/styles.css](apps/web/src/styles.css)

### FE-T011-001
- Severity: Medium
- Area: Timeline pagination
- Summary: El cursor del API no estaba integrado en UI para historial incremental.
- Status: In Progress (load-more por cursor y merge sin duplicados implementado; falta cobertura automatizada adicional).
- Evidence:
  - [apps/web/src/App.tsx](apps/web/src/App.tsx)

### FE-T012-001
- Severity: Medium
- Area: Accessibility
- Summary: Faltaban labels explícitos, foco visible consistente y región aria-live para actualizaciones dinámicas.
- Status: In Progress (mejoras base aplicadas; pendiente corrida de escáner a11y automatizado).
- Evidence:
  - [apps/web/src/App.tsx](apps/web/src/App.tsx)
  - [apps/web/src/styles.css](apps/web/src/styles.css)

## Execution Findings Update (2026-04-29 - Residual Security/Operations)

### SEC-T013-001
- Severity: Medium
- Area: Dependency hardening
- Summary: `pnpm audit --prod` reporta vulnerabilidades transitorias altas (socket.io-parser/path-to-regexp/effect/defu) que requieren ola de actualización coordinada.
- Status: Open (mitigación pendiente por upgrade de dependencias y revalidación completa).
- Evidence:
  - [apps/api/package.json](apps/api/package.json)
  - [pnpm-lock.yaml](pnpm-lock.yaml)

## Execution Findings Update (2026-04-29 - Phase 1 TASK-008 M1)

### BE-T008-001
- Severity: High
- Area: Domain model migration
- Summary: TASK-008 requería bootstrap de Conversation/ConversationParticipant sin romper paths legacy de channels/messages.
- Status: Mitigated in M1 (schema aditivo + migration/backfill/triggers de compatibilidad implementados).
- Evidence:
  - [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma)
  - [apps/api/prisma/migrations/20260429173000_conversations_m1/migration.sql](apps/api/prisma/migrations/20260429173000_conversations_m1/migration.sql)

### QA-T008-001
- Severity: Medium
- Area: Validation completeness
- Summary: Validación runtime DB-backed de `prisma migrate deploy` y regresión de mensajes para M1 se completó en entorno local con Docker/Postgres disponible.
- Status: Mitigated (migración aplicada y suites críticas DB-backed en verde).
- Evidence:
  - [apps/api/prisma/migrations/20260429173000_conversations_m1/migration.sql](apps/api/prisma/migrations/20260429173000_conversations_m1/migration.sql)
  - [apps/api/tests/messages.task001.test.ts](apps/api/tests/messages.task001.test.ts)
  - [apps/api/tests/messages.socket.task001.test.ts](apps/api/tests/messages.socket.task001.test.ts)
  - [apps/api/tests/messages.task002.test.ts](apps/api/tests/messages.task002.test.ts)
  - [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts)
