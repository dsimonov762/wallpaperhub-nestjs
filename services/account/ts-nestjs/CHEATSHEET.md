# account-service (NestJS) cheat sheet: concept -> file

| Concept | File |
|---|---|
| Entry point, bootstrap order | `src/main.ts` |
| DI wiring (composition root) | `src/app.module.ts` |
| Separate `migrate` command | `src/migrate.ts` (`pnpm migrate`) |
| Layered typed config, fail fast, `*_FILE` secrets | `src/config/config.ts` |
| `.env` for local runs | `src/config/load-dotenv.ts` |
| Exception model (`AppException`, 9 subclasses) | `src/domain/exceptions/app.exception.ts` |
| One HTTP exception handler (problem+json, localized) | `src/api/http/filters/problem.filter.ts` |
| Validation rules -> field-level error codes | `src/api/http/validation.pipe.ts` |
| Request id / trace id / locale, access log, security headers | `src/api/http/setup-http.ts` |
| Per-request context (AsyncLocalStorage) | `src/api/http/request-context.ts` |
| Health + management port 8081 | `src/api/http/health.service.ts`, `management.server.ts` |
| Pagination DTO, envelope, sort whitelist | `src/dto/page-query.dto.ts`, `src/util/pagination.ts` |
| Localization (en/de/es) | `src/i18n/i18n.service.ts`, `src/resources/i18n/*.json` |
| JSON logging, PII redaction | `src/infra/logger.ts`, `src/util/pii.ts` |
| Entities (users, outbox_event, audit_log) | `src/repository/entities/*.entity.ts` |
| SQL migration (forward-only) | `src/resources/migrations/1761264000000-init-account-schema.ts` |
| ORM-listener audit | `src/repository/audit.subscriber.ts` |
| Transactional outbox storage, `SKIP LOCKED` claim | `src/repository/outbox.repository.ts` |
| Token verification (JWKS cache, 401 vs 503) | `src/security/token-verifier.ts` |
| Default-deny guard (layers 1 and 2) | `src/security/auth.guard.ts` |
| `@Public()`, `@Roles()`, `@RequirePermissions()`, `@CurrentPrincipal()` | `src/security/decorators.ts` |
| Role -> permission table | `src/security/permissions.ts` |
| Ownership check (layer 3) | `src/security/ownership.ts` |
| `GET /whoami` | `src/security/whoami.controller.ts` |
| Registration saga (Keycloak + DB + undo) | `src/domain/registration.service.ts` |
| Profile update (row lock + ETag), delete | `src/domain/user.service.ts` |
| Identity port / Keycloak adapter | `src/domain/identity-provider.ts`, `src/infra/keycloak/keycloak-admin.client.ts` |
| Outbox event payloads (match the Avro schemas) | `src/domain/user-events.ts` |
| User queries | `src/repository/user.repository.ts` |
| Endpoints | `src/api/http/registration.controller.ts`, `users.controller.ts` |
| Request/response shapes, entity -> response mapping | `src/dto/*.ts`, `src/mapper/user.mapper.ts` |
| `Idempotency-Key` | `src/resilience/idempotency.service.ts` |
| Token-bucket rate limit (`@RateLimit('registration')`) | `src/resilience/rate-limiter.ts`, `rate-limit.guard.ts` |
| Redis connection | `src/infra/redis.module.ts` |
| ETag / If-Match helpers | `src/util/etag.ts` |
| Feature module wiring | `src/users.module.ts` |
| Test fakes (identity provider, issuer, Redis, Postgres) | `test/support/*.ts` |
| Outbox relay (claim, publish, backoff, LISTEN/NOTIFY, shutdown) | `src/jobs/outbox-relay.ts` |
| Outbox backlog numbers, readiness check | `src/jobs/outbox-monitor.ts` |
| Broker port / Kafka adapter / idempotent producer | `src/domain/event-publisher.ts`, `src/infra/kafka/kafka-event-publisher.ts` |
| Avro + Schema Registry codec (wire format) | `src/infra/kafka/avro-registry.ts`, `src/resources/avro/*.avsc` |
| Periodic jobs, cluster-wide lock | `src/jobs/job-scheduler.ts`, `src/resilience/distributed-lock.ts` |
| Outbox cleanup, user purge | `src/jobs/outbox-cleanup.job.ts`, `src/jobs/user-purge.job.ts` |
| Messaging wiring | `src/messaging.module.ts` |
| Copy contracts into the service | `pnpm contracts:sync` |
| gRPC handlers (`GetUser`, `GetUsersByIds`, `ListUsersUpdatedSince`) | `src/api/grpc/account.grpc-controller.ts` |
| Attaching gRPC to the app (`inheritAppConfig`!) | `src/api/grpc/setup-grpc.ts`, `src/grpc.module.ts` |
| Exception -> gRPC status | `src/api/grpc/grpc-errors.ts` (called from `problem.filter.ts`) |
| Per-call context and log line | `src/api/grpc/grpc-call.interceptor.ts` |
| Caller identity on gRPC calls | `src/security/principal-store.ts`, `auth.guard.ts` |
| Entity -> proto message | `src/mapper/proto-user.mapper.ts` |
| Keyset-paginated streaming query | `UserRepository.streamUpdatedSince` in `src/repository/user.repository.ts` |
| gRPC command-line client | `scripts/grpc-call.mjs` |
| Profile cache (hits, negative hits, tombstones, single flight, cool-down) | `src/repository/profile-cache.ts` |
| Where the cache is used and invalidated | `getById`, `getByIds`, `updateProfile`, `delete` in `src/domain/user.service.ts`; `register` in `registration.service.ts` |
| Cache counters | `GET :8081/management/cache` |
| OpenAPI decorators for responses, errors, auth | `src/api/http/openapi/decorators.ts`; response shapes in `src/api/http/openapi/schemas.ts`; request limits on the DTOs in `src/dto/*.ts` |
| Generate / serve the OpenAPI document | `src/openapi/build-document.ts`, `preview-document.ts` (no infrastructure), `setup-openapi.ts` (Swagger UI) |
| Contract comparison engine | `src/openapi/contract-diff.ts` (tests: `contract-diff.spec.ts`, `openapi.spec.ts`) |
| `pnpm openapi:generate` / `pnpm openapi:check` | `src/openapi/cli.ts` |
| Container image (multi-stage, production dependencies only) | `Dockerfile` (build context: the repository root; `.dockerignore` there) |
| Service + one-shot migration in containers | `account-migrate`, `account-service` in `infra/docker-compose.yml` (profile `apps`) |
| End-to-end smoke test through the public interfaces | `e2e/smoke-account.mjs` (`pnpm e2e:smoke` from the repository root) |
| CI pipeline | `.github/workflows/account-service.yml` (repository root), explained in `docs/CI.md` |
| The CI `verify` job on your machine | `pnpm ci:account` (repository root) |
| gRPC TLS: settings validation, certificate loader, expiry info | `src/config/config.ts` (GRPC_TLS_*), `src/api/grpc/tls.ts`, `tls-status.ts`; served at `GET :8081/management/tls` |
| Client allowlist (mTLS) and caller identity | `src/api/grpc/peer-identity.ts`, the rpc branch of `src/security/auth.guard.ts` |
| Development certificate authority | `scripts/pki.mjs` (library), `scripts/dev-certs.mjs` (`pnpm tls:dev-certs`), output in `infra/tls/dev/` |
| Unit tests | `src/**/*.spec.ts` |
| Integration tests (real PostgreSQL + Redis) | `test/db.e2e-spec.ts`, `test/users.e2e-spec.ts`, `test/messaging.e2e-spec.ts`, `test/grpc.e2e-spec.ts`, `test/cache.e2e-spec.ts`, `test/openapi.e2e-spec.ts`, `test/grpc-tls.e2e-spec.ts` |
| Real Kafka test (needs `pnpm infra:up`) | `test/kafka.kafka-spec.ts` (`pnpm test:kafka`) |

