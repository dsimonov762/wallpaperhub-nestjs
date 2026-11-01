# Continuous integration

Workflow: `.github/workflows/account-service.yml` (GitHub Actions). It runs the commands you already know; it needs no
secrets and publishes nothing yet (publishing the image to a registry is a deliberate later step).

| Job | What it proves | Roughly | Same thing on your machine |
|---|---|---|---|
| `verify` | types, lint, formatting, all unit tests (including that the copied contracts equal `contracts/`), and that the code still matches `contracts/openapi/account.yaml` | 3 min | `pnpm ci:account` |
| `integration` | the integration tests against real PostgreSQL 17 and Redis 7 (service containers) | 4 min | `pnpm --filter account-service test:e2e` |
| `kafka` | events reach real Kafka as Avro through Schema Registry (the stack from `infra/docker-compose.yml`) | 5 min | `pnpm infra:up`, then `pnpm --filter account-service test:kafka` |
| `stack` | Dockerfile lint, compose file valid, the image builds, the whole stack starts, `e2e/smoke-account.mjs` passes | 10 to 15 min | `pnpm apps:up`, then `pnpm e2e:smoke` |
| `audit` | no known vulnerability of severity high or critical in production dependencies | 1 min | `pnpm --filter account-service exec pnpm audit --prod --audit-level high` |
| `ci-ok` | one summary job | seconds | |

`integration`, `kafka` and `stack` wait for `verify`, so a lint error does not waste a ten-minute stack run. A weekly run
(Mondays) catches dependency and base-image drift even when nobody pushes. Dependabot (`.github/dependabot.yml`) opens
weekly pull requests for npm packages, GitHub Actions and the Docker base image; this pipeline proves each one.

## Setting it up on GitHub

1. Put the repository on GitHub (`git init`, commit, push). The folder you unzipped is the repository root; `.gitignore`
   and `.gitattributes` are already there.
2. Open the Actions tab: the first run starts with the first push.
3. Settings, Branches, add a rule for `main`: require a pull request and require the status check **CI passed** (the
   `ci-ok` job). Requiring only that one check means you never have to list the individual jobs.

Good to know:

- The workflow only runs when relevant paths change (`services/account`, `contracts`, `infra`, `e2e`, the lockfile...).
  A required check that never runs stays "pending" on pull requests that touch nothing else; if that bites you, remove
  the `paths:` filters.
- Action versions are pinned to major tags (`actions/checkout@v4`, ...). Dependabot proposes updates.
- pnpm comes from the `packageManager` field in the root `package.json`, so CI and your machine use the same version.
- Using GitLab CI, Azure Pipelines or Jenkins instead? Every step is a plain shell command from the table above; only
  the service containers (`postgres`, `redis`) and the Docker-in-Docker setup need translating.

## Known advisories

`pnpm audit` currently reports two **moderate** findings, both inside `glob` and `minimatch` pulled in by
`@fastify/static`. That package only serves the Swagger UI files, and Swagger UI is switched off outside the local
profile, so the code is not reachable in production. The audit gate is set to **high**, so these do not fail the build;
Dependabot will propose the fix when `@fastify/static` updates its dependencies. Run the audit with
`--audit-level moderate` to see the failure the gate would give.

## When a job fails

- `verify` / `openapi:check`: the message names the endpoint, the field and both values. Change the code, or change the
  contract FIRST if the change is intended.
- `integration`: reproduce with `TEST_DB_URL` and `TEST_REDIS_URL` set like in the workflow, or just run it with Docker
  Desktop on (Testcontainers starts the databases itself).
- `kafka` / `stack`: the job prints the broker or container logs at the end; the artifact `openapi-generated` of the
  `verify` job holds the generated API document for review.
