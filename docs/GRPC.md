# Internal gRPC API of account-service

Contract: `contracts/proto/account/v1/account.proto` (the service keeps a verified copy in `src/resources/proto/`;
after editing the contract run `pnpm --filter account-service contracts:sync`). Default port `9090` (`GRPC_PORT`);
set `GRPC_ENABLED=false` to turn the server off.

**This port is for other services only.** The gateway never routes to it. It speaks plain HTTP/2 without TLS for now
(mutual TLS between services belongs to the packaging step); keep it on the internal network.

## Who may call

Every call needs `authorization: Bearer <access token>` in the gRPC metadata. The token must belong to a **service
account** (realm role `internal`). Tokens of end users, even administrators, are refused with `PERMISSION_DENIED`.
The same guard, error translation and request logging as the HTTP API apply, because gRPC is a second port of the same
application. A service account gets a token with the client-credentials grant; the realm file already gives
`catalog-svc` and `notification-svc` an audience mapper for `account-svc`.

## Methods

| Method | Use | Notes |
|---|---|---|
| `GetUser(id)` | one profile | `NOT_FOUND` for unknown or deleted users; `INVALID_ARGUMENT` for a malformed id |
| `GetUsersByIds(ids)` | batch lookup for a GraphQL DataLoader | at most 100 distinct ids; unknown or deleted ids are left out; the answer keeps the request order |
| `ListUsersUpdatedSince(since)` | server stream of changes | oldest change first, `since` is inclusive, so boundary users may repeat: de-duplicate by `id`. Deleted users arrive once with `deleted = true` and no personal data. Pages of 500 rows are read lazily from the database, so memory stays flat |

`email` is filled for service accounts (they hold `users:read-email`) and empty otherwise.

## Errors

The same `AppException` that becomes a problem+json response over HTTP becomes a gRPC status here:

| Situation | Status |
|---|---|
| missing, invalid or expired token | `UNAUTHENTICATED` |
| valid token, not a service account | `PERMISSION_DENIED` |
| unknown user | `NOT_FOUND` |
| malformed id, too many ids | `INVALID_ARGUMENT` (trailer `x-field-errors`: `[{"field":"id","code":"Pattern"}]`) |
| database or Keycloak unavailable | `UNAVAILABLE` (safe to retry with backoff) |
| anything unexpected | `INTERNAL` (no details leak; the trailer `x-trace-id` identifies the log entry) |

Callers should send a deadline, and may send `traceparent` and `x-request-id` metadata: the service continues the trace
and logs one line per call (`rpc completed`).

## Trying it by hand

```powershell
# a service-account token (client-credentials grant)
$T = (curl.exe -s -X POST http://localhost:8180/realms/wallpaperhub/protocol/openid-connect/token -d grant_type=client_credentials -d client_id=catalog-svc -d client_secret=dev-secret-catalog-svc | ConvertFrom-Json).access_token

cd services\account\ts-nestjs
node scripts/grpc-call.mjs ListUsersUpdatedSince --token $T
node scripts/grpc-call.mjs GetUser --id <a user id> --token $T
```

Any gRPC tool works too, e.g. `grpcurl -plaintext -proto contracts/proto/account/v1/account.proto -H "authorization: Bearer $T" localhost:9090 wallpaperhub.account.v1.AccountService/GetUser`.
