import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCa, issueCertificate } from '../scripts/pki.mjs';
import { attachGrpc } from '../src/api/grpc/setup-grpc.js';
import { ManagementServer } from '../src/api/http/management.server.js';
import { setupHttp } from '../src/api/http/setup-http.js';
import { AppModule } from '../src/app.module.js';
import type { AppConfig } from '../src/config/config.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import { IdentityProvider } from '../src/domain/identity-provider.js';
import { LOGGER } from '../src/infra/logger.js';
import { createDataSource } from '../src/repository/data-source.js';
import { User } from '../src/repository/entities/user.entity.js';
import { newUuid } from '../src/util/ids.js';
import { testConfig } from './support/config.js';
import { FakeIdentityProvider } from './support/fake-identity.js';
import { type FakeIssuer, startFakeIssuer } from './support/fake-issuer.js';
import {
  type AccountClient,
  accountClient,
  type ClientTls,
  freePort,
  GRPC_STATUS,
} from './support/grpc-client.js';
import { startTestDatabase, type TestDatabase } from './support/postgres.js';
import { startTestRedis, type TestRedis } from './support/redis.js';

let db: TestDatabase;
let redisServer: TestRedis;
let issuer: FakeIssuer;
let ds: DataSource;
let internalToken: string;
let userToken: string;
const logLines: string[] = [];
const clients: AccountClient[] = [];

const pki: Record<string, { cert: string; key: string }> & {
  ca?: string;
  rogueCa?: string;
} = {};
let seeded: User;

interface Running {
  app: NestFastifyApplication;
  port: number;
}
const running: Running[] = [];

const write = (dir: string, name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

async function startApp(
  mode: 'tls' | 'mtls',
  allowedClients: string[],
  files: { cert: string; key: string; ca: string },
): Promise<Running> {
  const grpcPort = await freePort();
  const config: AppConfig = testConfig({
    db: db.db,
    redis: { url: redisServer.url },
    auth: { jwksUrl: issuer.jwksUrl },
    http: { grpcPort, host: '127.0.0.1' },
    grpc: {
      enabled: true,
      streamPageSize: 3,
      tls: {
        mode,
        certFile: files.cert,
        keyFile: files.key,
        caFile: mode === 'mtls' ? files.ca : '',
        allowedClients,
      },
    },
  });
  const capture = pino(
    { level: 'info' },
    { write: (line: string) => void logLines.push(line) },
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(IdentityProvider)
    .useValue(new FakeIdentityProvider())
    .overrideProvider(LOGGER)
    .useValue(capture)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  setupHttp(app, capture);
  attachGrpc(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.startAllMicroservices();
  const started = { app, port: grpcPort };
  running.push(started);
  return started;
}

const connect = (port: number, tls?: ClientTls) => {
  const client = accountClient(`localhost:${port}`, tls);
  clients.push(client);
  return client;
};
const failure = async (p: Promise<unknown>) =>
  p.then(
    () => Promise.reject(new Error('expected the call to fail')),
    (e) => e,
  );

let mtls: Running;
let tlsOnly: Running;
const trusted = (): ClientTls => ({ ca: pki.ca });
const asCatalog = (): ClientTls => ({
  ca: pki.ca,
  cert: pki['catalog-svc']!.cert,
  key: pki['catalog-svc']!.key,
});

beforeAll(async () => {
  [db, redisServer, issuer] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    startFakeIssuer(),
  ]);
  const admin = createDataSource(db.db);
  await admin.initialize();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.runMigrations();
  await admin.destroy();
  ds = createDataSource(db.db);
  await ds.initialize();
  seeded = await ds.getRepository(User).save(
    Object.assign(new User(), {
      id: newUuid(),
      username: 'tls_user',
      email: 'tls@example.com',
      displayName: 'Tls',
      locale: 'en',
      bio: null,
      status: 'ACTIVE',
    }),
  );
  internalToken = await issuer.token('svc-catalog', ['internal']);
  userToken = await issuer.token(newUuid(), ['USER', 'ADMIN']);

  const dir = mkdtempSync(join(tmpdir(), 'grpc-tls-'));
  const ca = await createCa();
  const rogueCa = await createCa({ commonName: 'Rogue CA' });
  const server = await issueCertificate({
    ca,
    commonName: 'account-service',
    usage: 'server',
    dnsNames: ['localhost'],
    ipAddresses: ['127.0.0.1'],
  });
  const leaf = async (name: string, signer = ca, extra: object = {}) => {
    const l = await issueCertificate({
      ca: signer,
      commonName: name,
      usage: 'client',
      dnsNames: [name],
      ...extra,
    });
    pki[name] = { cert: l.certPem, key: l.keyPem };
  };
  await leaf('catalog-svc');
  await leaf('rogue-svc'); // valid certificate from OUR CA, but not on the allowlist
  pki['catalog-svc-forged'] = await (async () => {
    const l = await issueCertificate({
      ca: rogueCa,
      commonName: 'catalog-svc',
      usage: 'client',
      dnsNames: ['catalog-svc'],
    });
    return { cert: l.certPem, key: l.keyPem };
  })();
  const expired = await issueCertificate({
    ca,
    commonName: 'catalog-svc',
    usage: 'client',
    notBefore: new Date(Date.now() - 20 * 86_400_000),
    notAfter: new Date(Date.now() - 86_400_000),
  });
  pki['catalog-svc-expired'] = { cert: expired.certPem, key: expired.keyPem };
  pki.ca = ca.certPem;
  pki.rogueCa = rogueCa.certPem;

  const files = {
    cert: write(dir, 'server.crt', server.certPem),
    key: write(dir, 'server.key', server.keyPem),
    ca: write(dir, 'ca.crt', ca.certPem),
  };
  mtls = await startApp('mtls', ['catalog-svc'], files);
  tlsOnly = await startApp('tls', [], files);
}, 120_000);

afterAll(async () => {
  for (const c of clients) c.close();
  for (const r of running) await r.app.close();
  await ds?.destroy();
  await issuer?.close();
  await db?.stop();
  await redisServer?.stop();
});

describe('mutual TLS (mode mtls, allowlist: catalog-svc)', () => {
  it('serves a client with an allowlisted certificate AND a service token', async () => {
    const res = await connect(mtls.port, asCatalog()).unary(
      'GetUser',
      { id: seeded.id },
      internalToken,
    );
    expect(res).toMatchObject({
      id: seeded.id,
      username: 'tls_user',
      email: 'tls@example.com',
    });
  });

  it('streams over the encrypted connection too', async () => {
    const users = await connect(mtls.port, asCatalog()).stream(
      'ListUsersUpdatedSince',
      {},
      internalToken,
    );
    expect(users.map((u: { id: string }) => u.id)).toContain(seeded.id);
  });

  it('refuses a client that presents no certificate', async () => {
    const err = await failure(
      connect(mtls.port, trusted()).unary(
        'GetUser',
        { id: seeded.id },
        internalToken,
      ),
    );
    expect(err.code).toBe(GRPC_STATUS.UNAVAILABLE);
  });

  it('refuses a certificate signed by a different authority (even one claiming to be catalog-svc)', async () => {
    const forged = pki['catalog-svc-forged']!;
    const err = await failure(
      connect(mtls.port, {
        ca: pki.ca,
        cert: forged.cert,
        key: forged.key,
      }).unary('GetUser', { id: seeded.id }, internalToken),
    );
    expect(err.code).toBe(GRPC_STATUS.UNAVAILABLE);
  });

  it('refuses an expired client certificate', async () => {
    const old = pki['catalog-svc-expired']!;
    const err = await failure(
      connect(mtls.port, { ca: pki.ca, cert: old.cert, key: old.key }).unary(
        'GetUser',
        { id: seeded.id },
        internalToken,
      ),
    );
    expect(err.code).toBe(GRPC_STATUS.UNAVAILABLE);
  });

  it('refuses plain text on the TLS port', async () => {
    const err = await failure(
      connect(mtls.port).unary('GetUser', { id: seeded.id }, internalToken),
    );
    expect(err.code).toBe(GRPC_STATUS.UNAVAILABLE);
  });

  it('a client that does not trust our authority refuses the SERVER (no silent man-in-the-middle)', async () => {
    const err = await failure(
      connect(mtls.port, {
        ca: pki.rogueCa,
        cert: pki['catalog-svc']!.cert,
        key: pki['catalog-svc']!.key,
      }).unary('GetUser', { id: seeded.id }, internalToken),
    );
    expect(err.code).toBe(GRPC_STATUS.UNAVAILABLE);
  });

  it('a client verifies the server host name', async () => {
    const err = await failure(
      connect(mtls.port, { ...asCatalog(), serverName: 'evil.example' }).unary(
        'GetUser',
        { id: seeded.id },
        internalToken,
      ),
    );
    expect(err.code).toBe(GRPC_STATUS.UNAVAILABLE);
  });

  it('refuses a valid certificate of our own authority that is not on the allowlist (PERMISSION_DENIED)', async () => {
    const rogue = pki['rogue-svc']!;
    const err = await failure(
      connect(mtls.port, {
        ca: pki.ca,
        cert: rogue.cert,
        key: rogue.key,
      }).unary('GetUser', { id: seeded.id }, internalToken),
    );
    expect(err.code).toBe(GRPC_STATUS.PERMISSION_DENIED);
  });

  it('still requires the access token: the certificate alone is not enough (UNAUTHENTICATED)', async () => {
    const err = await failure(
      connect(mtls.port, asCatalog()).unary('GetUser', { id: seeded.id }),
    );
    expect(err.code).toBe(GRPC_STATUS.UNAUTHENTICATED);
  });

  it('and the token must still belong to a service account (PERMISSION_DENIED)', async () => {
    const err = await failure(
      connect(mtls.port, asCatalog()).unary(
        'GetUser',
        { id: seeded.id },
        userToken,
      ),
    );
    expect(err.code).toBe(GRPC_STATUS.PERMISSION_DENIED);
  });

  it('logs which certificate identity made each call', async () => {
    await connect(mtls.port, asCatalog()).unary(
      'GetUser',
      { id: seeded.id },
      internalToken,
    );
    await new Promise((r) => setTimeout(r, 50));
    const line = logLines
      .map((l) => JSON.parse(l))
      .reverse()
      .find((l) => l.msg === 'rpc completed' && l.outcome === 'OK');
    expect(line).toMatchObject({ peer: 'catalog-svc', user_id: 'svc-catalog' });
  });

  it('reports certificate expiry on the management port', async () => {
    const mgmt = mtls.app.get(ManagementServer).build();
    const res = await mgmt.inject('/management/tls');
    await mgmt.close();
    const grpc = res.json().grpc;
    expect(grpc).toMatchObject({
      mode: 'mtls',
      allowedClients: ['catalog-svc'],
    });
    expect(grpc.certificate).toMatchObject({ subject: 'CN=account-service' });
    expect(grpc.certificate.daysLeft).toBeGreaterThan(800);
    expect(grpc.clientCa.subject).toContain('Wallpaper Hub Dev CA');
  });
});

describe('server-authentication TLS (mode tls)', () => {
  it('serves clients without a certificate, still behind the token checks', async () => {
    const client = connect(tlsOnly.port, trusted());
    expect(
      (await client.unary('GetUser', { id: seeded.id }, internalToken)).id,
    ).toBe(seeded.id);
    expect(
      (await failure(client.unary('GetUser', { id: seeded.id }))).code,
    ).toBe(GRPC_STATUS.UNAUTHENTICATED);
  });

  it('refuses plain text', async () => {
    const err = await failure(
      connect(tlsOnly.port).unary('GetUser', { id: seeded.id }, internalToken),
    );
    expect(err.code).toBe(GRPC_STATUS.UNAVAILABLE);
  });
});
