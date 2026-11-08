import { Redis } from 'ioredis';
import { pino } from 'pino';
import { DataSource } from 'typeorm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { AppConfig } from '../src/config/config.js';
import { OutboxCleanupJob } from '../src/jobs/outbox-cleanup.job.js';
import { JobScheduler, type ScheduledJob } from '../src/jobs/job-scheduler.js';
import { OutboxMonitor } from '../src/jobs/outbox-monitor.js';
import { OutboxRelay } from '../src/jobs/outbox-relay.js';
import { UserPurgeJob } from '../src/jobs/user-purge.job.js';
import { createDataSource } from '../src/repository/data-source.js';
import { AuditLog } from '../src/repository/entities/audit-log.entity.js';
import { OutboxEvent } from '../src/repository/entities/outbox-event.entity.js';
import { User } from '../src/repository/entities/user.entity.js';
import { OutboxRepository } from '../src/repository/outbox.repository.js';
import { DistributedLock } from '../src/resilience/distributed-lock.js';
import { Clock } from '../src/util/clock.js';
import { newUuid } from '../src/util/ids.js';
import { testConfig } from './support/config.js';
import { FakePublisher, latch, waitFor } from './support/fake-publisher.js';
import { startTestDatabase, type TestDatabase } from './support/postgres.js';
import { startTestRedis, type TestRedis } from './support/redis.js';

let db: TestDatabase;
let redisServer: TestRedis;
let ds: DataSource;
let redis: Redis;
const outbox = new OutboxRepository();
const publisher = new FakePublisher();
const logger = pino({ level: 'silent' });
const relays: OutboxRelay[] = [];

const config = (over: Partial<AppConfig['outbox']> = {}): AppConfig =>
  testConfig({
    db: db.db,
    redis: { url: redisServer.url },
    outbox: {
      relayEnabled: true,
      pollIntervalMs: 30,
      batchSize: 50,
      maxBackoffMs: 1000,
      retentionHours: 24,
      ...over,
    },
  });

const makeRelay = (
  over: Partial<AppConfig['outbox']> = {},
  pub: FakePublisher = publisher,
) => {
  const relay = new OutboxRelay(ds, outbox, pub, config(over), logger);
  relays.push(relay);
  return relay;
};

/** Writes one outbox row in its own transaction, like a committed business operation would. */
async function enqueue(aggregateId: string, n = 1): Promise<string> {
  const eventId = newUuid();
  await ds.transaction((m) =>
    outbox.enqueue(m, {
      eventId,
      aggregateType: 'User',
      aggregateId,
      eventType: 'UserDeleted',
      topic: 'account.user.deleted.v1',
      payload: { eventId, userId: aggregateId, occurredAt: n },
      headers: { trace_id: 'a'.repeat(32) },
    }),
  );
  return eventId;
}

const rows = () => ds.getRepository(OutboxEvent).find({ order: { id: 'ASC' } });
const keys = () => publisher.published.map((e) => e.key);

beforeAll(async () => {
  [db, redisServer] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
  ]);
  const admin = createDataSource(db.db);
  await admin.initialize();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.runMigrations();
  await admin.destroy();
  ds = createDataSource(db.db);
  await ds.initialize();
  redis = new Redis(redisServer.url);
});

afterAll(async () => {
  await ds?.destroy();
  redis?.disconnect();
  await db?.stop();
  await redisServer?.stop();
});

beforeEach(async () => {
  await ds.query('TRUNCATE users, outbox_event, audit_log RESTART IDENTITY');
  await redis.flushdb();
  publisher.reset();
});

afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.shutdown()));
});

describe('relay: one cycle', () => {
  it('publishes in order, marks rows published, and never re-sends them', async () => {
    await enqueue('a');
    await enqueue('b');
    await enqueue('c');
    const relay = makeRelay();

    expect(await relay.tick()).toMatchObject({
      claimed: 3,
      published: 3,
      rejected: 0,
    });
    expect(keys()).toEqual(['a', 'b', 'c']);
    expect(publisher.published[0]).toMatchObject({
      topic: 'account.user.deleted.v1',
      eventType: 'UserDeleted',
      headers: { trace_id: 'a'.repeat(32) },
    });
    expect((await rows()).every((r) => r.publishedAt !== null)).toBe(true);

    expect(await relay.tick()).toMatchObject({ claimed: 0 });
    expect(publisher.published).toHaveLength(3);
  });

  it('sends only the earliest event of each aggregate per cycle, so one aggregate stays in order', async () => {
    await enqueue('x', 1);
    await enqueue('x', 2);
    await enqueue('x', 3);
    const relay = makeRelay();
    for (let i = 0; i < 3; i++)
      expect(await relay.tick()).toMatchObject({ claimed: 1, published: 1 });
    expect(publisher.published.map((e) => e.payload.occurredAt)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('relay: broker outage', () => {
  it('keeps events, counts the attempt, and delivers everything after the broker returns', async () => {
    const ids = [await enqueue('a'), await enqueue('b')];
    const relay = makeRelay();
    publisher.down = new Error('broker unreachable');

    const failed = await relay.tick();
    expect(failed.error?.message).toBe('broker unreachable');
    expect((await rows()).map((r) => [r.publishedAt, r.attempts])).toEqual([
      [null, 1],
      [null, 1],
    ]);
    expect(relay.status()).toMatchObject({
      consecutiveFailures: 1,
      lastError: 'broker unreachable',
      failedBatchesTotal: 1,
    });

    publisher.down = undefined;
    expect(await relay.tick()).toMatchObject({ published: 2 });
    expect(publisher.published.map((e) => e.eventId)).toEqual(ids);
    expect(relay.status()).toMatchObject({
      consecutiveFailures: 0,
      publishedTotal: 2,
    });
  });

  it('the running loop retries with backoff and loses nothing while the broker is down', async () => {
    publisher.down = new Error('broker unreachable');
    const relay = makeRelay({ pollIntervalMs: 20, maxBackoffMs: 1000 });
    relay.start();
    for (const k of ['a', 'b', 'c']) await enqueue(k);

    await waitFor(
      () => relay.status().consecutiveFailures >= 2,
      8000,
      'two failed attempts',
    );
    expect(publisher.published).toHaveLength(0);

    publisher.down = undefined;
    await waitFor(
      () => publisher.published.length === 3,
      8000,
      'backlog delivered',
    );
    expect(keys()).toEqual(['a', 'b', 'c']);
    await relay.shutdown();
    expect((await rows()).every((r) => r.publishedAt)).toBe(true);
  });
});

describe('relay: an event that can never be published', () => {
  it('holds back only that aggregate; others flow; order is kept once fixed', async () => {
    const a1 = await enqueue('a', 1);
    await enqueue('a', 2);
    await enqueue('b', 1);
    publisher.poison.add(a1);
    const relay = makeRelay();

    expect(await relay.tick()).toMatchObject({
      claimed: 2,
      published: 1,
      rejected: 1,
    });
    expect(keys()).toEqual(['b']);
    await relay.tick();
    await relay.tick();
    expect(keys()).toEqual(['b']); // a2 never overtakes a1
    expect((await rows()).find((r) => r.eventId === a1)!.attempts).toBe(3);

    publisher.poison.clear(); // the bug is fixed
    await relay.tick();
    await relay.tick();
    expect(
      publisher.published.map((e) => `${e.key}:${e.payload.occurredAt}`),
    ).toEqual(['b:1', 'a:1', 'a:2']);
  });
});

describe('relay: several instances', () => {
  it('never publishes one aggregate concurrently, and different aggregates in parallel', async () => {
    await enqueue('x', 1);
    await enqueue('x', 2);
    await enqueue('y', 1);
    await enqueue('z', 1);
    await enqueue('w', 1);

    const hold = latch();
    let firstCall = true; // only relay 1's publish is held; relay 2 must be able to publish meanwhile
    publisher.gate = async () => {
      if (!firstCall) return;
      firstCall = false;
      await hold.wait();
    };
    const relay1 = makeRelay({ batchSize: 2 });
    const relay2 = makeRelay({ batchSize: 2 });

    const first = relay1.tick(); // claims x1 and y1, then waits in "publish"
    await waitFor(() => publisher.calls === 1, 5000, 'relay 1 to claim');
    const second = await relay2.tick(); // must skip x1/y1 (locked) and x2 (behind x1)
    expect(second).toMatchObject({ claimed: 2 });
    hold.open();
    await first;

    expect(
      publisher.published.map((e) => `${e.key}:${e.payload.occurredAt}`).sort(),
    ).toEqual(['w:1', 'x:1', 'y:1', 'z:1']);
    publisher.gate = undefined;
    await relay1.tick();
    expect(
      publisher.published
        .filter((e) => e.key === 'x')
        .map((e) => e.payload.occurredAt),
    ).toEqual([1, 2]);
  });
});

describe('relay: wake-up and shutdown', () => {
  it('is woken by LISTEN/NOTIFY instead of waiting for the next poll', async () => {
    const relay = makeRelay({ pollIntervalMs: 30_000 });
    relay.start();
    await new Promise((r) => setTimeout(r, 600)); // let it go idle and start listening
    const started = Date.now();
    await enqueue('fast');
    await waitFor(
      () => publisher.published.length === 1,
      5000,
      'notify-driven publish',
    );
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('shutdown waits for the batch in flight to be committed', async () => {
    await enqueue('a');
    const hold = latch();
    publisher.gate = hold.wait;
    const relay = makeRelay();
    relay.start();
    await waitFor(() => publisher.calls === 1, 5000, 'batch in flight');

    let stopped = false;
    const stopping = relay.shutdown().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 200));
    expect(stopped).toBe(false); // still waiting for the publish

    hold.open();
    await stopping;
    expect((await rows())[0]!.publishedAt).not.toBeNull();
  });

  it('does nothing when started twice or shut down twice', async () => {
    const relay = makeRelay();
    relay.start();
    relay.start();
    await relay.shutdown();
    await relay.shutdown();
    expect(relay.status().running).toBe(false);
  });
});

describe('monitoring', () => {
  it('reports backlog numbers and turns unhealthy after repeated failures', async () => {
    await enqueue('a');
    await enqueue('b');
    const relay = makeRelay();
    const monitor = new OutboxMonitor(ds, outbox, relay, config());

    expect(await monitor.snapshot()).toMatchObject({
      unpublished: 2,
      maxAttempts: 0,
    });
    expect(await monitor.health()).toEqual({ ok: true });

    publisher.down = new Error('kafka is down');
    for (let i = 0; i < 3; i++) await relay.tick();
    expect(await monitor.snapshot()).toMatchObject({
      unpublished: 2,
      maxAttempts: 3,
    });
    expect(await monitor.health()).toEqual({
      ok: false,
      reason: 'relay failing: kafka is down',
    });

    expect(
      await new OutboxMonitor(
        ds,
        outbox,
        relay,
        config({ relayEnabled: false }),
      ).health(),
    ).toEqual({ ok: true });
  });
});

class FixedClock extends Clock {
  constructor(private readonly at: Date) {
    super();
  }
  now(): Date {
    return this.at;
  }
}

describe('background jobs', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const clock = new FixedClock(now);

  it('outbox cleanup deletes only published events older than the retention', async () => {
    for (const k of ['old', 'recent', 'pending']) await enqueue(k);
    await ds.query(
      `UPDATE outbox_event SET published_at = '2026-10-10T00:00:00Z' WHERE aggregate_id = 'old'`,
    );
    await ds.query(
      `UPDATE outbox_event SET published_at = '2026-10-25T11:00:00Z' WHERE aggregate_id = 'recent'`,
    );

    await new OutboxCleanupJob(
      ds,
      outbox,
      clock,
      config({ retentionHours: 24 }),
      logger,
    ).run(new AbortController().signal);
    expect((await rows()).map((r) => r.aggregateId)).toEqual([
      'recent',
      'pending',
    ]);
  });

  it('user purge erases old soft-deleted users and scrubs their audit snapshots', async () => {
    const make = async (username: string, deletedAt: string | null) => {
      const user = await ds.getRepository(User).save(
        Object.assign(new User(), {
          id: newUuid(),
          username,
          email: `${username}@example.com`,
          displayName: username,
          locale: 'en',
          status: 'ACTIVE',
          bio: null,
        }),
      );
      if (deletedAt) {
        await ds.getRepository(User).softRemove(user);
        await ds.query(`UPDATE users SET deleted_at = $1 WHERE id = $2`, [
          deletedAt,
          user.id,
        ]);
      }
      return user;
    };
    const old = await make('old_gone', '2026-08-01T00:00:00Z');
    const recent = await make('recent_gone', '2026-10-20T00:00:00Z');
    const live = await make('still_here', null);

    await new UserPurgeJob(
      ds,
      clock,
      testConfig({ db: db.db, jobs: { userPurgeAfterDays: 30 } }),
      logger,
    ).run(new AbortController().signal);

    const remaining = (await ds.getRepository(User).find({ withDeleted: true }))
      .map((u) => u.username)
      .sort();
    expect(remaining).toEqual(['recent_gone', 'still_here']);

    const oldAudit = await ds
      .getRepository(AuditLog)
      .find({ where: { entityId: old.id }, order: { id: 'ASC' } });
    expect(oldAudit.map((a) => a.action)).toEqual([
      'INSERT',
      'DELETE',
      'PURGE',
    ]);
    expect(oldAudit.every((a) => a.before === null && a.after === null)).toBe(
      true,
    );
    const keptAudit = await ds
      .getRepository(AuditLog)
      .find({ where: { entityId: recent.id, action: 'INSERT' } });
    expect(keptAudit[0]!.after).toMatchObject({
      email: 'recent_gone@example.com',
    });
    expect(live.deletedAt ?? null).toBeNull();
  });

  describe('scheduler lock', () => {
    const scheduler = (job: ScheduledJob) =>
      new JobScheduler(
        [job],
        new DistributedLock(redis, logger),
        testConfig({ db: db.db, jobs: { enabled: true } }),
        logger,
      );

    it('runs a job on only one instance at a time, and again after it finished', async () => {
      const hold = latch();
      let runs = 0;
      const job: ScheduledJob = {
        name: 'slow',
        run: async () => {
          runs++;
          await hold.wait();
        },
      };
      const a = scheduler(job);
      const b = scheduler(job);

      const running = a.runNow('slow');
      await waitFor(() => runs === 1, 3000, 'first run to start');
      expect(await b.runNow('slow')).toBe(false); // lock held by `a`
      hold.open();
      expect(await running).toBe(true);
      expect(await b.runNow('slow')).toBe(true); // lock released
      expect(runs).toBe(2);
    });

    it('releases the lock when a job throws, and reports it as not run', async () => {
      let fail = true;
      const job: ScheduledJob = {
        name: 'flaky',
        run: async () => {
          if (fail) throw new Error('boom');
        },
      };
      const s = scheduler(job);
      expect(await s.runNow('flaky')).toBe(false);
      fail = false;
      expect(await s.runNow('flaky')).toBe(true);
    });

    it('skips the run when Redis is unreachable', async () => {
      const dead = new Redis('redis://127.0.0.1:1', {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      dead.on('error', () => {});
      const s = new JobScheduler(
        [{ name: 'x', run: async () => {} }],
        new DistributedLock(dead, logger),
        testConfig({ jobs: { enabled: true } }),
        logger,
      );
      expect(await s.runNow('x')).toBe(false);
      dead.disconnect();
    });
  });
});
