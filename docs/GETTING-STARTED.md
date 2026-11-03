# Getting started (Windows, PowerShell)

Prerequisites you already have: Node 24 (NVM for Windows), corepack, pnpm 12, Docker Desktop (WSL2).
Check Docker Desktop is running (whale icon, "Engine running") before step 3.

## 1. Install dependencies

```powershell
cd C:\dev\wallpaper-hub          # wherever you unzipped it
pnpm install
```

pnpm 12 refuses to run dependency install scripts unless approved; the three optional ones are already denied in
`pnpm-workspace.yaml`. If a future install stops with `ERR_PNPM_IGNORED_BUILDS`, run `pnpm approve-builds` and read the names.

## 2. Check the code without any Docker

```powershell
pnpm account:test                     # 150 unit tests, a few seconds
pnpm --filter account-service check   # typecheck + lint + format + tests
```

## 3. Start the infrastructure

```powershell
pnpm infra:up                     # first run downloads several GB of images
pnpm infra:ps                     # wait until account-db, redis, kafka, keycloak-db are "healthy"/running
```

Ports (host side): account-db `5433`, redis `6379`, kafka `9094`, schema registry `8085`, keycloak `8180`.

## 4. Create the schema and run the service

```powershell
pnpm account:migrate              # applies migrations to account-db
pnpm account:dev                  # starts account-service with auto-reload
```

In a second PowerShell window:

```powershell
curl.exe -s http://localhost:8081/health/ready
curl.exe -s -H "Accept-Language: de" http://localhost:8080/api/v1/nothing
```

Expected: `{"status":"UP","checks":{"postgres":{"status":"UP"}}}` and a German `application/problem+json` 404.
There are no business endpoints yet (they arrive in step 1.3).

## 5. Integration tests (need Docker running)

```powershell
pnpm --filter account-service test:e2e
```

This starts throw-away `postgres:18.6-trixie` and `redis:8.10-trixie` containers with Testcontainers and runs 104 tests: migrations,
the audit trail, the transactional outbox (including two concurrent relays), health, and the whole registration / profile /
deletion flow (idempotency, rate limiting, optimistic locking, compensation when a step fails). Keycloak is replaced by an
in-memory fake there.

## First-run checks for things the author could not execute

The author verified unit tests, integration tests (against PostgreSQL 16), the build, and a real boot and shutdown of
the compiled service. The author had **no Docker**, so these have never run; please confirm and tell me about any failure:

| # | Check | Expected |
|---|---|---|
| 1 | `pnpm infra:up` | all six containers start (image tags are pinned but were not pulled by the author) |
| 2 | `curl.exe -s http://localhost:8085/subjects` | `[]` (Schema Registry reaches Kafka) |
| 3 | `curl.exe -s http://localhost:8180/realms/wallpaperhub` | JSON describing the realm (the realm import worked; allow ~1 min on first boot) |
| 4 | Token for a user: `curl.exe -s -X POST http://localhost:8180/realms/wallpaperhub/protocol/openid-connect/token -d grant_type=password -d client_id=dev-cli -d username=admin -d password=admin` | JSON with `access_token` |
| 5 | Token for a service: same URL with `-d grant_type=client_credentials -d client_id=account-svc -d client_secret=dev-secret-account-svc` | JSON with `access_token`; sending it as `Authorization: Bearer ...` to `http://localhost:8180/admin/realms/wallpaperhub/users` must return a JSON list (proves the service account may manage users) |
| 6 | `pnpm --filter account-service test:e2e` | 104 passing tests |
| 7 | With the service running (`pnpm account:dev`) and a user token `$T` from check 4: `curl.exe -s -H "Authorization: Bearer $T" http://localhost:8080/api/v1/whoami` (in PowerShell: `$T = (curl.exe -s -X POST http://localhost:8180/realms/wallpaperhub/protocol/openid-connect/token -d grant_type=password -d client_id=dev-cli -d username=admin -d password=admin \| ConvertFrom-Json).access_token`) | JSON with `roles` containing `ADMIN`, and `permissions` including `users:list`. Without the header: 401 `application/problem+json` |
| 8 | Same call, but with a token for **`catalog-svc`** (`-d grant_type=client_credentials -d client_id=catalog-svc -d client_secret=dev-secret-catalog-svc`). Not `account-svc`: its own tokens are not meant for account-service (see the note below) | `"service": true`, `roles` containing `internal`. If you get 401 on 7 or 8, run the service with `LOG_LEVEL=debug`: the rejection reason (e.g. `ERR_JWT_CLAIM_VALIDATION_FAILED`) is logged, never sent to the client |

Why check 8 uses `catalog-svc`: a token is only accepted by a service if its `aud` (audience) names that service.
In the realm, `catalog-svc` and `notification-svc` have an audience mapper for `account-svc` (they call it), while
`account-svc` has none (it never calls itself), so its own token is correctly rejected with a 401.

### Trying registration by hand (checks 9 and 10)

Run `pnpm account:migrate` and `pnpm account:dev` first. Write the request body to a file (`-Encoding ascii` avoids a
byte-order mark that would break the JSON):

```powershell
@'
{"username":"alice_01","email":"alice@example.com","password":"correct-horse-battery","displayName":"Alice"}
'@ | Set-Content -Encoding ascii register.json

curl.exe -s -i -X POST http://localhost:8080/api/v1/registrations -H "content-type: application/json" -H "Idempotency-Key: demo-1" --data "@register.json"
```

| # | Check | Expected |
|---|---|---|
| 9 | The command above, then run it a second time unchanged | First: `201` with a `Location` header. Second: the same body plus `Idempotent-Replayed: true`. In the Keycloak console (`http://localhost:8180`, realm `wallpaperhub`, Users) there is exactly one `alice_01` with the realm role `USER` |
| 10 | Log in as the new user and read the profile: `$T = (curl.exe -s -X POST http://localhost:8180/realms/wallpaperhub/protocol/openid-connect/token -d grant_type=password -d client_id=dev-cli -d username=alice_01 -d password=correct-horse-battery \| ConvertFrom-Json).access_token` then `curl.exe -s -i http://localhost:8080/api/v1/users/me -H "Authorization: Bearer $T"` | `200`, an `ETag: "1"` header, and `alice@example.com` in the body. If the token request says "Account is not fully set up", Keycloak wants more profile fields: tell me the exact message |

Optional, update the profile (use a file again: PowerShell strips the quotes inside inline JSON, which the service then
rightly rejects with a plain `400` before it even looks at your token):

```powershell
'{"bio":"hello"}' | Set-Content -Encoding ascii patch.json
curl.exe -s -i -X PATCH http://localhost:8080/api/v1/users/me -H "Authorization: Bearer $T" -H 'If-Match: "1"' -H "content-type: application/json" --data "@patch.json"
```

Expected: `200` with `ETag: "2"`. Repeating the exact same command must return `409` (the version moved on).

### If registration answers 503

Look at the service log line `identity provider unavailable`: its `reason` says what Keycloak refused.

- `role "USER" lookup failed with HTTP 403`: the realm you imported before this update lacks the `view-realm` permission for
  `account-svc`. `--import-realm` only imports a realm that does not exist yet, so either grant it by hand (Keycloak console,
  realm `wallpaperhub`, Clients, `account-svc`, Service accounts roles, Assign role, filter by clients, add `realm-management`
  `view-realm`), or recreate Keycloak's data and let it import the fixed file:

```powershell
docker compose -f infra/docker-compose.yml --profile infra rm -sf keycloak keycloak-db
docker volume rm wallpaper-hub_keycloak-db-data
pnpm infra:up
```

- `token request failed with HTTP 401`: the client secret differs from `dev-secret-account-svc` (set `KEYCLOAK_CLIENT_SECRET`).
- `Keycloak unreachable`: wrong `KEYCLOAK_URL`, or Keycloak is still starting.

### Events on Kafka (checks 11 to 13)

`pnpm infra:up` now also runs `kafka-init`, a one-shot container that creates the three topics and exits (`Exited (0)` is correct).
Details of the events: `docs/EVENTS.md`.

| # | Check | Expected |
|---|---|---|
| 11 | `pnpm infra:up`, then `docker compose -f infra/docker-compose.yml --profile infra logs kafka-init` | three "Created topic ..." lines (or "already exists") |
| 12 | `pnpm --filter account-service test:kafka` (infra running, Docker Desktop running for the Postgres/Redis test containers) | 1 passing test: a registered, renamed and deleted user produces three Avro events in order, decoded through the registry |
| 13 | Outage drill, service running (`pnpm account:dev`). Stop the broker: `docker compose -f infra/docker-compose.yml stop kafka`. Register a user (as in check 9). Look at `curl.exe -s http://localhost:8081/management/outbox` several times, then `docker compose -f infra/docker-compose.yml start kafka` | While Kafka is down: registration still returns `201`, `unpublished` is 1 (or more) and `consecutiveFailures` grows. A few seconds after Kafka is healthy again: `unpublished` is 0 and `publishedTotal` increased. `http://localhost:8081/health/ready` stays `200` throughout (its `outbox` entry may show `DOWN` meanwhile) |

If check 13 never recovers, send me the output of `curl.exe -s http://localhost:8081/management/outbox` and the service log lines containing `outbox`.

### The internal gRPC API (checks 14 and 15)

Details and error table: `docs/GRPC.md`. Service running (`pnpm account:dev`; gRPC listens on port 9090), at least one user registered.

```powershell
$T = (curl.exe -s -X POST http://localhost:8180/realms/wallpaperhub/protocol/openid-connect/token -d grant_type=client_credentials -d client_id=catalog-svc -d client_secret=dev-secret-catalog-svc | ConvertFrom-Json).access_token
cd services\account\ts-nestjs
node scripts/grpc-call.mjs ListUsersUpdatedSince --token $T
```

| # | Check | Expected |
|---|---|---|
| 14 | The command above, then `node scripts/grpc-call.mjs GetUser --id <a user id from the output> --token $T` | One JSON line per user from the stream, with `email` filled; `GetUser` prints the same user. The same call without `--token` prints `UNAUTHENTICATED`. If you get `PERMISSION_DENIED` with the service token, the realm file's `internal` role did not reach `catalog-svc`: tell me the output of the `/whoami` call from check 8 with this token |
| 15 | Get a USER token as in check 10 and use it as `--token` | `PERMISSION_DENIED`: user tokens cannot call the internal API |

### The profile cache (checks 16 to 18)

With the service running and a user token `$T` (check 10). The cache is on by default in the local profile.

| # | Check | Expected |
|---|---|---|
| 16 | Call `curl.exe -s http://localhost:8080/api/v1/users/me -H "Authorization: Bearer $T"` three times, then `curl.exe -s http://localhost:8081/management/cache`, then `docker compose -f infra/docker-compose.yml exec redis redis-cli --scan --pattern "profile:*"` and `docker compose -f infra/docker-compose.yml exec redis redis-cli pttl "profile:v1:<your user id>"` | counters show `misses` 1, `hits` 2, `fills` 1; one `profile:v1:<id>` key; the remaining TTL is between 240000 and 360000 ms |
| 17 | Change the profile (`PATCH /users/me` with `If-Match: "1"`, see check 10's optional command) and call `GET /users/me` again right away | the new display name and `"version": 2` appear immediately, never the old data |
| 18 | Outage drill: `docker compose -f infra/docker-compose.yml stop redis`, call `GET /users/me`, look at `curl.exe -s http://localhost:8081/management/cache` and `http://localhost:8081/health/ready`, then `docker compose -f infra/docker-compose.yml start redis` and look again after about 10 seconds | while Redis is down: `GET /users/me` still returns `200` (from the database), the cache reports `"bypassed": true`, readiness stays `200` with `redis` shown as `DOWN`. After Redis is back: `"bypassed": false` and hits resume |

### The API documentation (checks 19 and 20)

| # | Check | Expected |
|---|---|---|
| 19 | With the service running (`pnpm account:dev`) open `http://localhost:8080/api/docs` in a browser. Click **Authorize**, paste an access token (check 10; paste only the token, without the word `Bearer`), then expand `GET /api/v1/users/me` and press **Try it out** | Swagger UI lists the endpoints in three groups (Registration, Users, Identity), and the call returns `200` with your profile. Without authorizing it returns `401` |
| 20 | `pnpm --filter account-service openapi:check`, then the drill: in `contracts/openapi/account.yaml` change `maxLength: 64` of `username` (in `RegistrationRequest`) to `maxLength: 80`, run the check again, then undo the change | first run: `OK: the code matches contracts/openapi/account.yaml`. Second run: exit code 1 and the line `POST /registrations requestBody.content.application/json.properties.username.maxLength: contract 80, code 64`. The generated document is written to `services/account/ts-nestjs/build/openapi/account.generated.yaml` for you to read |

### The services in containers (checks 21 to 23)

`pnpm apps:up` builds the account-service image and starts the infrastructure AND the service in Docker. Stop `pnpm account:dev` first: both would use ports 8080, 8081 and 9090. After code changes, `pnpm apps:up` again rebuilds the image. `pnpm apps:down` stops everything, `pnpm apps:stop` stops only the service, `pnpm apps:logs` follows the service log, `pnpm apps:ps` shows the state.

**Compose and profiles:** `account-service` depends on `redis`, which belongs to the `infra` profile. When you name a service, compose enables only that service's own profile, so a bare `docker compose ... stop account-service` fails with "no such service: redis". Pass both profiles (`--profile infra --profile apps`) like the `pnpm apps:*` scripts do, or put `COMPOSE_PROFILES=infra,apps` into `infra/.env` (copy `infra/.env.example`) and the flags are never needed.

| # | Check | Expected |
|---|---|---|
| 21 | `pnpm apps:up` (the first build downloads the Node image and installs dependencies: several minutes), then `pnpm apps:ps` | `account-migrate` is `Exited (0)` and `kafka-init` is `Exited (0)`; `account-service` becomes `healthy` within about a minute. If the build fails, send me the last 30 lines of the output |
| 22 | `pnpm e2e:smoke` | all checks pass (20 with the gRPC and Kafka checks): registration, repeat with the same `Idempotency-Key`, login at Keycloak, profile read and edit, stale-edit refusal, the 401 problem response, **the events reaching Kafka**, deletion. It stops at the first failure and prints the HTTP status and body. If it fails at registration with 503, send me `pnpm apps:logs` |
| 23 | `docker compose -f infra/docker-compose.yml --profile infra --profile apps exec account-service id`, then `pnpm apps:stop`, then `docker compose -f infra/docker-compose.yml --profile infra --profile apps logs account-service --tail 5` | `uid=1000(node)`, not root; the stop finishes in a few seconds (not after a 10 second kill timeout) and the last log lines include `outbox relay stopped` |

### Continuous integration (checks 24 and 25)

Details in `docs/CI.md`. This assumes GitHub; if you use another system, tell me which and I will translate the workflow.

| # | Check | Expected |
|---|---|---|
| 24 | Put the repository on GitHub (`git init`, `git add .`, commit, push to a new repository) and open its **Actions** tab | the `account-service` workflow runs; after roughly 15 minutes all of `verify`, `integration`, `kafka`, `stack`, `audit` and `CI passed` are green. If a job is red, send me its name and the last 40 lines of its log |
| 25 | On a new branch, break the contract on purpose: in `contracts/openapi/account.yaml` change `maxLength: 64` of `username` to `maxLength: 80`, push the branch and open a pull request | `verify` fails with the line `POST /registrations requestBody.content.application/json.properties.username.maxLength: contract 80, code 64`, the other jobs do not run, and `CI passed` is red. Then, in Settings, Branches, make `CI passed` a required check for `main` and close the pull request without merging |

### gRPC over mutual TLS (checks 26 to 28)

`pnpm apps:up` now creates development certificates first (`infra/tls/dev/`, git-ignored) and the service runs gRPC with
mutual TLS. Explanation and troubleshooting: `docs/TLS.md`. Check 22 (`pnpm e2e:smoke`) now also exercises it.

| # | Check | Expected |
|---|---|---|
| 26 | `pnpm tls:dev-certs`, then run it a second time | first: eight files created in `infra/tls/dev`; second: "still valid, nothing to do". `pnpm apps:up` (check 21) already ran it, so you may see only the second message |
| 27 | With the stack up: `curl.exe -s http://localhost:8081/management/tls`, then from `services\account\ts-nestjs` with a service token `$T` (see `docs/GRPC.md`): `node scripts/grpc-call.mjs ListUsersUpdatedSince --token $T --ca ..\..\..\infra\tls\dev\ca.crt --cert ..\..\..\infra\tls\dev\catalog-svc.crt --key ..\..\..\infra\tls\dev\catalog-svc.key` and then the same without `--cert` and `--key` | the management call shows `"mode":"mtls"`, the certificate `CN=account-service` and a `daysLeft` of about 820; the first gRPC call prints users; the second prints `UNAVAILABLE` (no client certificate), and so does a call without any `--ca` option (plain text) |
| 28 | Misconfiguration drill: `docker compose -f infra/docker-compose.yml --profile infra --profile apps stop account-service`, rename `infra\tls\dev\server.key` to `server.key.bak`, start the service again (`docker compose -f infra/docker-compose.yml --profile infra --profile apps up -d account-service`), look at `pnpm apps:logs`, then rename the file back and start it once more | the service refuses to start and prints `Invalid gRPC TLS configuration:` followed by `GRPC_TLS_KEY_FILE: cannot read "/etc/tls/server.key"`; after restoring the file it becomes `healthy` again |

Dev credentials (local only, never reuse): Keycloak admin console `http://localhost:8180` as `admin` / `admin`;
realm users `admin` / `admin` and `moderator` / `moderator`; service client secrets `dev-secret-<client>`.
