import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { LOGGER } from '../infra/logger.js';
import { REDIS } from '../infra/redis.module.js';

/** Delete the lock only if we still own it. */
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/**
 * "Only one instance runs this" via Redis `SET key token NX PX ttl`.
 * The TTL is a safety net: if the holder crashes, the lock frees itself. Pick a TTL longer than the job can take.
 * If Redis is unreachable the job is SKIPPED (periodic maintenance can wait; running it twice is worse).
 */
@Injectable()
export class DistributedLock {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async runExclusive<T>(
    name: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ ran: false } | { ran: true; result: T }> {
    const key = `lock:${name}`;
    const token = randomUUID();
    try {
      if ((await this.redis.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK')
        return { ran: false };
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, lock: name },
        'lock store unavailable, skipping run',
      );
      return { ran: false };
    }
    try {
      return { ran: true, result: await fn() };
    } finally {
      await this.redis.eval(RELEASE, 1, key, token).catch(() => undefined);
    }
  }
}
