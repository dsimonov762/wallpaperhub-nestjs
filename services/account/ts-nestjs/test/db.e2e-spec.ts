import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runInContext } from '../src/api/http/request-context.js';
import { setupHttp } from '../src/api/http/setup-http.js';
import { HealthService } from '../src/api/http/health.service.js';
import { ManagementServer } from '../src/api/http/management.server.js';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import type { AppConfig } from '../src/config/config.js';
import { LOGGER } from '../src/infra/logger.js';
import { createDataSource } from '../src/repository/data-source.js';
import { AuditLog } from '../src/repository/entities/audit-log.entity.js';
import { OutboxEvent } from '../src/repository/entities/outbox-event.entity.js';
import { User } from '../src/repository/entities/user.entity.js';
import { OutboxRepository } from '../src/repository/outbox.repository.js';
import { newUuid } from '../src/util/ids.js';
import { testConfig } from './support/config.js';
import { startTestRedis, type TestRedis } from './support/redis.js';
import { startTestDatabase, type TestDatabase } from './support/postgres.js';

let testDb: TestDatabase;
let testRedis: TestRedis;
let ds: DataSource;
const outbox = new OutboxRepository();

const newUser = (over: Partial<User> = {}): User =>
  Object.assign(new User(), {
    id: newUuid(),
    username: `user_${Math.random().toString(36).slice(2, 8)}`,
    email: `${Math.random().toString(36).slice(2, 8)}@example.com`,
    displayName: 'Test User',
    locale: 'en',
    status: 'ACTIVE',
    ...over,
  });

const event = (aggregateId: string, n: number) => ({
  eventId: newUuid(),
  aggregateType: 'User',
  aggregateId,
  eventType: 'UserRegistered',
  topic: 'account.user.registered.v1',
  payload: { n },
});

beforeAll(async () => {
  testDb = await startTestDatabase();
  testRedis = await startTestRedis();
  ds = createDataSource(testDb.db);
  await ds.initialize();
  await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});

afterAll(async () => {
  await ds?.destroy();
  await testDb?.stop();
  await testRedis?.stop();
});

describe('migrations', () => {
  it('create the schema, and running again applies nothing', async () => {
    const first = await ds.runMigrations();
    expect(first.map((m) => m.name)).toEqual([
      'InitAccountSchema1761264000000',
      'OutboxNotify1761350400000',
    ]);
    const tables = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual(
      expect.arrayContaining([
        'users',
        'outbox_event',
        'audit_log',
        'migrations',
      ]),
    );
    expect(await ds.runMigrations()).toEqual([]);
  });
});

describe('users + audit subscriber', () => {
  beforeEach(async () => {
    await ds.query('TRUNCATE users, outbox_event, audit_log RESTART IDENTITY');
  });

  it('writes INSERT / UPDATE / DELETE audit rows with actor and trace id', async () => {
    const repo = ds.getRepository(User);
    const user = newUser();

    await runInContext(
      {
        requestId: 'r1',
        traceId: 'a'.repeat(32),
        locale: 'en',
        userId: 'actor-1',
      },
      async () => {
        await repo.save(user);
        const loaded = await repo.findOneByOrFail({ id: user.id });
        loaded.displayName = 'Renamed';
        await repo.save(loaded);
        await repo.softRemove(loaded);
      },
    );

    const audit = await ds
      .getRepository(AuditLog)
      .find({ order: { id: 'ASC' } });
    expect(audit.map((a) => a.action)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    expect(
      audit.every(
        (a) =>
          a.entityId === user.id &&
          a.actorId === 'actor-1' &&
          a.traceId === 'a'.repeat(32),
      ),
    ).toBe(true);
    expect(audit[0]!.after).toMatchObject({ email: user.email });
    expect(audit[1]!.before).toMatchObject({ displayName: 'Test User' });
    expect(audit[1]!.after).toMatchObject({ displayName: 'Renamed' });
  });

  it('bumps the optimistic-lock version on update', async () => {
    const repo = ds.getRepository(User);
    const user = await repo.save(newUser());
    const v1 = (await repo.findOneByOrFail({ id: user.id })).version;
    await repo.update({ id: user.id }, { displayName: 'Again' });
    expect((await repo.findOneByOrFail({ id: user.id })).version).toBe(v1 + 1);
  });

  it('enforces case-insensitive unique usernames and emails among live users', async () => {
    const repo = ds.getRepository(User);
    await repo.save(newUser({ username: 'Alice', email: 'alice@example.com' }));
    await expect(
      repo.save(newUser({ username: 'alice' })),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
    await expect(
      repo.save(newUser({ email: 'ALICE@example.com' })),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });
});

describe('transactional outbox', () => {
  beforeEach(async () => {
    await ds.query('TRUNCATE users, outbox_event, audit_log RESTART IDENTITY');
  });

  it('commits the user and the event together', async () => {
    const user = newUser();
    await ds.transaction(async (m) => {
      await m.save(user);
      await outbox.enqueue(m, event(user.id, 1));
    });
    expect(await ds.getRepository(User).count()).toBe(1);
    expect(await ds.getRepository(OutboxEvent).count()).toBe(1);
  });

  it('rolls back the user and the event together (no phantom events)', async () => {
    const user = newUser();
    await expect(
      ds.transaction(async (m) => {
        await m.save(user);
        await outbox.enqueue(m, event(user.id, 1));
        throw new Error('crash before commit');
      }),
    ).rejects.toThrowError('crash before commit');
    expect(await ds.getRepository(User).count()).toBe(0);
    expect(await ds.getRepository(OutboxEvent).count()).toBe(0);
  });

  it('lets two relays claim disjoint batches (FOR UPDATE SKIP LOCKED)', async () => {
    await ds.transaction(async (m) => {
      for (let i = 1; i <= 4; i++)
        await outbox.enqueue(m, event(`agg-${i}`, i));
    });

    const a = ds.createQueryRunner();
    const b = ds.createQueryRunner();
    await a.connect();
    await b.connect();
    await a.startTransaction();
    await b.startTransaction();
    try {
      const claimedA = await outbox.claimUnpublished(a.manager, 2);
      const claimedB = await outbox.claimUnpublished(b.manager, 2); // would block forever without SKIP LOCKED
      const idsA = claimedA.map((e) => e.id);
      const idsB = claimedB.map((e) => e.id);
      expect(idsA).toHaveLength(2);
      expect(idsB).toHaveLength(2);
      expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
      expect(idsA.concat(idsB).sort()).toEqual(['1', '2', '3', '4']); // global order is preserved per batch

      await outbox.markPublished(a.manager, idsA);
      await a.commitTransaction();
      await outbox.recordFailure(b.manager, idsB);
      await b.commitTransaction();
    } finally {
      await a.release();
      await b.release();
    }

    const rows = await ds
      .getRepository(OutboxEvent)
      .find({ order: { id: 'ASC' } });
    expect(rows.filter((r) => r.publishedAt).map((r) => r.id)).toEqual([
      '1',
      '2',
    ]);
    expect(
      rows.filter((r) => !r.publishedAt).every((r) => r.attempts === 1),
    ).toBe(true);
    // Locking reads must run inside a transaction (TypeORM enforces this).
    expect(
      await ds.transaction((m) => outbox.claimUnpublished(m, 10)),
    ).toHaveLength(2);
  });
});

describe('whole application wiring', () => {
  let app: NestFastifyApplication;
  const config = (): AppConfig =>
    testConfig({ db: testDb.db, redis: { url: testRedis.url } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    setupHttp(app, app.get(LOGGER));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app?.close());

  it('serves problem+json for unknown routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nothing-here',
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('management endpoints: live, startup, ready', async () => {
    const mgmt = app.get(ManagementServer).build();
    const health = app.get(HealthService);

    expect((await mgmt.inject('/health/live')).statusCode).toBe(200);
    expect((await mgmt.inject('/health/startup')).statusCode).toBe(503);
    health.markStarted();
    expect((await mgmt.inject('/health/startup')).statusCode).toBe(200);

    const ready = await mgmt.inject('/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'UP',
      checks: {
        postgres: { status: 'UP', critical: true },
        redis: { status: 'UP', critical: false },
        outbox: { status: 'UP', critical: false },
      },
    });

    health.markDraining();
    expect((await mgmt.inject('/health/ready')).statusCode).toBe(503);
    await mgmt.close();
  });
});

describe('readiness with Redis down', () => {
  it('stays UP overall but reports the failed dependency', async () => {
    const failingRedis = {
      ping: async () => Promise.reject(new Error('connection refused')),
    };
    const health = new HealthService(
      ds,
      failingRedis as never,
      { health: async () => ({ ok: true }) } as never,
    );
    const report = await health.readiness();
    expect(report.status).toBe('UP');
    expect(report.checks.redis).toMatchObject({
      status: 'DOWN',
      critical: false,
      error: 'connection refused',
    });
    expect(report.checks.postgres).toMatchObject({
      status: 'UP',
      critical: true,
    });
  });
});
