import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { DataSource } from 'typeorm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { attachGrpc } from '../src/api/grpc/setup-grpc.js';
import { setupHttp } from '../src/api/http/setup-http.js';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import { UpstreamUnavailableException } from '../src/domain/exceptions/app.exception.js';
import { IdentityProvider } from '../src/domain/identity-provider.js';
import { UserService } from '../src/domain/user.service.js';
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
  freePort,
  GRPC_STATUS,
} from './support/grpc-client.js';
import { startTestDatabase, type TestDatabase } from './support/postgres.js';
import { startTestRedis, type TestRedis } from './support/redis.js';

let db: TestDatabase;
let redisServer: TestRedis;
let issuer: FakeIssuer;
let ds: DataSource;
let redis: Redis;
let app: NestFastifyApplication;
let client: AccountClient;
let internal: string; // a service-account token
const logLines: string[] = [];
const idp = new FakeIdentityProvider();

const seed = async (over: Partial<User> = {}): Promise<User> =>
  ds.getRepository(User).save(
    Object.assign(new User(), {
      id: newUuid(),
      username: `u_${Math.random().toString(36).slice(2, 9)}`,
      email: `${Math.random().toString(36).slice(2, 9)}@example.com`,
      displayName: 'Seeded',
      locale: 'en',
      bio: null,
      status: 'ACTIVE',
      ...over,
    }),
  );

/** Sets updated_at exactly (TypeORM would overwrite it on save). */
const touch = (id: string, ts: string) =>
  ds.query(`UPDATE users SET updated_at = $1 WHERE id = $2`, [ts, id]);
const rejection = async (p: Promise<unknown>) =>
  p.then(
    () => Promise.reject(new Error('expected the call to fail')),
    (e) => e,
  );

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

  const grpcPort = await freePort();
  const config = testConfig({
    db: db.db,
    redis: { url: redisServer.url },
    auth: { jwksUrl: issuer.jwksUrl },
    http: { grpcPort, host: '127.0.0.1' },
    grpc: { enabled: true, streamPageSize: 3 },
  });
  const capture = pino(
    { level: 'info' },
    { write: (line: string) => void logLines.push(line) },
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(IdentityProvider)
    .useValue(idp)
    .overrideProvider(LOGGER)
    .useValue(capture)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  setupHttp(app, capture);
  attachGrpc(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.startAllMicroservices();

  ds = createDataSource(db.db);
  await ds.initialize();
  redis = new Redis(redisServer.url);
  client = accountClient(`127.0.0.1:${grpcPort}`);
  internal = await issuer.token('svc-catalog', ['internal']);
});

afterAll(async () => {
  client?.close();
  await app?.close();
  await ds?.destroy();
  redis?.disconnect();
  await issuer?.close();
  await db?.stop();
  await redisServer?.stop();
});

beforeEach(async () => {
  await ds.query('TRUNCATE users, outbox_event, audit_log RESTART IDENTITY');
  await redis.flushdb();
  logLines.length = 0;
  idp.reset();
  vi.restoreAllMocks();
});

describe('authentication and authorization', () => {
  it('rejects calls without a token or with garbage (UNAUTHENTICATED)', async () => {
    const user = await seed();
    expect(
      (await rejection(client.unary('GetUser', { id: user.id }))).code,
    ).toBe(GRPC_STATUS.UNAUTHENTICATED);
    expect(
      (await rejection(client.unary('GetUser', { id: user.id }, 'not.a.jwt')))
        .code,
    ).toBe(GRPC_STATUS.UNAUTHENTICATED);
  });

  it('rejects end-user and admin tokens: this API is for service accounts only (PERMISSION_DENIED)', async () => {
    const user = await seed();
    for (const roles of [['USER'], ['USER', 'ADMIN'], ['USER', 'MODERATOR']]) {
      const token = await issuer.token(newUuid(), roles);
      expect(
        (await rejection(client.unary('GetUser', { id: user.id }, token))).code,
      ).toBe(GRPC_STATUS.PERMISSION_DENIED);
      expect(
        (await rejection(client.stream('ListUsersUpdatedSince', {}, token)))
          .code,
      ).toBe(GRPC_STATUS.PERMISSION_DENIED);
    }
  });

  it('accepts a service-account token', async () => {
    const user = await seed();
    expect((await client.unary('GetUser', { id: user.id }, internal)).id).toBe(
      user.id,
    );
  });

  it('keeps serving HTTP on the same application', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: { authorization: `Bearer ${internal}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'svc-catalog', service: true });
  });
});

describe('GetUser', () => {
  it('returns the user, with email for a service account, and the update timestamp', async () => {
    const user = await seed({ displayName: 'Alice', avatarAssetId: 'asset 1' });
    const res = await client.unary('GetUser', { id: user.id }, internal);
    expect(res).toMatchObject({
      id: user.id,
      username: user.username,
      displayName: 'Alice',
      email: user.email,
      locale: 'en',
      avatarUrl: 'http://media.test/api/v1/media/asset%201',
      deleted: false,
    });
    expect(Number(res.updatedAt.seconds)).toBe(
      Math.floor(user.updatedAt.getTime() / 1000),
    );
  });

  it('answers NOT_FOUND for unknown and for deleted users', async () => {
    expect(
      (await rejection(client.unary('GetUser', { id: newUuid() }, internal)))
        .code,
    ).toBe(GRPC_STATUS.NOT_FOUND);
    const gone = await seed();
    await ds.getRepository(User).softRemove(gone);
    expect(
      (await rejection(client.unary('GetUser', { id: gone.id }, internal)))
        .code,
    ).toBe(GRPC_STATUS.NOT_FOUND);
  });

  it('answers INVALID_ARGUMENT for a malformed id, with the field error and trace id in the trailers', async () => {
    const err = await rejection(
      client.unary('GetUser', { id: 'nope' }, internal),
    );
    expect(err.code).toBe(GRPC_STATUS.INVALID_ARGUMENT);
    expect(JSON.parse(err.metadata.get('x-field-errors')[0])).toEqual([
      { field: 'id', code: 'Pattern' },
    ]);
    expect(err.metadata.get('x-trace-id')[0]).toMatch(/^[\da-f]{32}$/);
  });

  it('maps unexpected failures to INTERNAL without leaking details, and outages to UNAVAILABLE', async () => {
    const user = await seed();
    vi.spyOn(UserService.prototype, 'getById').mockRejectedValueOnce(
      new Error('secret: connection string is postgres://x:hunter2@db'),
    );
    const internalError = await rejection(
      client.unary('GetUser', { id: user.id }, internal),
    );
    expect(internalError.code).toBe(GRPC_STATUS.INTERNAL);
    expect(internalError.details).not.toContain('hunter2');

    vi.spyOn(UserService.prototype, 'getById').mockRejectedValueOnce(
      new UpstreamUnavailableException(),
    );
    expect(
      (await rejection(client.unary('GetUser', { id: user.id }, internal)))
        .code,
    ).toBe(GRPC_STATUS.UNAVAILABLE);
  });

  it('logs one structured line per call with the caller and the trace id it sent', async () => {
    const user = await seed();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await client.unary('GetUser', { id: user.id }, internal, {
      traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      'x-request-id': 'req-77',
    });
    await new Promise((r) => setTimeout(r, 50));
    const line = logLines
      .map((l) => JSON.parse(l))
      .find((l) => l.msg === 'rpc completed');
    expect(line).toMatchObject({
      rpc: 'AccountGrpcController.getUser',
      outcome: 'OK',
      trace_id: traceId,
      request_id: 'req-77',
      user_id: 'svc-catalog',
    });
  });
});

describe('GetUsersByIds', () => {
  it('returns found users in request order, collapses duplicates, omits unknown and deleted ids', async () => {
    const [a, b, c] = [await seed(), await seed(), await seed()];
    await ds.getRepository(User).softRemove(c);
    const res = await client.unary(
      'GetUsersByIds',
      { ids: [b.id, newUuid(), a.id, b.id, c.id] },
      internal,
    );
    expect(res.users.map((u: { id: string }) => u.id)).toEqual([b.id, a.id]);
  });

  it('handles an empty list, rejects malformed ids and more than 100 ids', async () => {
    expect(
      (await client.unary('GetUsersByIds', { ids: [] }, internal)).users,
    ).toEqual([]);
    expect(
      (await rejection(client.unary('GetUsersByIds', { ids: ['x'] }, internal)))
        .code,
    ).toBe(GRPC_STATUS.INVALID_ARGUMENT);
    const many = Array.from({ length: 101 }, () => newUuid());
    expect(
      (await rejection(client.unary('GetUsersByIds', { ids: many }, internal)))
        .code,
    ).toBe(GRPC_STATUS.INVALID_ARGUMENT);
    const hundred = many.slice(0, 100);
    expect(
      (await client.unary('GetUsersByIds', { ids: hundred }, internal)).users,
    ).toEqual([]);
  });
});

describe('ListUsersUpdatedSince (server streaming)', () => {
  const seconds = (u: { updatedAt: { seconds: string } }) =>
    Number(u.updatedAt.seconds);

  it('streams everything oldest-first across several database pages (page size is 3)', async () => {
    const users: User[] = [];
    for (let i = 0; i < 8; i++) {
      const u = await seed({ username: `s${i}` });
      await touch(u.id, `2026-01-01T00:00:0${i}Z`);
      users.push(u);
    }
    const res = await client.stream('ListUsersUpdatedSince', {}, internal);
    expect(res.map((u) => u.username)).toEqual(users.map((u) => u.username));
    expect(res.map(seconds)).toEqual(res.map(seconds).sort((x, y) => x - y));
  });

  it('honours `since` (inclusive)', async () => {
    const old = await seed();
    const edge = await seed();
    const recent = await seed();
    await touch(old.id, '2026-01-01T00:00:00Z');
    await touch(edge.id, '2026-01-02T00:00:00Z');
    await touch(recent.id, '2026-01-03T00:00:00Z');
    const since = {
      seconds: String(Date.parse('2026-01-02T00:00:00Z') / 1000),
      nanos: 0,
    };
    const res = await client.stream(
      'ListUsersUpdatedSince',
      { since },
      internal,
    );
    expect(res.map((u) => u.id)).toEqual([edge.id, recent.id]);
  });

  it('neither skips nor repeats rows that share a timestamp across a page boundary, even at microsecond precision', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const u = await seed();
      await touch(u.id, '2026-02-01T10:00:00.123456Z'); // all identical, sub-millisecond part included
      ids.push(u.id);
    }
    const res = await client.stream('ListUsersUpdatedSince', {}, internal);
    expect(res).toHaveLength(10);
    expect(new Set(res.map((u) => u.id)).size).toBe(10);
    expect(res.map((u) => u.id)).toEqual([...ids].sort()); // ties broken by id
  });

  it('announces deleted users without personal data', async () => {
    const keep = await seed({ displayName: 'Keeper' });
    const gone = await seed({ displayName: 'Goner' });
    await ds.getRepository(User).softRemove(gone);
    const res = await client.stream('ListUsersUpdatedSince', {}, internal);
    const deleted = res.find((u) => u.id === gone.id);
    expect(deleted).toMatchObject({
      deleted: true,
      username: '',
      displayName: '',
      email: '',
      locale: '',
      avatarUrl: '',
    });
    expect(res.find((u) => u.id === keep.id)).toMatchObject({
      deleted: false,
      displayName: 'Keeper',
    });
  });

  it('a user deleted through the HTTP API shows up as deleted in a later stream', async () => {
    const user = await seed();
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${user.id}`,
      headers: { authorization: `Bearer ${await issuer.token(user.id)}` },
    });
    expect(res.statusCode).toBe(204);
    const since = {
      seconds: String(Math.floor(before / 1000)),
      nanos: (before % 1000) * 1e6,
    };
    const streamed = await client.stream(
      'ListUsersUpdatedSince',
      { since },
      internal,
    );
    expect(streamed.find((u) => u.id === user.id)).toMatchObject({
      deleted: true,
    });
  });

  it('returns an empty stream when nothing changed since, and survives a client that cancels mid-stream', async () => {
    for (let i = 0; i < 9; i++) await seed();
    const future = {
      seconds: String(Math.floor(Date.now() / 1000) + 3600),
      nanos: 0,
    };
    expect(
      await client.stream('ListUsersUpdatedSince', { since: future }, internal),
    ).toEqual([]);

    const call = client.openStream('ListUsersUpdatedSince', {}, internal);
    await new Promise<void>((resolve) => call.once('data', () => resolve()));
    call.on('error', () => {});
    call.cancel();
    await new Promise((r) => setTimeout(r, 100));
    expect(
      (await client.stream('ListUsersUpdatedSince', {}, internal)).length,
    ).toBe(9); // server unharmed
  });
});
