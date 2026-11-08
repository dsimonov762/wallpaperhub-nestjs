import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { type Logger, pino } from 'pino';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupHttp } from '../src/api/http/setup-http.js';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import { IdentityProvider } from '../src/domain/identity-provider.js';
import { UpstreamUnavailableException } from '../src/domain/exceptions/app.exception.js';
import { LOGGER } from '../src/infra/logger.js';
import { createDataSource } from '../src/repository/data-source.js';
import { AuditLog } from '../src/repository/entities/audit-log.entity.js';
import { OutboxEvent } from '../src/repository/entities/outbox-event.entity.js';
import { User } from '../src/repository/entities/user.entity.js';
import { RateLimiter } from '../src/resilience/rate-limiter.js';
import { newUuid } from '../src/util/ids.js';
import { testConfig } from './support/config.js';
import { FakeIdentityProvider } from './support/fake-identity.js';
import { type FakeIssuer, startFakeIssuer } from './support/fake-issuer.js';
import { startTestDatabase, type TestDatabase } from './support/postgres.js';
import { startTestRedis, type TestRedis } from './support/redis.js';

let db: TestDatabase;
let redisServer: TestRedis;
let issuer: FakeIssuer;
let ds: DataSource;
let redis: Redis;
let app: NestFastifyApplication;
const idp = new FakeIdentityProvider();

const body = (over: Record<string, unknown> = {}) => ({
  username: 'alice_01',
  email: 'alice@example.com',
  password: 'correct-horse-battery',
  displayName: 'Alice',
  ...over,
});

const register = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/registrations',
    headers,
    payload: payload as object,
  });

const api = async (
  method: 'GET' | 'PATCH' | 'DELETE',
  url: string,
  as: { sub: string; roles?: string[] },
  extra: { headers?: Record<string, string>; payload?: object } = {},
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      authorization: `Bearer ${await issuer.token(as.sub, as.roles)}`,
      ...extra.headers,
    },
    payload: extra.payload,
  });

const seed = (over: Partial<User> = {}) =>
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

const outboxTypes = async () =>
  (await ds.getRepository(OutboxEvent).find({ order: { id: 'ASC' } })).map(
    (e) => e.eventType,
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

  const config = testConfig({
    db: db.db,
    redis: { url: redisServer.url },
    auth: { jwksUrl: issuer.jwksUrl },
    rateLimit: { registration: { capacity: 5, refillPerSecond: 0.001 } },
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

describe('POST /registrations', () => {
  it('creates the account, the profile, the outbox event and the audit row', async () => {
    const res = await register(body());
    expect(res.statusCode).toBe(201);
    const user = res.json();
    expect(res.headers.location).toBe(`/api/v1/users/${user.id}`);
    expect(user).toMatchObject({
      username: 'alice_01',
      email: 'alice@example.com',
      displayName: 'Alice',
      locale: 'en',
      status: 'ACTIVE',
      version: 1,
    });
    expect(res.body).not.toContain('correct-horse');

    expect(idp.created).toHaveLength(1);
    expect(idp.created[0]).toMatchObject({
      id: user.id,
      password: 'correct-horse-battery',
    });
    expect(idp.roles).toEqual([[user.id, 'USER']]);

    expect(
      await ds.getRepository(User).findOneByOrFail({ id: user.id }),
    ).toMatchObject({ username: 'alice_01' });
    const [event] = await ds.getRepository(OutboxEvent).find();
    expect(event).toMatchObject({
      eventType: 'UserRegistered',
      topic: 'account.user.registered.v1',
      aggregateId: user.id,
    });
    expect(Object.keys(event!.payload).sort()).toEqual([
      'email',
      'eventId',
      'locale',
      'occurredAt',
      'userId',
      'username',
    ]);
    expect(typeof event!.payload.occurredAt).toBe('number');
    expect(JSON.stringify(event!.payload)).not.toContain('correct-horse');
    expect(
      (await ds.getRepository(AuditLog).find()).map((a) => a.action),
    ).toEqual(['INSERT']);
  });

  it('defaults the locale from Accept-Language', async () => {
    const res = await register(body(), { 'accept-language': 'de-DE,de;q=0.9' });
    expect(res.json().locale).toBe('de');
  });

  it('rejects invalid input with field errors and creates nothing', async () => {
    const res = await register(
      body({
        username: 'a!',
        email: 'nope',
        password: 'short',
        displayName: '   ',
        extra: 1,
      }),
      { 'accept-language': 'de' },
    );
    expect(res.statusCode).toBe(400);
    const fields = res
      .json()
      .errors.map(
        (e: { field: string; code: string }) => `${e.field}:${e.code}`,
      );
    expect(fields).toEqual(
      expect.arrayContaining([
        'username:Size',
        'username:Pattern',
        'email:Email',
        'password:Size',
        'displayName:NotBlank',
        'extra:UnknownField',
      ]),
    );
    expect(idp.created).toHaveLength(0);
  });

  it('answers 409 per field when the username or email is taken (case-insensitive), localized', async () => {
    await seed({ username: 'Alice_01', email: 'ALICE@example.com' });
    const res = await register(body(), { 'accept-language': 'es' });
    expect(res.statusCode).toBe(409);
    expect(res.json().errors).toEqual([
      { field: 'username', code: 'Taken', message: 'Username ya está en uso.' },
      { field: 'email', code: 'Taken', message: 'Email ya está en uso.' },
    ]);
    expect(idp.created).toHaveLength(0);
  });

  it('answers 409 when only the identity system knows the username (e.g. seeded admin)', async () => {
    idp.takenUsernames.add('alice_01');
    const res = await register(body());
    expect(res.statusCode).toBe(409);
    expect(res.json().errors).toEqual([
      expect.objectContaining({ field: 'username', code: 'Taken' }),
    ]);
    expect(await ds.getRepository(User).count()).toBe(0);
  });

  it('undoes the Keycloak account when it loses a race for the username', async () => {
    idp.afterCreate = async (_id, input) => {
      await seed({
        username: input.username,
        email: 'someone-else@example.com',
      }); // the parallel winner commits first
    };
    const res = await register(body());
    expect(res.statusCode).toBe(409);
    expect(res.json().errors).toEqual([
      expect.objectContaining({ field: 'username', code: 'Taken' }),
    ]);
    expect(idp.deleted).toEqual([idp.created[0]!.id]);
    expect(await ds.getRepository(User).count()).toBe(1); // only the winner
    expect(await ds.getRepository(OutboxEvent).count()).toBe(0);
  });

  it('undoes the Keycloak account when the role assignment fails', async () => {
    idp.failRole = new UpstreamUnavailableException();
    const res = await register(body());
    expect(res.statusCode).toBe(503);
    expect(idp.deleted).toEqual([idp.created[0]!.id]);
    expect(await ds.getRepository(User).count()).toBe(0);
  });

  it('still reports the original error when the undo itself fails', async () => {
    idp.failRole = new UpstreamUnavailableException();
    idp.failDelete = new UpstreamUnavailableException();
    expect((await register(body())).statusCode).toBe(503);
  });

  it('answers 503 and creates nothing when Keycloak is down', async () => {
    idp.failCreate = new UpstreamUnavailableException();
    const res = await register(body());
    expect(res.statusCode).toBe(503);
    expect(res.json().type).toContain('upstream-unavailable');
    expect(await ds.getRepository(User).count()).toBe(0);
  });

  describe('Idempotency-Key', () => {
    it('replays the original response instead of registering twice', async () => {
      const first = await register(body(), { 'idempotency-key': 'key-1' });
      const second = await register(body(), { 'idempotency-key': 'key-1' });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(first.json());
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.headers.location).toBe(first.headers.location);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(idp.created).toHaveLength(1);
      expect(await ds.getRepository(User).count()).toBe(1);
    });

    it('rejects the same key with a different payload', async () => {
      await register(body(), { 'idempotency-key': 'key-2' });
      const res = await register(
        body({ username: 'bob_02', email: 'bob@example.com' }),
        { 'idempotency-key': 'key-2' },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().errors).toEqual([
        expect.objectContaining({ field: 'Idempotency-Key', code: 'Taken' }),
      ]);
    });

    it('treats a different password as a different request', async () => {
      await register(body(), { 'idempotency-key': 'key-3' });
      const res = await register(body({ password: 'another-password-123' }), {
        'idempotency-key': 'key-3',
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects malformed keys', async () => {
      const res = await register(body(), { 'idempotency-key': 'has spaces!' });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors).toEqual([
        expect.objectContaining({ field: 'Idempotency-Key', code: 'Pattern' }),
      ]);
    });

    it('releases the key when the first attempt fails, so a retry can succeed', async () => {
      idp.failCreate = new UpstreamUnavailableException();
      expect(
        (await register(body(), { 'idempotency-key': 'key-4' })).statusCode,
      ).toBe(503);
      idp.failCreate = undefined;
      expect(
        (await register(body(), { 'idempotency-key': 'key-4' })).statusCode,
      ).toBe(201);
    });

    it('answers 409 to a duplicate that arrives while the first request is still running', async () => {
      let release!: () => void;
      idp.beforeCreate = () =>
        new Promise<void>((resolve) => (release = resolve));
      const first = register(body(), { 'idempotency-key': 'key-5' });
      await new Promise((r) => setTimeout(r, 150));
      const dup = await register(body(), { 'idempotency-key': 'key-5' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().errors).toEqual([
        expect.objectContaining({ code: 'InProgress' }),
      ]);
      release();
      expect((await first).statusCode).toBe(201);
      expect(idp.created).toHaveLength(1);
    });
  });

  describe('rate limiting', () => {
    it('allows a burst, then answers 429 with Retry-After', async () => {
      for (let i = 0; i < 5; i++)
        expect(
          (
            await register(
              body({ username: `user_${i}`, email: `u${i}@example.com` }),
            )
          ).statusCode,
        ).toBe(201);
      const res = await register(
        body({ username: 'user_6', email: 'u6@example.com' }),
        { 'accept-language': 'de' },
      );
      expect(res.statusCode).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.json().title).toBe('Zu viele Anfragen');
    });

    it('fails open when Redis is unreachable', async () => {
      const dead = new Redis('redis://127.0.0.1:1', {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      dead.on('error', () => {});
      const limiter = new RateLimiter(dead, pino({ level: 'silent' }));
      expect(
        await limiter.consume('registration', 'ip:1', {
          capacity: 1,
          refillPerSecond: 0.001,
        }),
      ).toMatchObject({ allowed: true });
      dead.disconnect();
    });
  });
});

describe('GET /users/me and PATCH /users/me', () => {
  it('returns the own profile with an ETag, and is never cached', async () => {
    const user = await seed({ displayName: 'Me' });
    const res = await api('GET', '/users/me', { sub: user.id });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      id: user.id,
      email: user.email,
      displayName: 'Me',
    });
  });

  it('requires authentication, a profile, and a user-type token', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/users/me' })).statusCode,
    ).toBe(401);
    expect((await api('GET', '/users/me', { sub: newUuid() })).statusCode).toBe(
      404,
    );
    expect(
      (await api('GET', '/users/me', { sub: newUuid(), roles: ['internal'] }))
        .statusCode,
    ).toBe(403);
  });

  it('updates with a matching If-Match, bumps the version, emits an event and audits the actor', async () => {
    const user = await seed({ bio: 'old' });
    const res = await api(
      'PATCH',
      '/users/me',
      { sub: user.id },
      {
        headers: { 'if-match': '"1"' },
        payload: { displayName: '  New Name ', bio: '', locale: 'de' },
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(res.json()).toMatchObject({
      displayName: 'New Name',
      bio: null,
      locale: 'de',
      version: 2,
    });
    expect(await outboxTypes()).toEqual(['UserProfileUpdated']);
    const [audit] = (
      await ds.getRepository(AuditLog).find({ order: { id: 'ASC' } })
    ).filter((a) => a.action === 'UPDATE');
    expect(audit).toMatchObject({ actorId: user.id, entityId: user.id });
    expect(audit!.before).toMatchObject({ displayName: 'Seeded' });
    expect(audit!.after).toMatchObject({ displayName: 'New Name' });
  });

  it('rejects a stale ETag with 409 and a missing or malformed If-Match with 400', async () => {
    const user = await seed();
    const as = { sub: user.id };
    expect(
      (
        await api('PATCH', '/users/me', as, {
          headers: { 'if-match': '"9"' },
          payload: { bio: 'x' },
        })
      ).statusCode,
    ).toBe(409);
    const missing = await api('PATCH', '/users/me', as, {
      payload: { bio: 'x' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().errors).toEqual([
      expect.objectContaining({ field: 'If-Match', code: 'NotBlank' }),
    ]);
    expect(
      (
        await api('PATCH', '/users/me', as, {
          headers: { 'if-match': 'abc' },
          payload: { bio: 'x' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('rejects an empty body, unknown fields and a blank display name', async () => {
    const user = await seed();
    const h = { 'if-match': '"1"' };
    expect(
      (
        await api(
          'PATCH',
          '/users/me',
          { sub: user.id },
          { headers: h, payload: {} },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api(
          'PATCH',
          '/users/me',
          { sub: user.id },
          { headers: h, payload: { status: 'SUSPENDED' } },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api(
          'PATCH',
          '/users/me',
          { sub: user.id },
          { headers: h, payload: { displayName: '  ' } },
        )
      ).statusCode,
    ).toBe(400);
  });

  it('treats a patch that changes nothing as a no-op (same version, no event)', async () => {
    const user = await seed({ displayName: 'Same' });
    const res = await api(
      'PATCH',
      '/users/me',
      { sub: user.id },
      { headers: { 'if-match': '"1"' }, payload: { displayName: 'Same' } },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(1);
    expect(await outboxTypes()).toEqual([]);
  });

  it('lets exactly one of two concurrent updates with the same ETag win', async () => {
    const user = await seed();
    const attempt = (name: string) =>
      api(
        'PATCH',
        '/users/me',
        { sub: user.id },
        { headers: { 'if-match': '"1"' }, payload: { displayName: name } },
      );
    const results = await Promise.all([attempt('A'), attempt('B')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(
      (await ds.getRepository(User).findOneByOrFail({ id: user.id })).version,
    ).toBe(2);
  });
});

describe('GET /users/:id and GET /users', () => {
  it('shows the email only to the owner and privileged callers', async () => {
    const target = await seed({ displayName: 'Target' });
    const other = await api('GET', `/users/${target.id}`, { sub: newUuid() });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({
      id: target.id,
      displayName: 'Target',
    });
    expect(other.json()).not.toHaveProperty('email');
    expect(
      (await api('GET', `/users/${target.id}`, { sub: target.id })).json()
        .email,
    ).toBe(target.email);
    expect(
      (
        await api('GET', `/users/${target.id}`, {
          sub: newUuid(),
          roles: ['USER', 'ADMIN'],
        })
      ).json().email,
    ).toBe(target.email);
    expect(
      (
        await api('GET', `/users/${target.id}`, {
          sub: newUuid(),
          roles: ['internal'],
        })
      ).json().email,
    ).toBe(target.email);
    expect(
      (
        await api('GET', `/users/${target.id}`, {
          sub: newUuid(),
          roles: ['USER', 'MODERATOR'],
        })
      ).json(),
    ).not.toHaveProperty('email');
  });

  it('answers 400 for a malformed id and 404 for an unknown one', async () => {
    expect(
      (await api('GET', '/users/not-a-uuid', { sub: newUuid() })).json().errors,
    ).toEqual([expect.objectContaining({ field: 'id', code: 'Pattern' })]);
    expect(
      (await api('GET', `/users/${newUuid()}`, { sub: newUuid() })).statusCode,
    ).toBe(404);
  });

  it('lists users for admins only, with pagination, sorting and a size cap', async () => {
    for (const name of ['carol', 'alice', 'bob'])
      await seed({ username: name });
    const admin = { sub: newUuid(), roles: ['USER', 'ADMIN'] };
    expect((await api('GET', '/users', { sub: newUuid() })).statusCode).toBe(
      403,
    );

    const page = await api(
      'GET',
      '/users?size=2&page=0&sort=username,asc',
      admin,
    );
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      page: 0,
      size: 2,
      totalItems: 3,
      totalPages: 2,
    });
    expect(
      page.json().items.map((u: { username: string }) => u.username),
    ).toEqual(['alice', 'bob']);
    expect(page.json().items[0]).toHaveProperty('email');
    expect(
      (await api('GET', '/users?size=2&page=1&sort=username,asc', admin)).json()
        .items,
    ).toHaveLength(1);

    expect((await api('GET', '/users?size=101', admin)).statusCode).toBe(400);
    expect((await api('GET', '/users?sort=email,asc', admin)).statusCode).toBe(
      400,
    );
  });
});

describe('DELETE /users/:id', () => {
  it('refuses a stranger', async () => {
    const victim = await seed();
    expect(
      (await api('DELETE', `/users/${victim.id}`, { sub: newUuid() }))
        .statusCode,
    ).toBe(403);
    expect(idp.deleted).toEqual([]);
  });

  it('lets the owner delete their account: Keycloak, soft delete, event, audit, username freed', async () => {
    const res0 = await register(body());
    const id = res0.json().id as string;
    const res = await api('DELETE', `/users/${id}`, { sub: id });
    expect(res.statusCode).toBe(204);
    expect(idp.deleted).toEqual([id]);
    expect(await ds.getRepository(User).count()).toBe(0);
    expect(await ds.getRepository(User).count({ withDeleted: true })).toBe(1);
    expect(await outboxTypes()).toEqual(['UserRegistered', 'UserDeleted']);
    expect(
      (await ds.getRepository(AuditLog).find({ order: { id: 'ASC' } })).map(
        (a) => a.action,
      ),
    ).toEqual(['INSERT', 'DELETE']);
    expect((await api('GET', `/users/${id}`, { sub: id })).statusCode).toBe(
      404,
    );
    expect((await register(body())).statusCode).toBe(201); // same username and email can register again
  });

  it('lets an admin delete someone else, and answers 404 for unknown users', async () => {
    const victim = await seed();
    const admin = { sub: newUuid(), roles: ['USER', 'ADMIN'] };
    expect((await api('DELETE', `/users/${victim.id}`, admin)).statusCode).toBe(
      204,
    );
    expect((await api('DELETE', `/users/${newUuid()}`, admin)).statusCode).toBe(
      404,
    );
  });

  it('keeps the profile when Keycloak is down, so the call can simply be repeated', async () => {
    const user = await seed();
    idp.failDelete = new UpstreamUnavailableException();
    expect(
      (await api('DELETE', `/users/${user.id}`, { sub: user.id })).statusCode,
    ).toBe(503);
    expect(await ds.getRepository(User).count()).toBe(1);
    idp.failDelete = undefined;
    expect(
      (await api('DELETE', `/users/${user.id}`, { sub: user.id })).statusCode,
    ).toBe(204);
  });
});
