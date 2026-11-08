# Implementation plan: TypeScript + NestJS

This plan follows the roadmap in the root `README.md` (section 17). Phases are the same; this file adds the
TypeScript-specific choices, the breakdown of each phase, and what is done.

Legend: `[x]` done and verified · `[~]` written but not run by the author (needs your first run) · `[ ]` not started

## 1. Stack decisions (change any of them now, it gets expensive later)

| Concern | Choice | Why / alternative |
|---|---|---|
| Language / runtime | TypeScript 6, Node 24, ESM modules | Nest 12 is ESM-only. Relative imports end in `.js` (see `TOOLING.md`) |
| Framework | NestJS 12 on the **Fastify** adapter | README lists Fastify for `fast-json-stringify`; Express is the alternative |
| Package manager | pnpm 12 workspace (`services/*/ts-nestjs`) | One lockfile, shared `node_modules` store |
| Validation (DTOs) | `class-validator` + `class-transformer` | Annotation style, mirrors the Java/C# DTOs in the README |
| Config | own loader + `zod` | Layered defaults, profile, env, `*_FILE` secrets, fail fast |
| ORM / migrations | **TypeORM** (explicit SQL migrations) | Has entity subscribers (needed for the README's ORM-listener audit) and `SKIP LOCKED`. Alternative: Prisma |
| Logging | `pino` JSON + PII redaction | OpenTelemetry log export is added in step 1.7 |
| Lint / format / types | `oxlint`, `prettier`, `tsc --strict` | `oxlint` is what Nest 12's generator ships; ESLint is the alternative |
| Tests | `vitest` (unit), Testcontainers (integration), Hurl (e2e, later) | Testcontainers needs Docker Desktop running |
| i18n | tiny own service over `contracts/i18n/*.json` | Keeps the shared message keys authoritative |

## 2. Phase 0: contracts, infrastructure, skeleton

- [x] Repo layout (README section 13), pnpm workspace, `.gitattributes` (LF endings), `.editorconfig`
- [x] Contracts for account-service: `openapi/account.yaml`, `proto/account/v1/account.proto`, `avro/*.avsc` (3 topics), `i18n/{en,de,es}.json`, `db-schema/account.sql`, `graphql/catalog.graphqls` (draft)
- [x] `infra/docker-compose.yml`, profile `infra`: account-db, redis, kafka (KRaft), schema-registry, keycloak + its db
- [x] `infra/keycloak/realm-export.json`: realm `wallpaperhub`, roles, `web-spa` (PKCE), `dev-cli` (dev only), 5 service-account clients with audience mappers
- [ ] Add per phase: media-db + MinIO (phase 2), MongoDB + Elasticsearch (3), Mailpit (4)
- [ ] Observability profile: Alloy, Loki, Tempo, Prometheus, Grafana (before step 1.7)
- [ ] OpenAPI specs for media, catalog, notification (when their phase starts)
- [ ] `e2e/` skeleton (Hurl files + a runner script)

## 3. Phase 1: account-service (the template service)

| Step | Scope | Status |
|---|---|---|
| 1.1 | Foundations: bootstrap order, layered config, JSON logging, request context (request id, trace id, locale), `AppException` model + one problem+json filter, validation pipe with field-level codes, pagination util, i18n, management port (`/health/live|ready|startup`), graceful shutdown, Postgres + migrations + `migrate` command, audit subscriber, outbox repository (`SKIP LOCKED`), unit + integration tests. | [x] |
| 1.2 | Security: JWT validation (signature via cached JWKS, `iss`, `aud`, `exp`, `typ`, asymmetric algorithms only), default-deny guard, `@Public()`, `@Roles()`, `@RequirePermissions()`, ownership helper, `GET /whoami`. | [x] |
| 1.3 | Registration + users: Keycloak admin client (client-credentials token cache, single flight), `POST /registrations` as a compensating saga (Keycloak account, then profile + outbox event in one transaction, undo on failure), `GET/PATCH /users/me` (ETag / `If-Match`, row lock), `GET /users/{id}` (email only for owner/privileged), `GET /users` (admin, paging, sort whitelist), `DELETE /users/{id}` (owner or admin, retry-safe), `Idempotency-Key` + token-bucket rate limit on Redis, Redis in readiness as a non-critical check. Avatar/banner endpoints wait for media-service (phase 2). | [x] |
| 1.4 | Redis cache-aside for profiles: hits and negative hits ("no such user"), TTL with +/-20% jitter, single flight per key (also inside batch lookups, one query for all misses), version-guarded writes so a slow reader can never overwrite newer data (tombstones), invalidation after commit on update / delete / registration, a cool-down that bypasses Redis after any error, counters at `/management/cache`. Used by `GET /users/{id}`, `GET /users/me` and both gRPC lookups. | [x] |
| 1.5 | gRPC server (`AccountService`: `GetUser`, `GetUsersByIds`, server-streaming `ListUsersUpdatedSince`) as a second port of the same Nest application: service-account-only (`internal` role) through the SAME guard, the same exception-to-status translation (`AppException` to gRPC status, field errors in trailers) and a per-call context + log interceptor. Keyset-paginated stream (no OFFSET, microsecond-safe cursor), deleted users announced without personal data. | [x] |
| 1.6 | Outbox relay to Kafka: `@platformatic/kafka` idempotent producer (`acks=all`), Avro through Schema Registry at publish time (own small codec over `avsc`), batches claimed with `SKIP LOCKED` **and a per-aggregate ordering guard**, exponential backoff, LISTEN/NOTIFY wake-up with polling as a safety net, per-event isolation of unpublishable events, graceful shutdown, outbox backlog numbers (`/management/outbox`, readiness check), jobs under a Redis lock (outbox cleanup, user purge), `kafka-init` topic creation. | [x] |
| 1.7 | Observability: OpenTelemetry SDK to Alloy (logs, traces, DB spans, metrics), optional `/metrics`, Grafana dashboard. | [ ] |
| 1.8 | Quality gates and packaging. OpenAPI generated from the code and diffed against the contract; multi-stage `Dockerfile`, compose `apps` profile, `e2e/smoke-account.mjs`; CI workflow. TLS for gRPC (modes `off` / `tls` / `mtls`, client allowlist, fail-fast certificate validation, development CA via `pnpm tls:dev-certs`, certificate expiry at `/management/tls`; compose runs mutual TLS; the smoke test and the CI stack job exercise it). `docs/TLS.md`. | [x] |

Definition of done for phase 1: the full test pyramid is green, the account part of the README scenario 4.1 works
end to end (register, welcome event on Kafka, login via Keycloak, `GET /users/me`), and the outbox failure test passes.

## 4. Later phases (library suggestions, to be re-checked when we get there)

| Phase | Service | Likely TypeScript building blocks |
|---|---|---|
| 2 | media | `@fastify/multipart`, `sharp`, `blurhash`, AWS SDK v3 S3 client against MinIO, BullMQ (Redis queue), `@nestjs/schedule` |
| 3 | catalog | MongoDB driver or Mongoose, `@elastic/elasticsearch`, GraphQL (code-first) + `dataloader`, gRPC client, resilience wrappers (own, or `cockatiel`) |
| 4 | notification | `ioredis` (Redis as primary DB, Pub/Sub), SSE with Nest `@Sse`, `ws` for WebSocket, `nodemailer` + SendGrid/Mailgun adapters, Kafka consumers with retry topics and DLQ |
| 5 | gateway | Traefik (or Envoy) first, then a hand-written Fastify proxy |
| 6 | e2e, dashboards, Avro v2 exercise | Hurl or k6 against the compose `apps` profile |

## 5. Design decisions worth knowing (step 1.3)

- **Registration is not atomic and cannot be:** Keycloak and our database have separate transactions. The order of steps is chosen so every failure is undoable; if even the undo fails the service logs `orphanedIdentity: true` with the user id.
- **Email enumeration:** registration answers `409` with `email: Taken`, which tells a stranger that an address is registered. Accepted for now because the endpoint is rate limited; the usual hardening is email verification, which belongs with the notification phase.
- **Redis is a soft dependency:** rate limiting fails open, readiness reports Redis but stays UP, and an `Idempotency-Key` request gets 503 when Redis is down (silently skipping the check could create duplicates).
- **Deleting an account** removes the Keycloak account first, then soft-deletes the profile; repeating the call after a partial failure is safe. Existing access tokens stay valid until they expire (5 minutes in the dev realm).
- **Keycloak profile quirk:** its default user profile requires a last name, so the adapter sends the placeholder `-` (we store a single display name).
- **Seeded realm users** (`admin`, `moderator`) have no profile row in our database, so `GET /users/me` answers 404 for them. Register normal users through the API; grant `ADMIN` to one of them in the Keycloak console when you need to test admin calls.

- **Kafka client:** `kafkajs` has had no release since 2023, so the project uses `@platformatic/kafka` (pure TypeScript, maintained, needs Node 22.22+ or 24.6+). Its Schema Registry support is marked experimental, so we use a small codec of our own (`src/infra/kafka/avro-registry.ts`).
- **Ordering with several relays:** `SKIP LOCKED` alone would let two relays publish two events of the same user out of order. The claim query therefore only hands out the earliest unpublished event of each aggregate, so a user's events leave one at a time, in order; different users are published in parallel.
- **Poison events:** an event that cannot be encoded is retried forever and logged (`error` after 10 attempts) but blocks only its own user. There is no dead-letter table yet; `GET /management/outbox` shows `maxAttempts` so you can see it.
- **Kafka outages never take the API down:** `outbox` is a non-critical readiness check; events accumulate in PostgreSQL.
- **Purge scope:** the user purge erases the profile and the audit snapshots, but not email copies inside outbox rows (removed by the cleanup job after `OUTBOX_RETENTION_HOURS`).

- **gRPC and global guards:** a hybrid Nest app only applies the global guard, filter and interceptors to the gRPC side when the microservice is attached with `inheritAppConfig: true` (`src/api/grpc/setup-grpc.ts`). Without it every call would run with no authentication; the gRPC tests would fail loudly if this ever regressed.
- **gRPC is service-accounts-only:** the controller demands the `internal` role, so even an administrator's user token is refused. gRPC is not a second public API.
- **gRPC transport security (three independent layers):** TLS (encryption and server identity), mutual TLS with a client-name allowlist (which service), and the access token with the `internal` role (what it may do). Production defaults to `mtls` and refuses to start in plain text; development stays plain text for convenience, the compose stack runs mutual TLS. Certificates are validated at startup (readable, PEM, key matches certificate, not expired or not yet valid, with the file named in the error) and their expiry is visible at `/management/tls`. Renewal needs a restart (documented). Details and troubleshooting: `docs/TLS.md`.
- **What was verified for TLS:** the unit and integration suites (valid and invalid certificates, forged and expired client certificates, wrong host name, plain text on a TLS port, allowlist, token still required) and the compiled service against an independent TLS client (`openssl s_client`: certificate verified, HTTP/2 negotiated, handshake refused without a client certificate). Not checkable here: the container mount of the certificate folder and the CI stack job, hence checks 26 to 28.
- **Streams are inclusive:** `since` includes the boundary instant, so a consumer may see a user twice and must de-duplicate by id; this is the price of never skipping one.

- **Cache correctness:** every cached profile carries the row's `version`; Redis (atomically, in Lua) refuses to replace newer data with older data. An invalidation leaves a 30-second tombstone `x` ("version N is the truth") instead of just deleting, which is what stops a reader that loaded version N-1 before the commit from storing it afterwards. After a delete the entry becomes "not found" with the highest possible version.
- **Cache limits worth knowing:** (1) if Redis is unreachable at the exact moment of an invalidation, a stale profile can be served until its TTL (5 min) ends; the service retries three times and logs an error. (2) Rows changed directly in the database (manual SQL) are not invalidated and stay stale up to the TTL. (3) Only single-user reads are cached: the admin list and the gRPC stream always read the database. (4) There is no cross-instance stampede lock; with many instances a hot key can be loaded once per instance, which single flight inside each instance keeps small.
- **Privacy:** cached profiles contain the email address. Redis must stay on the internal network, and `CACHE_ENABLED=false` switches the cache off without a redeploy of code.

- **The OpenAPI contract is enforced, not decorative:** `contracts/openapi/account.yaml` stays the source of truth, and the unit test suite (so `pnpm check`) fails when the code drifts from it: a new or removed endpoint, a different response code, a changed limit, a missing header or security requirement. Descriptions, summaries, examples and tags are deliberately not compared (they are prose). Planned operations carry `x-implemented: false` and may be absent from the code; once implemented, the flag must go, and the test says so.
- **Documentation is written twice, kept honest by tests:** OpenAPI decorators and class-validator decorators both describe limits. A test feeds boundary values (min, max, max+1, undocumented enum values, missing required fields) to the real validators and compares with what the generated document promises. The only known exception is the email length: the document says 320 but `IsEmail` is stricter about the local part.
- **Swagger UI is for development:** `/api/docs`, `/api/docs-json` and `/api/docs-yaml` answer without a token, so they are on only in the local profile (`OPENAPI_ENABLED=true` turns them on elsewhere). The generated document is OpenAPI 3.0, the contract 3.1; the comparison normalises the differences (for example nullable types).

- **Image design:** three stages (tools, build, runtime). The build stage compiles, then `pnpm deploy --prod` copies the compiled code and ONLY production dependencies (no TypeScript, test tools, linters; about 150 MB of `node_modules`) into the final image, which runs as user 1000 with a `/health/ready` healthcheck. Migrations are not run by the service on startup: the same image runs `node dist/migrate.js` once as the `account-migrate` job, and the service starts only after it completed (`service_completed_successfully`).
- **Configuration inside containers:** everything comes from environment variables in `infra/docker-compose.yml` (the layered config of step 1.1). Two addresses differ from the host setup: services reach each other by container name (`account-db`, `redis`, `kafka:9092`), and Keycloak is reached by name (`keycloak:8080`) for keys and the admin API while tokens still carry the issuer `http://localhost:8180/realms/wallpaperhub`, because that is the address clients use. That is why `AUTH_ISSUER` and `AUTH_JWKS_URL` are separate settings.
- **What was verified without Docker:** `hadolint` finds nothing in the Dockerfile; `docker compose config` accepts the compose file (and shows that `--profile apps` alone is rejected, hence `apps:up` starts both profiles); the exact build steps (frozen filtered install, compile, `pnpm deploy --prod`) were run locally and the result booted, migrated, served HTTP, Swagger UI and gRPC and shut down cleanly with production dependencies only. What no tool here could check: the real `docker build`, the base image tags (`node:24-alpine`), and the container networking, hence checks 21 to 23.

## 6. Working agreements

- One step at a time; each step ends with `pnpm check` green and its integration tests passing.
- Contracts change first, code second.
- Anything I could not run myself is marked `[~]` here and listed in `GETTING-STARTED.md` as a first-run check.
