# The JavaScript / TypeScript ecosystem, mapped to this repo

You know web development, so this is only the tooling vocabulary and where each piece lives here.

## Runtime and package tools

| Thing | What it is | Where you see it |
|---|---|---|
| **Node.js** | Runs JavaScript outside the browser. Your servers are Node processes | `node dist/main.js` |
| **NVM for Windows** | Switches Node versions (`nvm use 24`) | already installed |
| **npm / pnpm / yarn** | Package managers. All install from the same npm registry. We use **pnpm**: fast, strict, one shared store | `pnpm install`, `pnpm add <pkg>` |
| **corepack** | Ships with Node; makes sure the pnpm version a project wants is the one that runs | invisible, mostly |
| **package.json** | The project manifest: dependencies, and `scripts` (named commands you run with `pnpm <name>`) | `services/account/ts-nestjs/package.json` |
| **pnpm-lock.yaml** | Exact resolved versions. Commit it. Never edit by hand | repo root |
| **node_modules/** | Installed dependencies. Huge, generated, git-ignored. Delete and `pnpm install` if anything feels broken | |
| **workspace** | Several packages in one repo sharing one lockfile | `pnpm-workspace.yaml`, `pnpm --filter account-service <script>` |
| `dependencies` vs `devDependencies` | Needed at runtime vs only for building/testing | `package.json` |
| **allowBuilds** (pnpm 12) | Dependencies that run install scripts must be approved or denied explicitly | `pnpm-workspace.yaml` |

## TypeScript

| Thing | What it is |
|---|---|
| **TypeScript (`tsc`)** | JavaScript plus types. Types exist only at compile time and are erased. `tsc --noEmit` = "just type-check" (`pnpm typecheck`) |
| **tsconfig.json** | Compiler settings. `strict: true` turns on the full checks the README asks for |
| **src/ vs dist/** | You write `src/*.ts`; the build emits `dist/*.js`; production runs `dist/` |
| **ES modules (ESM)** | `import x from './x.js'`. Nest 12 is ESM-only, so **relative imports must end in `.js` even though the file is `.ts`**. This surprises everyone once |
| **Decorators** (`@Controller`, `@Injectable`) | Annotations, like Java annotations or C# attributes. Nest reads them to wire everything |
| **Dependency injection** | Declare what a class needs in its constructor; Nest creates and passes it. Wiring lives in `app.module.ts` |

## Tools this repo uses

| Tool | Job | Command |
|---|---|---|
| **Nest CLI** | Builds and runs the app (`nest build`, `nest start --watch`) | `pnpm build`, `pnpm start:dev` |
| **Vitest** | Test runner (like JUnit or pytest). Files named `*.spec.ts` | `pnpm test`, `pnpm test:watch` |
| **Testcontainers** | Starts throw-away Docker containers from inside tests | `pnpm test:e2e` |
| **oxlint** | Linter (finds likely bugs) | `pnpm lint` |
| **Prettier** | Formatter (settles style arguments) | `pnpm format`, `pnpm format:check` |
| `pnpm check` | typecheck + lint + format check + unit tests: run before every commit | |

## Where things are in a service (README section 12)

```
src/main.ts            bootstrap, top to bottom in startup order
src/app.module.ts      the wiring (DI composition root)
src/config/            typed, validated configuration
src/api/http/          filters, hooks, health, management server
src/dto/               request/response shapes with validation rules
src/domain/            exceptions now; models and business services later
src/repository/        entities, migrations access, outbox, audit
src/resources/         i18n bundles, SQL migrations
src/util/              pagination, ids, clock, PII masking, hashing
```

## Windows-specific notes

- Use `curl.exe` (not `curl`) in PowerShell; plain `curl` is an alias of something else.
- Keep the repo on the Windows drive (e.g. `C:\dev\wallpaper-hub`) or inside WSL consistently; do not mix.
- Git must not convert line endings of files that Linux containers read: `.gitattributes` already forces LF.
- Docker Desktop on WSL2 may use up to half of your RAM by default. The full stack (Kafka, Elasticsearch, Keycloak,
  Grafana...) is heavy; later we will add a memory cap in `%UserProfile%\.wslconfig` and start only the profiles you need.
