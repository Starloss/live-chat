# Implementation Plan - Live Chat toward WhatsApp-like Experience

## Metadata
- Date: 2026-04-22
- Repository: live-chat
- Scope: Backend + Frontend + Security + QA
- Mode: Orchestration
- Approval Status: Approved (Phase 0 + Phase 1 kickoff)
- Approved By: Product Owner (Usuario) - 2026-04-22
- Execution Scope: Phase 1 (TASK-008 ready for implementation under locked defaults)

## Traceability Matrix
| Finding ID | Summary | Severity | Planned Task IDs |
|---|---|---|---|
| BE-001 | Idempotency missing in message send | Critical | TASK-001 |
| BE-002 | No delivery/read receipts | Critical | TASK-002 |
| SEC-001 | Private channel enumeration in discover | Critical | TASK-003 |
| QA-001 | Smoke-only tests | Critical | TASK-007 |
| SEC-002 | JWT in localStorage + long TTL | High | TASK-004 |
| SEC-003 | No socket abuse controls | High | TASK-005 |
| BE-003 | Process-local state, no distributed realtime | High | TASK-006 |
| BE-004 | Missing DM conversation model | High | TASK-008 |
| FE-001 | Socket recreated on channel switch | High | TASK-009 |
| FE-002 | Missing conversation UX primitives | High | TASK-010 |
| FE-003 | Cursor not used in timeline | Medium | TASK-011 |
| FE-004 | Accessibility debt | Medium | TASK-012 |
| OPS-001 | Shallow health/readiness | Medium | TASK-013 |
| SEC-004 | Member email overexposure | Medium | TASK-003 |

## Phases Overview
| Phase | Objective | Exit Criteria | Dependency Gate |
|---|---|---|---|
| Phase 0 | Security/privacy hardening and private channels by invitation | Security-critical items closed and validated in staging | Approved |
| Phase 1 | Realtime reliability and DM 1:1 foundation | Message lifecycle stable and DM domain base available | Phase 0 complete |
| Phase 2 | Reach chat-product usability parity | Conversation UX supports high-volume usage | Phase 1 complete |
| Phase 3 | Raise release confidence and operability | CI, observability, and load readiness in place | Phase 2 complete |

## Task Board
| Task ID | Title | Phase | Priority | Owner Profile | Estimate | Dependencies | Status |
|---|---|---|---|---|---|---|---|
| TASK-001 | Message idempotency and dedupe | Phase 1 | P0 | Senior Backend Specialist | 2-3 days | None | Completed (runtime validation passed locally) |
| TASK-002 | Delivery and read receipts | Phase 1 | P0 | Senior Backend Specialist | 3-5 days | TASK-001 | Completed (runtime validation passed locally) |
| TASK-003 | Invitation-only private channels + PII minimization | Phase 0 | P0 | Senior Backend Specialist + Cybersecurity Specialist | 2-3 days | None | Completed (runtime validation passed locally) |
| TASK-004 | Session hardening (short access + rotating refresh) | Phase 0 | P0 | Senior Backend Specialist + Cybersecurity Specialist + Senior Frontend Specialist | 4-6 days | None | Completed (runtime validation passed locally) |
| TASK-005 | Socket anti-abuse controls | Phase 0 | P0 | Senior Backend Specialist + Cybersecurity Specialist | 2-3 days | None | In Review (unit + targeted socket validation passed; load validation pending) |
| TASK-006 | Distributed realtime state (Redis adapter) | Phase 1 | P1 | Senior Backend Specialist | 2-4 days | TASK-005 | Not Started |
| TASK-007 | Critical test matrix (API + socket + E2E) | Phase 0 | P0 | QA Specialist | 3-5 days | TASK-003, TASK-004, TASK-005 | In Progress (critical backend suites green locally; E2E pending) |
| TASK-008 | Conversation/DM domain model (mandatory) | Phase 1 | P0 | Senior Backend Specialist | 5-8 days | TASK-001, TASK-002 | Ready for Implementation (M1 schema/backfill + dual-path kickoff) |
| TASK-009 | Stable socket lifecycle in UI | Phase 1 | P1 | Senior Frontend Specialist | 1-2 days | TASK-004 | Not Started |
| TASK-010 | Conversation list parity features | Phase 2 | P1 | Senior Frontend Specialist | 3-4 days | TASK-008, TASK-009 | Not Started |
| TASK-011 | Infinite history with cursor sync | Phase 2 | P2 | Senior Frontend Specialist + Senior Backend Specialist | 2-3 days | TASK-001, TASK-009 | Not Started |
| TASK-012 | Accessibility remediation (forms/live updates) | Phase 2 | P2 | Senior Frontend Specialist + QA Specialist | 1-2 days | TASK-010 | Not Started |
| TASK-013 | Readiness endpoint and observability baseline | Phase 3 | P2 | Senior Backend Specialist + QA Specialist | 1-2 days | TASK-006 | Not Started |

## Task Details
### TASK-001 - Message idempotency and dedupe
- Objective: Prevent duplicate messages under client retries and reconnects.
- Finding IDs: BE-001
- Scope In: API + socket contract for clientMessageId, DB uniqueness strategy, idempotent writes.
- Scope Out: UI read receipt design.
- Dependencies: None.
- Validation: Concurrency and retry integration tests, duplicate-send replay tests.
- Rollback: Feature flag to fallback on old send path if contract mismatch occurs.
- Exit Criteria: Repeated submits for same clientMessageId produce single persisted message.

### TASK-002 - Delivery and read receipts
- Objective: Support delivered and read states per message/recipient.
- Finding IDs: BE-002
- Scope In: Data model, server events, API sync endpoint, DTO updates.
- Scope Out: Notification push strategy.
- Dependencies: TASK-001.
- Validation: Two-client E2E showing sent/delivered/read transitions.
- Rollback: Keep existing message:new path while receipt events are disabled via flag.
- Exit Criteria: Deterministic receipt state transitions validated end-to-end.

### TASK-003 - Invitation-only private channels + PII minimization
- Objective: Enforce invitation-only access for private channels and remove unnecessary member PII exposure.
- Finding IDs: SEC-001, SEC-004
- Scope In: Discover query policy, private join guard, invitation workflow (owner invites, member accepts), channel member DTO minimization.
- Scope Out: Multi-use invite links and deep invite analytics.
- Dependencies: None.
- Validation: Access matrix tests for public/private channels, invite-only acceptance tests, and member payload snapshots.
- Rollback: Safe default restrict mode to public-only discover.
- Exit Criteria: Non-member users cannot enumerate private channels; private join works only through valid invitation; member emails are not exposed by default.

### TASK-004 - Session hardening (short access + rotating refresh)
- Objective: Maximize security while preserving UX with long-lived sessions without frequent re-login.
- Finding IDs: SEC-002
- Scope In: Short-lived access token, rotating refresh tokens with sliding session window, secure token storage strategy update in web.
- Scope Out: SSO and external identity providers.
- Dependencies: None.
- Validation: Login/refresh/logout/device revoke tests, threat checks, and long-session UX validation.
- Rollback: Temporary compatibility mode accepting old token format during migration window.
- Exit Criteria: Session revocation and rotation operational with secure storage, and users can remain signed in for long periods without manual re-login.

### TASK-005 - Socket anti-abuse controls
- Objective: Protect realtime channel from spam and event flooding.
- Finding IDs: SEC-003
- Scope In: Per-event quotas, per-user/IP controls, abuse-safe acknowledgments.
- Scope Out: WAF-level protections.
- Dependencies: None.
- Validation: Load tests for typing/message flood and expected throttling behavior.
- Rollback: Runtime-configurable limits with fallback thresholds.
- Exit Criteria: Flood attempts are throttled and service remains healthy.

### TASK-006 - Distributed realtime state (Redis adapter)
- Objective: Make presence, rooms, and throttling coherent across multiple instances.
- Finding IDs: BE-003
- Scope In: Socket.IO adapter, shared state primitives, deploy configuration.
- Scope Out: Multi-region replication.
- Dependencies: TASK-005.
- Validation: Multi-instance testbed with consistent fanout/presence behavior.
- Rollback: Single-instance fallback profile documented and tested.
- Exit Criteria: Realtime behavior is consistent with two or more API instances.

### TASK-007 - Critical test matrix (API + socket + E2E)
- Objective: Raise confidence and prevent regressions in critical chat workflows.
- Finding IDs: QA-001
- Scope In: API integration tests, socket integration tests, minimal frontend E2E.
- Scope Out: Full visual regression suite.
- Dependencies: TASK-003, TASK-004, TASK-005.
- Validation: CI gates for tests and failure snapshots.
- Rollback: Keep smoke tests as fallback gate while new suites stabilize.
- Exit Criteria: Critical paths covered and required by CI.

### TASK-008 - Conversation/DM domain model (mandatory)
- Objective: Add first-class direct messages and conversation abstraction as required product capability.
- Finding IDs: BE-004
- Scope In: Conversation + ConversationParticipant entities, CHANNEL wrapper coexistence strategy, DIRECT 1:1 creation/reuse, conversation-scoped API/socket contracts, and phased migration (M1-M4).
- Scope Out: End-to-end encryption.
- Dependencies: TASK-001, TASK-002.
- Validation: DM creation/reuse race tests, conversation-scoped send/read/receipt tests, authorization matrix, and no-regression legacy channel contract tests.
- Rollback: Feature flags (`conversations_enabled`, `socket_conversation_payload_enabled`, `require_conversation_id_writes`) preserving channel-only mode.
- Exit Criteria: DM conversations functionally equivalent to group threads for core flows, with backward compatibility maintained during migration window.

### TASK-009 - Stable socket lifecycle in UI
- Objective: Keep one socket connection per authenticated session and room-level joins.
- Finding IDs: FE-001
- Scope In: Effect dependency refactor, join/leave strategy, reconnect recovery hooks.
- Scope Out: Visual redesign.
- Dependencies: TASK-004.
- Validation: Frontend integration tests on channel switch and reconnect.
- Rollback: Keep current behavior toggle if runtime regressions appear.
- Exit Criteria: Channel switching no longer reconnects socket transport.

### TASK-010 - Conversation list parity features
- Objective: Improve usability with last message, unread counters, and activity sorting.
- Finding IDs: FE-002
- Scope In: Conversation list DTO/state, unread sync strategy, UI indicators.
- Scope Out: Rich media and attachments.
- Dependencies: TASK-008, TASK-009.
- Validation: UX acceptance checklist and E2E conversation navigation tests.
- Rollback: Hide new indicators behind feature flag if data contract fails.
- Exit Criteria: Users can prioritize active chats similarly to WhatsApp behavior.

### TASK-011 - Infinite history with cursor sync
- Objective: Support scalable message browsing and reconnection gap recovery.
- Finding IDs: FE-003
- Scope In: Cursor pagination on UI, scroll loading, duplicate-guard merge logic.
- Scope Out: Full-text search.
- Dependencies: TASK-001, TASK-009.
- Validation: Long-history performance tests and reconnect catch-up tests.
- Rollback: Fall back to fixed latest page fetch.
- Exit Criteria: Users can load older messages without timeline corruption.

### TASK-012 - Accessibility remediation
- Objective: Raise baseline accessibility for forms and live messaging updates.
- Finding IDs: FE-004
- Scope In: Labels, focus states, semantic announcements for dynamic updates.
- Scope Out: Localization overhaul.
- Dependencies: TASK-010.
- Validation: Keyboard-only QA and automated a11y scans.
- Rollback: Keep current markup while rolling changes in slices.
- Exit Criteria: Core flows usable with keyboard/screen reader.

### TASK-013 - Readiness and observability baseline
- Objective: Improve operational visibility and incident detection.
- Finding IDs: OPS-001
- Scope In: Readiness checks (DB), structured logs, basic metrics and dashboards.
- Scope Out: Full distributed tracing platform migration.
- Dependencies: TASK-006.
- Validation: Chaos drills (DB unavailable) and alerting dry run.
- Rollback: Keep existing health endpoint as liveness while readiness rolls out.
- Exit Criteria: Health signals reflect dependency state and support release gating.

## Risks and Blockers
- Phase 0 completion gate is partially open: TASK-005 still requires explicit load/flood validation evidence under sustained traffic.
- Residual cross-cutting security risk: HTTP 500 responses may expose internal error details via global error middleware; follow-up hardening required before release gate.
- Distributed hardening gap: socket event rate limiting remains process-local (single-instance effective, multi-instance bypass risk) until TASK-006.
- Product policy override risk: TASK-008 starts with locked defaults; any post-kickoff change request may force migration/API adjustments.

## Decisions Needed
- None pending for TASK-008 kickoff. Locked defaults:
1. Private-channel invitations remain username-only.
2. Owner/member views keep emails hidden by default.
3. Unauthorized/not-found responses for privacy-sensitive channel and conversation scopes standardize to indistinguishable `404`.
4. Self-DM is blocked by default in v1.
5. `/api/conversations` v1 scope is unified (DIRECT + CHANNEL wrapper) with type filtering.
6. DM creation identifier is `withUserId` only in v1.
7. DM endpoint/event authorization follows indistinguishable `404` policy for non-participants.

## Specialist Delegation Log
- 2026-04-22 - Project Manager Specialist - Phase 1 kickoff governance
	- Execution scope moved to Phase 1 with TASK-001 as critical-path start, preserving Phase 0 validation blocker traceability.
	- Evidence: [.github/reviews/implementation-plan.md](.github/reviews/implementation-plan.md).
- 2026-04-22 - Senior Backend Specialist - TASK-001 implement
	- Added message idempotency via `clientMessageId` across data model and message creation paths (HTTP + socket), with new TASK-001 integration tests.
	- Evidence: [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma), [apps/api/src/modules/messages/message-idempotency.ts](apps/api/src/modules/messages/message-idempotency.ts), [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts), [apps/api/tests/messages.task001.test.ts](apps/api/tests/messages.task001.test.ts).
- 2026-04-22 - QA Specialist - TASK-001 review
	- Reported HIGH risks in realtime cross-transport consistency and missing socket-level contract coverage for idempotency.
	- Evidence: [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts), [apps/api/tests/messages.task001.test.ts](apps/api/tests/messages.task001.test.ts).
- 2026-04-22 - Senior Backend Specialist - TASK-001 hardening after QA
	- Extended HTTP/socket contracts with `clientMessageId` and `deduplicated`; added socket integration tests and aligned realtime policy for deduplicated retries.
	- Evidence: [apps/api/src/modules/messages/messages.controller.ts](apps/api/src/modules/messages/messages.controller.ts), [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts), [apps/api/tests/messages.socket.task001.test.ts](apps/api/tests/messages.socket.task001.test.ts).
- 2026-04-22 - Senior Backend Specialist - TASK-003 implement
	- Implemented private invitation workflow (owner invites, user accepts), private join guard, discover filtering, and member DTO PII minimization.
	- Evidence: [apps/api/src/modules/channels/channels.controller.ts](apps/api/src/modules/channels/channels.controller.ts), [apps/api/src/modules/channels/channels.routes.ts](apps/api/src/modules/channels/channels.routes.ts), [apps/api/tests/channels.task003.test.ts](apps/api/tests/channels.task003.test.ts).
- 2026-04-22 - Cybersecurity Specialist - TASK-003 security review
	- Flagged user/channel enumeration and remaining PII exposure risks; recommended response hardening.
- 2026-04-22 - Senior Backend Specialist - TASK-003 hardening
	- Applied generic invite responses, private join/accept indistinguishable errors for unauthorized users, and removed email from owner requests DTO.
	- Evidence: [apps/api/src/modules/channels/channels.controller.ts](apps/api/src/modules/channels/channels.controller.ts), [apps/api/tests/channels.task003.test.ts](apps/api/tests/channels.task003.test.ts).
- 2026-04-22 - Cybersecurity Specialist - TASK-004 security review
	- Reported 3 HIGH findings (refresh race/reuse handling, token-expiry enforcement on socket, dual token field contract) and requested hardening before closure.
- 2026-04-22 - Senior Backend Specialist - TASK-004 hardening
	- Added atomic refresh consume + reuse kill-switch, enforced token expiry through socket lifecycle, and standardized auth payloads to `accessToken` only.
	- Evidence: [apps/api/src/modules/auth/auth.controller.ts](apps/api/src/modules/auth/auth.controller.ts), [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts), [apps/api/tests/auth.task004.test.ts](apps/api/tests/auth.task004.test.ts).
- 2026-04-22 - Senior Backend Specialist - TASK-005 implement
	- Added per-event socket rate limiter and RATE_LIMITED acknowledgments, with dedicated unit test coverage.
	- Evidence: [apps/api/src/socket/socket-event-rate-limiter.ts](apps/api/src/socket/socket-event-rate-limiter.ts), [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts), [apps/api/tests/socket-event-rate-limiter.test.ts](apps/api/tests/socket-event-rate-limiter.test.ts).
- 2026-04-22 - Senior Frontend Specialist - TASK-004/TASK-003 alignment
	- Migrated web session flow to silent refresh with in-memory access token and aligned private discover/join UX to invitation-only behavior.
	- Evidence: [apps/web/src/App.tsx](apps/web/src/App.tsx).
- 2026-04-22 - Senior Backend Specialist - TASK-002 implement
	- Added MessageReceipt domain model + migration, receipt transition service, HTTP sync endpoint, socket receipt event, viewerReceipt DTO, and TASK-002 API/socket tests.
	- Evidence: [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma), [apps/api/src/modules/messages/message-receipts.ts](apps/api/src/modules/messages/message-receipts.ts), [apps/api/src/modules/messages/messages.controller.ts](apps/api/src/modules/messages/messages.controller.ts), [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts), [apps/api/tests/messages.task002.test.ts](apps/api/tests/messages.task002.test.ts), [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts).
- 2026-04-22 - QA Specialist - TASK-002 review
	- Reported HIGH risk on socket `message:receipt` ACK reliability under unexpected errors and identified coverage gaps for payload/rate-limit/internal-error and HTTP edge cases.
	- Evidence: [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts), [apps/api/tests/messages.task002.test.ts](apps/api/tests/messages.task002.test.ts), [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts).
- 2026-04-22 - Senior Backend Specialist - TASK-002 hardening after QA
	- Ensured deterministic ACK on unexpected socket errors (`INTERNAL_ERROR`) and expanded TASK-002 API/socket coverage (BAD_PAYLOAD, RATE_LIMITED, INTERNAL_ERROR, READ-first, 400/401, viewerReceipt privacy).
	- Evidence: [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts), [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts), [apps/api/tests/messages.task002.test.ts](apps/api/tests/messages.task002.test.ts).
- 2026-04-22 - QA Specialist - TASK-002 re-review
	- Marked TASK-002 as In Review with no blocking QA findings ahead of runtime wave; findings remained non-blocking after local DB validation.
	- Evidence: [apps/api/src/socket/chat.socket.ts](apps/api/src/socket/chat.socket.ts), [apps/api/tests/messages.task002.test.ts](apps/api/tests/messages.task002.test.ts), [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts).
- 2026-04-22 - Cybersecurity Specialist - TASK-002 security review
	- Flagged medium cross-cutting risk on HTTP 500 error-detail exposure and low hardening items (403/404 signal, receipt ID validation strictness, distributed rate-limit enforcement).
	- Evidence: [apps/api/src/middlewares/error.middleware.ts](apps/api/src/middlewares/error.middleware.ts), [apps/api/src/middlewares/channel-membership.middleware.ts](apps/api/src/middlewares/channel-membership.middleware.ts), [apps/api/src/modules/messages/message-receipt.schema.ts](apps/api/src/modules/messages/message-receipt.schema.ts), [apps/api/src/socket/socket-event-rate-limiter.ts](apps/api/src/socket/socket-event-rate-limiter.ts).
- 2026-04-22 - QA Specialist - Runtime validation wave (TASK-001/002/003/004/005)
	- Unblocked local DB runtime validation, executed critical backend suites with DB-backed evidence, and isolated remaining socket-suite stability issue.
	- Evidence: [apps/api/tests/channels.task003.test.ts](apps/api/tests/channels.task003.test.ts), [apps/api/tests/auth.task004.test.ts](apps/api/tests/auth.task004.test.ts), [apps/api/tests/messages.task001.test.ts](apps/api/tests/messages.task001.test.ts), [apps/api/tests/messages.task002.test.ts](apps/api/tests/messages.task002.test.ts), [apps/api/tests/socket-event-rate-limiter.test.ts](apps/api/tests/socket-event-rate-limiter.test.ts).
- 2026-04-22 - QA Specialist - Socket suite stabilization
	- Fixed test teardown idempotency and user fixture uniqueness in socket suites; both TASK-001 and TASK-002 socket suites now pass locally.
	- Evidence: [apps/api/tests/messages.socket.task001.test.ts](apps/api/tests/messages.socket.task001.test.ts), [apps/api/tests/messages.socket.task002.test.ts](apps/api/tests/messages.socket.task002.test.ts).
- 2026-04-22 - Senior Backend Specialist - TASK-008 discovery document
	- Delivered actionable design for Conversation/DM: Prisma model proposal, API/socket compatibility strategy, phased migration plan (M1-M4), test matrix, and PM decision set.
	- Evidence: [.github/reviews/implementation-plan.md](.github/reviews/implementation-plan.md).
- 2026-04-22 - Project Manager Specialist - TASK-008 decision lock
	- Applied default product-policy decisions to remove PM blockers and move TASK-008 to implementation-ready state.
	- Evidence: [.github/reviews/implementation-plan.md](.github/reviews/implementation-plan.md).

## Change Log
- 2026-04-22: Initial plan generated from specialist discovery findings.
- 2026-04-22: Plan approved for Phase 0 and aligned to product decisions (DM mandatory, private channels invitation-only).
- 2026-04-22: TASK-003 implemented and hardened; awaiting DB-backed integration validation.
- 2026-04-22: TASK-004 implemented and hardened after security review; pending DB-backed integration validation.
- 2026-04-22: TASK-005 implemented with unit tests passing; pending integration validation in DB-enabled environment.
- 2026-04-22: Frontend aligned to invitation-only private flow and no-email owner request DTO.
- 2026-04-22: Stakeholder approved continuation into Phase 1; TASK-001 started under controlled gate exception while Phase 0 runtime validation remains pending.
- 2026-04-22: TASK-001 implemented (schema + idempotent persistence + socket/api contracts) and moved to QA review.
- 2026-04-22: TASK-001 hardening applied from QA findings with socket integration tests added; pending DB-backed runtime validation.
- 2026-04-22: TASK-002 implemented end-to-end in backend (schema, API, socket, tests) and moved to QA review.
- 2026-04-22: TASK-002 hardening applied from QA findings (socket ACK reliability + expanded edge-case coverage).
- 2026-04-22: QA re-review marked TASK-002 as In Review with no blocking functional findings.
- 2026-04-22: Security review reported cross-cutting HTTP 500 error-detail exposure and non-blocking hardening follow-ups.
- 2026-04-22: Local DB runtime validation wave completed; TASK-001/002/003/004 promoted to Completed and socket suites stabilized.
- 2026-04-22: Phase 1 advanced to TASK-008 discovery for mandatory DM/conversation domain model.
- 2026-04-22: TASK-008 discovery document consolidated and decisions required updated before M1 implementation.
- 2026-04-22: PM locked TASK-008 product defaults and removed decision blockers; execution scope moved to implementation-ready.
