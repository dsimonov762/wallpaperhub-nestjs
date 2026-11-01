import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ManagementServer } from '../src/api/http/management.server.js';
import { setupHttp } from '../src/api/http/setup-http.js';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import { IdentityProvider } from '../src/domain/identity-provider.js';
import { UserService } from '../src/domain/user.service.js';
import { LOGGER } from '../src/infra/logger.js';
import { createDataSource } from '../src/repository/data-source.js';
import { User } from '../src/repository/entities/user.entity.js';
import { ProfileCache } from '../src/repository/profile-cache.js';
import { UserRepository } from '../src/repository/user.repository.js';
import { newUuid } from '../src/util/ids.js';
import { testConfig } from './support/config.js';
import { FakeIdentityProvider } from './support/fake-identity.js';
import { type FakeIssuer, startFakeIssuer } from './support/fake-issuer.js';
import { latch } from './support/fake-publisher.js';
import { startTestDatabase, type TestDatabase } from './support/postgres.js';
import { startTestRedis, type TestRedis } from './support/redis.js';

const PROFILE_TTL_MS = 300_000;
const NEGATIVE_TTL_MS = 30_000;
const key = (id: string) => `profile:v1:${id}`;

let db: TestDatabase;
let redisServer: TestRedis;
let issuer: FakeIssuer;
let ds: DataSource;
let redis: Redis;
let app: NestFastifyApplication;
let cache: ProfileCache;
let users: UserService;
const idp = new FakeIdentityProvider();

const seed = (over: Partial<User> = {}): Promise<User> =>
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

const get = async (
  path: string,
  as: { sub: string; roles?: string[] } = { sub: 'viewer' },
) =>
  app.inject({
    method: 'GET',
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${await issuer.token(as.sub, as.roles)}`,
    },
  });
const patchMe = async (id: string, version: number, payload: object) =>
  app.inject({
    method: 'PATCH',
    url: '/api/v1/users/me',
    headers: {
      authorization: `Bearer ${await issuer.token(id)}`,
      'if-match': `"${version}"`,
    },
    payload,
  });
const stored = async (id: string) => {
  const raw = await redis.get(key(id));
  return raw === null
    ? null
    : (JSON.parse(raw) as {
        t: string;
        v: number;
        u?: { displayName: string };
      });
};
/** Counts database reads and (optionally) makes them slow, so concurrent requests overlap. */
function watchDatabase(delayMs = 0) {
  const findById = UserRepository.prototype.findById;
  const findByIds = UserRepository.prototype.findByIds;
  const spyOne = vi
    .spyOn(UserRepository.prototype, 'findById')
    .mockImplementation(async function (this: UserRepository, id: string) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return findById.call(this, id);
    });
  const spyMany = vi
    .spyOn(UserRepository.prototype, 'findByIds')
    .mockImplementation(function (this: UserRepository, ids: string[]) {
      return findByIds.call(this, ids);
    });
  return { one: spyOne, many: spyMany };
}

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

  const config = testConfig({
    db: db.db,
    redis: { url: redisServer.url },
    auth: { jwksUrl: issuer.jwksUrl },
    cache: {
      enabled: true,
      profileTtlSeconds: PROFILE_TTL_MS / 1000,
      negativeTtlSeconds: NEGATIVE_TTL_MS / 1000,
      cooldownMs: 1000,
    },
    rateLimit: { registration: { capacity: 100, refillPerSecond: 10 } },
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(IdentityProvider)
    .useValue(idp)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  setupHttp(app, app.get<Logger>(LOGGER));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  cache = app.get(ProfileCache);
  users = app.get(UserService);

  ds = createDataSource(db.db);
  await ds.initialize();
  redis = new Redis(redisServer.url);
});

afterAll(async () => {
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
  idp.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reading', () => {
  it('loads from the database once, then serves hits from Redis', async () => {
    const user = await seed({ displayName: 'Alice' });
    const spy = watchDatabase();
    const first = await get(`/users/${user.id}`);
    const second = await get(`/users/${user.id}`);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json()); // dates and nulls survive the round trip through Redis
    expect(spy.one).toHaveBeenCalledTimes(1);
    expect(await stored(user.id)).toMatchObject({
      t: 'u',
      v: 1,
      u: { displayName: 'Alice' },
    });
  });

  it('gives every entry a TTL near the configured one, with jitter', async () => {
    const ttls: number[] = [];
    for (let i = 0; i < 15; i++) {
      const u = await seed();
      await get(`/users/${u.id}`);
      ttls.push(await redis.pttl(key(u.id)));
    }
    expect(
      ttls.every(
        (t) => t >= PROFILE_TTL_MS * 0.79 && t <= PROFILE_TTL_MS * 1.21,
      ),
    ).toBe(true);
    expect(new Set(ttls).size).toBeGreaterThan(1);
  });

  it('remembers unknown users for a short time (negative caching)', async () => {
    const id = newUuid();
    const spy = watchDatabase();
    expect((await get(`/users/${id}`)).statusCode).toBe(404);
    expect((await get(`/users/${id}`)).statusCode).toBe(404);
    expect(spy.one).toHaveBeenCalledTimes(1);
    expect(await stored(id)).toEqual({ t: 'n', v: 0 });
    const ttl = await redis.pttl(key(id));
    expect(ttl).toBeGreaterThan(NEGATIVE_TTL_MS * 0.79);
    expect(ttl).toBeLessThanOrEqual(NEGATIVE_TTL_MS * 1.21);
  });

  it('coalesces concurrent misses for the same user into ONE database read (single flight)', async () => {
    const user = await seed();
    const spy = watchDatabase(150);
    const responses = await Promise.all(
      Array.from({ length: 25 }, () => get(`/users/${user.id}`)),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(spy.one).toHaveBeenCalledTimes(1);
    expect(cache.stats().coalesced).toBeGreaterThan(0);
  });

  it('survives Redis being emptied, and replaces an unreadable entry', async () => {
    const user = await seed();
    await get(`/users/${user.id}`);
    await redis.flushdb();
    expect((await get(`/users/${user.id}`)).statusCode).toBe(200);

    await redis.set(key(user.id), '{not json', 'PX', 60_000);
    expect((await get(`/users/${user.id}`)).statusCode).toBe(200);
    expect(await stored(user.id)).toMatchObject({ t: 'u' });
  });
});

describe('writing', () => {
  it('a profile update is visible immediately (no stale read after PATCH)', async () => {
    const user = await seed({ displayName: 'Before' });
    expect((await get('/users/me', { sub: user.id })).json().displayName).toBe(
      'Before',
    ); // fills the cache
    const patched = await patchMe(user.id, 1, { displayName: 'After' });
    expect(patched.statusCode).toBe(200);

    const reread = await get('/users/me', { sub: user.id });
    expect(reread.json()).toMatchObject({ displayName: 'After', version: 2 });
    expect(reread.headers.etag).toBe('"2"');
    expect(await stored(user.id)).toMatchObject({ t: 'u', v: 2 });
  });

  it('a no-op update leaves the cache alone', async () => {
    const user = await seed({ displayName: 'Same' });
    await get('/users/me', { sub: user.id });
    const before = cache.stats().invalidations;
    expect(
      (await patchMe(user.id, 1, { displayName: 'Same' })).statusCode,
    ).toBe(200);
    expect(cache.stats().invalidations).toBe(before);
  });

  it('refuses to store an OLDER profile after a newer commit (the stale-fill race)', async () => {
    const user = await seed({ displayName: 'v1 name' });
    const repo = app.get(UserRepository);
    const readStarted = latch();
    const mayReturn = latch();

    // Reader: reads version 1 from the database, then is slow before it stores the result in Redis.
    const slowReader = cache.get(user.id, async () => {
      const snapshot = await repo.findById(user.id);
      readStarted.open();
      await mayReturn.wait();
      return snapshot;
    });
    await readStarted.wait();

    // Writer: commits version 2 and invalidates, while the reader is still holding version 1.
    expect(
      (await patchMe(user.id, 1, { displayName: 'v2 name' })).statusCode,
    ).toBe(200);
    const skippedBefore = cache.stats().skippedFills;

    mayReturn.open();
    expect((await slowReader)?.version).toBe(1); // the slow reader itself still gets what it read
    expect(cache.stats().skippedFills).toBe(skippedBefore + 1); // but Redis refused to keep it
    expect(await stored(user.id)).toEqual({ t: 'x', v: 2 }); // tombstone intact

    expect((await get('/users/me', { sub: user.id })).json()).toMatchObject({
      displayName: 'v2 name',
      version: 2,
    });
  });

  it('deleting a user is visible immediately and cannot be undone by a stale fill', async () => {
    const user = await seed();
    expect((await get(`/users/${user.id}`)).statusCode).toBe(200);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${user.id}`,
      headers: { authorization: `Bearer ${await issuer.token(user.id)}` },
    });
    expect(res.statusCode).toBe(204);

    expect((await get(`/users/${user.id}`)).statusCode).toBe(404);
    expect(await stored(user.id)).toEqual({
      t: 'n',
      v: Number.MAX_SAFE_INTEGER,
    });

    let loaderCalled = false;
    expect(
      await cache.get(user.id, async () => ((loaderCalled = true), user)),
    ).toBeNull();
    expect(loaderCalled).toBe(false);
  });

  it('registering a user clears a "not found" remembered for that id', async () => {
    const id = newUuid();
    expect((await get(`/users/${id}`)).statusCode).toBe(404);
    expect(await stored(id)).toEqual({ t: 'n', v: 0 });

    idp.nextId = id;
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/registrations',
      payload: {
        username: 'newcomer',
        email: 'newcomer@example.com',
        password: 'correct-horse-battery',
        displayName: 'New',
      },
    });
    expect(registered.statusCode).toBe(201);
    expect((await get(`/users/${id}`)).statusCode).toBe(200);
  });
});

describe('batch lookups', () => {
  it('reads cached users from Redis and fetches only the missing ones, in one query', async () => {
    const [a, b, c, d] = [
      await seed(),
      await seed(),
      await seed(),
      await seed(),
    ];
    const unknown = newUuid();
    await users.getById(a.id);
    await users.getById(b.id);

    const spy = watchDatabase();
    const found = await users.getByIds([a.id, b.id, c.id, d.id, unknown, a.id]);
    expect(found.map((u) => u.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(spy.many).toHaveBeenCalledTimes(1);
    expect(spy.many.mock.calls[0]![0].sort()).toEqual(
      [c.id, d.id, unknown].sort(),
    );

    await users.getByIds([a.id, b.id, c.id, d.id, unknown]); // everything known now, including the negative
    expect(spy.many).toHaveBeenCalledTimes(1);
    expect(await stored(unknown)).toEqual({ t: 'n', v: 0 });
  });
});

describe('operations', () => {
  it('exposes counters on the management port', async () => {
    const user = await seed();
    const before = cache.stats();
    await get(`/users/${user.id}`);
    await get(`/users/${user.id}`);
    const mgmt = app.get(ManagementServer).build();
    const res = await mgmt.inject('/management/cache');
    await mgmt.close();
    const after = res.json();
    expect(after).toMatchObject({ enabled: true, bypassed: false });
    expect(after.hits - before.hits).toBe(1);
    expect(after.misses - before.misses).toBe(1);
    expect(after.fills - before.fills).toBe(1);
  });
});
