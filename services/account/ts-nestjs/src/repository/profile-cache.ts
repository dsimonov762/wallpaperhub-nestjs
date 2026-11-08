import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import { LOGGER } from '../infra/logger.js';
import { REDIS } from '../infra/redis.module.js';
import { sleep } from '../util/sleep.js';
import { User } from './entities/user.entity.js';

/**
 * Cache-aside for user profiles (README 4.1, step 1.4).
 *
 *   read:   Redis hit -> done.  Miss -> ONE database load per key (single flight) -> fill Redis.
 *   write:  commit to the database first, THEN invalidate.
 *
 * The classic race this cache is designed against: reader A loads an old row from the database, writer B
 * commits and invalidates, THEN A stores its old row, so the stale profile lives until the TTL ends.
 * Every entry therefore carries the row's `version`, and Redis (atomically, in Lua) refuses to replace
 * newer data with older data. Invalidation does not just delete: it leaves a short-lived tombstone that
 * remembers "version N is the truth now", so a late reader holding version N-1 is turned away.
 *
 *   entry u  = a profile at version v          { t:'u', v, u:{...} }
 *   entry n  = "no such user"                  { t:'n', v:0 }       (or v = MAX after a delete)
 *   entry x  = tombstone, "reload from the DB" { t:'x', v }
 *
 * Redis is an optimisation, never a dependency: any Redis error bypasses the cache for `cooldownMs`.
 * Entries contain the email address, so Redis must stay on the internal network.
 */

const MAX_VERSION = Number.MAX_SAFE_INTEGER;
const TOMBSTONE_TTL_MS = 30_000;
const KEY_PREFIX = 'profile:v1:';
const INVALIDATION_RETRY_DELAYS_MS = [0, 50, 150];

/** Store `new` unless Redis holds newer (or equally new) data. A tombstone accepts data at its own version or later. */
const FILL = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, c = pcall(cjson.decode, cur)
  if ok and type(c) == 'table' and c.v then
    local nv = tonumber(ARGV[1])
    if c.t == 'x' then
      if nv < c.v then return 0 end
    elseif nv <= c.v then
      return 0
    end
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

/** Replace whatever is there with `new`, unless Redis already holds a NEWER version. (Unreadable entries are overwritten.) */
const REPLACE = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, c = pcall(cjson.decode, cur)
  if ok and type(c) == 'table' and c.v and c.v > tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

interface CachedUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  bio: string | null;
  locale: string;
  avatarAssetId: string | null;
  bannerAssetId: string | null;
  status: User['status'];
  createdAt: string;
  updatedAt: string;
  version: number;
}

type Entry =
  | { t: 'u'; v: number; u: CachedUser }
  | { t: 'n'; v: number }
  | { t: 'x'; v: number };
type Lookup =
  { kind: 'hit'; user: User } | { kind: 'negative' } | { kind: 'miss' };

export interface CacheStats {
  enabled: boolean;
  bypassed: boolean;
  hits: number;
  negativeHits: number;
  misses: number;
  fills: number;
  skippedFills: number;
  coalesced: number;
  invalidations: number;
  invalidationFailures: number;
  errors: number;
}

const toCached = (u: User): CachedUser => ({
  id: u.id,
  username: u.username,
  email: u.email,
  displayName: u.displayName,
  bio: u.bio,
  locale: u.locale,
  avatarAssetId: u.avatarAssetId,
  bannerAssetId: u.bannerAssetId,
  status: u.status,
  createdAt: u.createdAt.toISOString(),
  updatedAt: u.updatedAt.toISOString(),
  version: u.version,
});

const revive = (c: CachedUser): User =>
  Object.assign(new User(), {
    ...c,
    deletedAt: null,
    createdAt: new Date(c.createdAt),
    updatedAt: new Date(c.updatedAt),
  });

@Injectable()
export class ProfileCache {
  private downUntil = 0;
  private readonly flights = new Map<string, Promise<User | null>>();
  private readonly counters = {
    hits: 0,
    negativeHits: 0,
    misses: 0,
    fills: 0,
    skippedFills: 0,
    coalesced: 0,
    invalidations: 0,
    invalidationFailures: 0,
    errors: 0,
  };

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  stats(): CacheStats {
    return {
      enabled: this.config.cache.enabled,
      bypassed: this.bypassed(),
      ...this.counters,
    };
  }

  /** One profile. Returns null when the user does not exist (or was deleted). */
  async get(
    id: string,
    load: () => Promise<User | null>,
  ): Promise<User | null> {
    if (this.bypassed()) return load();
    const key = KEY_PREFIX + id;
    const raw = await this.guard(() => this.redis.get(key));
    if (raw === undefined) return load(); // Redis trouble: go straight to the database
    const found = this.lookup(raw);
    if (found.kind === 'hit') return this.count('hits', found.user);
    if (found.kind === 'negative') return this.count('negativeHits', null);
    this.counters.misses++;

    const running = this.flights.get(key);
    if (running) {
      this.counters.coalesced++;
      return running;
    }
    const flight = (async () => {
      const loaded = await load();
      await this.fill(key, loaded);
      return loaded;
    })().finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return flight;
  }

  /** Several profiles at once: one MGET, one database query for everything missing. Unknown ids are absent. */
  async getMany(
    ids: string[],
    loadMissing: (ids: string[]) => Promise<User[]>,
  ): Promise<Map<string, User>> {
    const result = new Map<string, User>();
    if (ids.length === 0) return result;
    const keys = ids.map((id) => KEY_PREFIX + id);

    const raws = this.bypassed()
      ? undefined
      : await this.guard(() => this.redis.mget(keys));
    if (raws === undefined) {
      for (const user of await loadMissing(ids)) result.set(user.id, user);
      return result;
    }

    const missing: string[] = [];
    ids.forEach((id, i) => {
      const found = this.lookup(raws[i] ?? null);
      if (found.kind === 'hit') {
        this.counters.hits++;
        result.set(id, found.user);
      } else if (found.kind === 'negative') this.counters.negativeHits++;
      else {
        this.counters.misses++;
        missing.push(id);
      }
    });
    if (missing.length === 0) return result;

    // Join loads already running for some of these ids; load the rest in ONE query.
    const waits: Promise<User | null>[] = [];
    const mine: string[] = [];
    for (const id of missing) {
      const running = this.flights.get(KEY_PREFIX + id);
      if (running) {
        this.counters.coalesced++;
        waits.push(running);
      } else mine.push(id);
    }
    if (mine.length > 0) {
      const batch = (async () => {
        const byId = new Map((await loadMissing(mine)).map((u) => [u.id, u]));
        await Promise.all(
          mine.map((id) => this.fill(KEY_PREFIX + id, byId.get(id) ?? null)),
        );
        return byId;
      })();
      for (const id of mine) {
        const key = KEY_PREFIX + id;
        const flight = batch
          .then((byId) => byId.get(id) ?? null)
          .finally(() => this.flights.delete(key));
        flight.catch(() => undefined); // the awaiting caller below reports a failure; this only prevents an unhandled-rejection crash
        this.flights.set(key, flight);
      }
      for (const [id, user] of await batch) result.set(id, user);
    }
    for (const user of await Promise.all(waits))
      if (user) result.set(user.id, user);
    return result;
  }

  /** Call AFTER the change committed. `version` is the row's new version. Never throws. */
  async invalidate(id: string, version: number): Promise<void> {
    await this.replace(id, { t: 'x', v: version }, TOMBSTONE_TTL_MS);
  }

  /** Call AFTER the user was deleted: remembers "not found" and refuses any older profile. */
  async markDeleted(id: string): Promise<void> {
    await this.replace(
      id,
      { t: 'n', v: MAX_VERSION },
      this.config.cache.negativeTtlSeconds * 1000,
    );
  }

  // ---- internals ------------------------------------------------------------------------------

  private async replace(
    id: string,
    entry: Entry,
    ttlMs: number,
  ): Promise<void> {
    if (!this.config.cache.enabled) return;
    this.counters.invalidations++;
    for (const delay of INVALIDATION_RETRY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        await this.redis.eval(
          REPLACE,
          1,
          KEY_PREFIX + id,
          String(entry.v),
          JSON.stringify(entry),
          String(ttlMs),
        );
        return;
      } catch (err) {
        this.noteError(err);
      }
    }
    // The change is committed but Redis may still serve the old profile until its TTL ends. Make noise.
    this.counters.invalidationFailures++;
    this.logger.error(
      { userId: id },
      'cache invalidation failed: a stale profile may be served until its TTL expires',
    );
  }

  private async fill(key: string, user: User | null): Promise<void> {
    const entry: Entry = user
      ? { t: 'u', v: user.version, u: toCached(user) }
      : { t: 'n', v: 0 };
    const ttl = this.jitter(
      (user
        ? this.config.cache.profileTtlSeconds
        : this.config.cache.negativeTtlSeconds) * 1000,
    );
    const stored = await this.guard(() =>
      this.redis.eval(
        FILL,
        1,
        key,
        String(entry.v),
        JSON.stringify(entry),
        String(ttl),
      ),
    );
    if (stored === 1) this.counters.fills++;
    else if (stored === 0) this.counters.skippedFills++;
  }

  private lookup(raw: string | null): Lookup {
    if (raw === null) return { kind: 'miss' };
    try {
      const entry = JSON.parse(raw) as Entry;
      if (entry.t === 'u') return { kind: 'hit', user: revive(entry.u) };
      if (entry.t === 'n') return { kind: 'negative' };
    } catch {
      // unreadable entry: treat as a miss, the fill below overwrites it
    }
    return { kind: 'miss' }; // tombstone or garbage: reload from the database
  }

  /** +/-20% so entries filled together do not all expire together. */
  private jitter(ms: number): number {
    return Math.round(ms * (0.8 + Math.random() * 0.4));
  }

  private bypassed(): boolean {
    return !this.config.cache.enabled || Date.now() < this.downUntil;
  }

  private count<K extends 'hits' | 'negativeHits', T>(counter: K, value: T): T {
    this.counters[counter]++;
    return value;
  }

  /** Runs a Redis call; on failure bypasses the cache for a while and returns undefined. */
  private async guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.noteError(err);
      return undefined;
    }
  }

  private noteError(err: unknown): void {
    this.counters.errors++;
    if (Date.now() >= this.downUntil) {
      this.logger.warn(
        { err: (err as Error).message, bypassMs: this.config.cache.cooldownMs },
        'redis cache error, bypassing the cache',
      );
    }
    this.downUntil = Date.now() + this.config.cache.cooldownMs;
  }
}
