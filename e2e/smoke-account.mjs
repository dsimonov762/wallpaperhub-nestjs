#!/usr/bin/env node
// End-to-end smoke test of account-service through its PUBLIC interfaces only, against a running stack:
//
//   pnpm apps:up            (or: pnpm infra:up  +  pnpm account:dev)
//   pnpm e2e:smoke
//
// The gRPC checks need `pnpm install` and `pnpm tls:dev-certs` to have been run (they use the development certificates
// of infra/tls/dev); without them that part is skipped with a note. If you start the service yourself with plain
// text gRPC, set SMOKE_GRPC=plain.
//
// It registers a user, logs in through Keycloak, reads and edits the profile, checks the cache and the event pipeline
// (the outbox must drain into Kafka), and deletes the user again. Needs Node 24 only: no packages.
//
// Settings (all optional): ACCOUNT_URL, MGMT_URL, KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT, GRPC_ADDR, SMOKE_SKIP_OUTBOX=1, SMOKE_GRPC=skip|plain
const ACCOUNT = process.env.ACCOUNT_URL ?? 'http://localhost:8080';
const MGMT = process.env.MGMT_URL ?? 'http://localhost:8081';
const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const REALM = process.env.KEYCLOAK_REALM ?? 'wallpaperhub';
const CLIENT = process.env.KEYCLOAK_CLIENT ?? 'dev-cli';
const SKIP_OUTBOX = process.env.SMOKE_SKIP_OUTBOX === '1';
const GRPC_ADDR = process.env.GRPC_ADDR ?? 'localhost:9090';
const SERVICE_CLIENT = process.env.SERVICE_CLIENT ?? 'catalog-svc';
const SERVICE_SECRET = process.env.SERVICE_SECRET ?? 'dev-secret-catalog-svc';

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;

class SmokeFailure extends Error {}
const ok = (message) => console.log(`  \u2713 ${++step}. ${message}`);
async function check(condition, message, response) {
  if (condition) return ok(message);
  const body = response ? await response.clone().text().catch(() => '') : '';
  throw new SmokeFailure(`${++step}. FAILED: ${message}${response ? `\n     HTTP ${response.status} ${body.slice(0, 400)}` : ''}`);
}

async function waitFor(what, fn, timeoutMs) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new SmokeFailure(`timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

const json = { 'content-type': 'application/json' };
const unique = Date.now().toString(36);
const user = { username: `smoke_${unique}`, email: `smoke_${unique}@example.com`, password: 'correct-horse-battery', displayName: 'Smoke Test' };


const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serviceDir = join(root, 'services', 'account', 'ts-nestjs');
const tlsDir = join(root, 'infra', 'tls', 'dev');

/** Calls the gRPC API through the repository's own command-line client, like another service would. */
function grpc(method, args, tls) {
  const flags = [...args];
  if (tls === 'mtls') flags.push('--ca', join(tlsDir, 'ca.crt'), '--cert', join(tlsDir, 'catalog-svc.crt'), '--key', join(tlsDir, 'catalog-svc.key'));
  if (tls === 'ca-only') flags.push('--ca', join(tlsDir, 'ca.crt'));
  const run = spawnSync(process.execPath, [join(serviceDir, 'scripts', 'grpc-call.mjs'), method, ...flags, '--addr', GRPC_ADDR], { encoding: 'utf8', timeout: 30_000 });
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}` };
}

async function grpcChecks(userId, userAuth) {
  const mode = process.env.SMOKE_GRPC ?? 'mtls';
  const ready = existsSync(join(serviceDir, 'node_modules', '@grpc')) && (mode === 'plain' || existsSync(join(tlsDir, 'ca.crt')));
  if (mode === 'skip' || !ready) {
    console.log(`  - skipped: gRPC checks (${mode === 'skip' ? 'SMOKE_GRPC=skip' : 'run `pnpm install` and `pnpm tls:dev-certs` first'})`);
    return;
  }
  const tls = mode === 'plain' ? 'plain' : 'mtls';
  const tokenResponse = await fetch(`${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SERVICE_CLIENT, client_secret: SERVICE_SECRET }),
  });
  await check(tokenResponse.status === 200, `service account ${SERVICE_CLIENT} gets a token at Keycloak`, tokenResponse);
  const serviceToken = (await tokenResponse.json()).access_token;

  const found = grpc('GetUser', ['--id', userId, '--token', serviceToken], tls);
  await check(found.ok && found.out.includes(userId), `gRPC GetUser answers over ${tls === 'mtls' ? 'mutual TLS' : 'plain text'} for the service account`);
  if (tls === 'mtls') {
    const noCertificate = grpc('GetUser', ['--id', userId, '--token', serviceToken], 'ca-only');
    await check(!noCertificate.ok && noCertificate.out.includes('UNAVAILABLE'), 'a client without a certificate is refused by the TLS handshake');
    const plainText = grpc('GetUser', ['--id', userId, '--token', serviceToken], 'plain');
    await check(!plainText.ok && plainText.out.includes('UNAVAILABLE'), 'plain text gRPC is refused');
  }
  const asUser = grpc('GetUser', ['--id', userId, '--token', userAuth.authorization.replace('Bearer ', '')], tls);
  await check(!asUser.ok && asUser.out.includes('PERMISSION_DENIED'), 'an end user token is refused on the internal API (PERMISSION_DENIED), even with a valid certificate');
}

async function main() {
  console.log(`account-service smoke test\n  api ${ACCOUNT}  management ${MGMT}  keycloak ${KEYCLOAK}/realms/${REALM}\n`);

  await waitFor('the service to become ready', async () => (await fetch(`${MGMT}/health/ready`)).status === 200, 90_000);
  ok('service is ready');

  // 1. registration, and the same request again with the same Idempotency-Key
  const headers = { ...json, 'idempotency-key': `smoke-${unique}` };
  const first = await fetch(`${ACCOUNT}/api/v1/registrations`, { method: 'POST', headers, body: JSON.stringify(user) });
  await check(first.status === 201, 'registration answers 201', first);
  const created = await first.json();
  await check(Boolean(created.id) && first.headers.get('location') === `/api/v1/users/${created.id}`, 'Location header points at the new user', first);
  const replay = await fetch(`${ACCOUNT}/api/v1/registrations`, { method: 'POST', headers, body: JSON.stringify(user) });
  await check(replay.status === 201 && replay.headers.get('idempotent-replayed') === 'true' && (await replay.json()).id === created.id, 'repeating the request with the same Idempotency-Key replays the original answer', replay);

  // 2. login at Keycloak (password grant of the dev-only client)
  const login = await fetch(`${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: CLIENT, username: user.username, password: user.password }),
  });
  await check(login.status === 200, 'the new user can log in at Keycloak', login);
  const auth = { authorization: `Bearer ${(await login.json()).access_token}` };

  // 3. read, edit with optimistic locking, read again (must not be served stale from the cache)
  const me = await fetch(`${ACCOUNT}/api/v1/users/me`, { headers: auth });
  const profile = await me.json();
  await check(me.status === 200 && profile.username === user.username && profile.email === user.email && me.headers.get('etag') === '"1"', 'GET /users/me returns the profile with ETag "1"', me);
  const patched = await fetch(`${ACCOUNT}/api/v1/users/me`, { method: 'PATCH', headers: { ...auth, ...json, 'if-match': '"1"' }, body: JSON.stringify({ displayName: 'Smoke Renamed' }) });
  await check(patched.status === 200 && patched.headers.get('etag') === '"2"', 'PATCH with If-Match "1" succeeds and returns ETag "2"', patched);
  const stale = await fetch(`${ACCOUNT}/api/v1/users/me`, { method: 'PATCH', headers: { ...auth, ...json, 'if-match': '"1"' }, body: JSON.stringify({ displayName: 'Too late' }) });
  await check(stale.status === 409, 'a second PATCH with the old ETag is refused with 409', stale);
  const again = await fetch(`${ACCOUNT}/api/v1/users/me`, { headers: auth });
  await check((await again.json()).displayName === 'Smoke Renamed', 'the new display name is visible immediately (cache invalidated)', again);
  const whoami = await fetch(`${ACCOUNT}/api/v1/whoami`, { headers: auth });
  await check(whoami.status === 200 && (await whoami.json()).roles.includes('USER'), '/whoami shows the USER role', whoami);
  const anonymous = await fetch(`${ACCOUNT}/api/v1/users/me`);
  await check(anonymous.status === 401 && (anonymous.headers.get('content-type') ?? '').includes('application/problem+json'), 'without a token the answer is 401 problem+json', anonymous);


  // 4. the internal gRPC API over mutual TLS (service-account token + client certificate)
  await grpcChecks(created.id, auth);

  // 5. events: registration and the update must have left the outbox for Kafka
  const outbox = async () => (await fetch(`${MGMT}/management/outbox`)).json();
  if (SKIP_OUTBOX) {
    console.log('  - skipped: outbox / Kafka check (SMOKE_SKIP_OUTBOX=1)');
  } else {
    const snapshot = await waitFor('the outbox to drain into Kafka', async () => {
      const o = await outbox();
      return o.unpublished === 0 && o.relay.publishedTotal >= 2 ? o : null;
    }, 30_000);
    ok(`events reached Kafka (published so far: ${snapshot.relay.publishedTotal}, backlog 0)`);
  }

  // 6. deletion
  const removed = await fetch(`${ACCOUNT}/api/v1/users/${created.id}`, { method: 'DELETE', headers: auth });
  await check(removed.status === 204, 'the owner can delete the account (204)', removed);
  const gone = await fetch(`${ACCOUNT}/api/v1/users/${created.id}`, { headers: auth });
  await check(gone.status === 404, 'the deleted user is gone (404)', gone);
  if (!SKIP_OUTBOX) {
    await waitFor('the deletion event to leave the outbox', async () => (await outbox()).unpublished === 0, 30_000);
    ok('the UserDeleted event reached Kafka');
  }

  console.log(`\nAll ${step} checks passed.`);
}

main().catch((err) => {
  console.error(`\n${err instanceof SmokeFailure ? err.message : err.stack}\n\nThe smoke test stopped at the first failure.`);
  process.exit(1);
});
