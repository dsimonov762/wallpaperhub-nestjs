# Transport security of the internal gRPC port

The HTTP API is meant to sit behind the gateway, which terminates TLS at the edge. The gRPC port (`9090`) is different:
other services talk to it directly, so it protects itself. Three independent layers, each answering one question:

| Layer | Question it answers | Where it is enforced | Needs |
|---|---|---|---|
| **TLS** | Is the connection encrypted, and is this really account-service? | the server certificate, checked by every client | `GRPC_TLS_MODE=tls` or `mtls` |
| **Mutual TLS + allowlist** | Which service is connecting? | the client certificate, signed by our CA, whose name is on `GRPC_TLS_ALLOWED_CLIENTS` | `GRPC_TLS_MODE=mtls` |
| **Access token** | Is this service account allowed to ask this, and for whom? | the `internal` role in the JWT (same guard as HTTP) | always |

None replaces another: a stolen certificate is useless without a token, a stolen token is useless without a certificate.

## Settings

| Variable | Meaning |
|---|---|
| `GRPC_TLS_MODE` | `off` (plain text, the development default), `tls` (encrypted, server authenticated), `mtls` (clients must also present a certificate). **The prod profile defaults to `mtls` and refuses `off`** (set `GRPC_ENABLED=false` if you really do not want gRPC) |
| `GRPC_TLS_CERT_FILE`, `GRPC_TLS_KEY_FILE` | PEM files: the server certificate (chain) and its private key. Required unless `off`. Keys must not be password-protected |
| `GRPC_TLS_CA_FILE` | PEM file of the authority that signs CLIENT certificates. Required for `mtls` |
| `GRPC_TLS_ALLOWED_CLIENTS` | `mtls` only. Comma-separated client names (certificate common name or DNS name), e.g. `catalog-svc,notification-svc`. Empty means every certificate our CA signed |

The files are validated at startup and a mistake stops the service with a message that names the setting and the file:
unreadable or non-PEM file, a private key that does not belong to the certificate, an expired or not-yet-valid
certificate. The service warns in its log when the server certificate has fewer than 30 days left.

## Development certificates

```powershell
pnpm tls:dev-certs            # creates infra/tls/dev/ (git-ignored), or keeps the existing files while they are valid 30+ days
pnpm tls:dev-certs -- --force # replaces them
```

It creates a development CA (`ca.crt`, `ca.key`), the server certificate (valid for `localhost`, `127.0.0.1`, `::1` and
`account-service`), and client certificates for `catalog-svc` and `notification-svc`. They are ECDSA P-256 and written
with world-readable keys so the non-root user in the container can read the mounted files: that is acceptable only
because nothing real trusts this CA. **Never copy these files to a shared environment.**

`pnpm apps:up` runs the generator first and mounts the folder into the container, where the compose file sets
`GRPC_TLS_MODE=mtls`. To run the service on your machine with the same security:

```powershell
$d = "$PWD\infra\tls\dev"
$env:GRPC_TLS_MODE = "mtls"; $env:GRPC_TLS_CERT_FILE = "$d\server.crt"; $env:GRPC_TLS_KEY_FILE = "$d\server.key"
$env:GRPC_TLS_CA_FILE = "$d\ca.crt"; $env:GRPC_TLS_ALLOWED_CLIENTS = "catalog-svc,notification-svc"
pnpm account:dev
```

and call it:

```powershell
cd services\account\ts-nestjs
node scripts/grpc-call.mjs GetUser --id <user id> --token $T --ca ..\..\..\infra\tls\dev\ca.crt --cert ..\..\..\infra\tls\dev\catalog-svc.crt --key ..\..\..\infra\tls\dev\catalog-svc.key
```

(`$T` is the service-account token from `docs/GRPC.md`.) With `--ca` only you get `UNAVAILABLE`: the server hangs up
because no client certificate was presented. Any other gRPC tool works too; `openssl s_client -connect localhost:9090 -alpn h2 -CAfile ca.crt -cert catalog-svc.crt -key catalog-svc.key` is a good way to look at the handshake.

## Real environments

Do not use the development generator. Certificates should come from something that issues and renews them
automatically: cert-manager in Kubernetes, HashiCorp Vault's PKI engine, your cloud's private CA, or a service mesh that
does mutual TLS for you (in which case run this port with `tls` or behind the mesh and keep the token layer). Guidance:

- one **server** certificate per service, with the DNS names clients really use (host name verification is on);
- one **client** certificate per calling service, whose common name is the name you put on the allowlist;
- short lifetimes (days to weeks) with automatic renewal; the CA certificate has a longer life and is distributed to both sides;
- the service reads the files at startup, so **renewing a certificate means a rolling restart** (a Kubernetes rollout does
  it without downtime). Watch `GET :8081/management/tls`: `certificate.daysLeft` is the number to alert on;
- keep private keys in secrets (mounted files or `..._FILE` style secrets), never in images or git.

## Troubleshooting

| You see | Usually means |
|---|---|
| service exits at startup: `GRPC_TLS_KEY_FILE: ... is not the private key of the certificate` | the key and certificate files come from different generations; regenerate or copy both |
| service exits: `GRPC_TLS_CERT_FILE: certificate ... expired on ...` | renew the certificate |
| service exits: `GRPC_TLS_MODE: the prod profile refuses to serve gRPC in plain text` | set `GRPC_TLS_MODE=tls` or `mtls` with the files, or `GRPC_ENABLED=false` |
| client gets `UNAVAILABLE` immediately | the handshake failed: wrong or missing client certificate, the client does not trust the server CA, the server name does not match the certificate, or the client speaks plain text to a TLS port |
| client gets `PERMISSION_DENIED` | the TLS handshake worked but the certificate name is not on `GRPC_TLS_ALLOWED_CLIENTS`, or the token is not a service-account token (the service log shows which: look for `not on the allowlist`) |
| client gets `UNAUTHENTICATED` | handshake fine, but the access token is missing, expired or invalid |
