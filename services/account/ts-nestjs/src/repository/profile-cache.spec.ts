import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../test/support/config.js';
import { User } from './entities/user.entity.js';
import { ProfileCache } from './profile-cache.js';

const user = Object.assign(new User(), {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'alice',
  email: 'alice@example.com',
  displayName: 'Alice',
  locale: 'en',
  bio: null,
  avatarAssetId: null,
  bannerAssetId: null,
  status: 'ACTIVE',
  createdAt: new Date('2026-10-25T10:00:00Z'),
  updatedAt: new Date('2026-10-25T10:00:00Z'),
  version: 1,
});

/** A Redis that always fails, and counts how often it was asked. */
function deadRedis() {
  const calls = { n: 0 };
  const fail = async () => {
    calls.n++;
    throw new Error('connection refused');
  };
  return {
    redis: { get: fail, mget: fail, eval: fail } as unknown as Redis,
    calls,
  };
}

const cacheWith = (
  redis: Redis,
  over: Partial<{ enabled: boolean; cooldownMs: number }> = {},
) =>
  new ProfileCache(
    redis,
    testConfig({ cache: { enabled: true, cooldownMs: 60, ...over } }),
    pino({ level: 'silent' }),
  );

describe('ProfileCache without a working Redis', () => {
  it('serves from the database, and stops asking Redis during the cool-down', async () => {
    const { redis, calls } = deadRedis();
    const cache = cacheWith(redis);
    let loads = 0;
    const load = async () => (++loads, user);

    expect(await cache.get(user.id, load)).toBe(user);
    expect(calls.n).toBe(1); // the first call discovers the problem
    expect(cache.stats()).toMatchObject({ bypassed: true, errors: 1 });

    for (let i = 0; i < 5; i++) await cache.get(user.id, load);
    expect(calls.n).toBe(1); // bypassed: Redis is not even contacted
    expect(loads).toBe(6);
  });

  it('tries Redis again after the cool-down', async () => {
    const { redis, calls } = deadRedis();
    const cache = cacheWith(redis, { cooldownMs: 40 });
    await cache.get(user.id, async () => user);
    await new Promise((r) => setTimeout(r, 60));
    await cache.get(user.id, async () => user);
    expect(calls.n).toBe(2);
  });

  it('answers batch lookups from the database too', async () => {
    const { redis } = deadRedis();
    const result = await cacheWith(redis).getMany([user.id], async (ids) =>
      ids.length === 1 ? [user] : [],
    );
    expect([...result.keys()]).toEqual([user.id]);
  });

  it('never throws from invalidate, but reports the failure', async () => {
    const { redis } = deadRedis();
    const cache = cacheWith(redis);
    await expect(cache.invalidate(user.id, 2)).resolves.toBeUndefined();
    await expect(cache.markDeleted(user.id)).resolves.toBeUndefined();
    expect(cache.stats().invalidationFailures).toBe(2);
  });
});

describe('ProfileCache when disabled', () => {
  it('goes straight to the database and never touches Redis', async () => {
    const { redis, calls } = deadRedis();
    const cache = cacheWith(redis, { enabled: false });
    let loads = 0;
    await cache.get(user.id, async () => (++loads, user));
    await cache.get(user.id, async () => (++loads, user));
    await cache.invalidate(user.id, 2);
    expect(loads).toBe(2);
    expect(calls.n).toBe(0);
  });
});
