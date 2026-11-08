import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import {
  ConflictException,
  UpstreamUnavailableException,
  ValidationException,
} from '../domain/exceptions/app.exception.js';
import { LOGGER } from '../infra/logger.js';
import { REDIS } from '../infra/redis.module.js';
import { sha256Hex } from '../util/hashing.js';

export interface StoredResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface Entry {
  state: 'in_progress' | 'done';
  owner: string;
  fingerprint: string;
  response?: StoredResponse;
}

const KEY_FORMAT = /^[\w.:-]{1,128}$/;
const LOCK_SECONDS = 60;

/** Delete the key only if we still own it (a slow request must not remove a newer owner's lock). */
const RELEASE = `
local v = redis.call('GET', KEYS[1])
if v and cjson.decode(v).owner == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * `Idempotency-Key` support (README 5.2): the same key + same request returns the ORIGINAL response
 * instead of doing the work twice (double clicks, client retries after a timeout).
 *
 *   first call     -> lock the key, run, store the response for `ttlSeconds`
 *   repeat, done   -> replay the stored response
 *   repeat, busy   -> 409 (the first call is still running)
 *   same key, different payload -> 409
 *   handler failed -> key released, so the client may retry
 *
 * If Redis is down while a key was sent we answer 503: silently skipping the check could create duplicates.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  static validateKey(key: string): string {
    if (!KEY_FORMAT.test(key))
      throw new ValidationException([
        { field: 'Idempotency-Key', code: 'Pattern' },
      ]);
    return key;
  }

  async execute(
    scope: string,
    key: string,
    fingerprintSource: unknown,
    run: () => Promise<StoredResponse>,
  ): Promise<{ response: StoredResponse; replayed: boolean }> {
    const redisKey = `idem:${scope}:${sha256Hex(key)}`;
    const fingerprint = sha256Hex(JSON.stringify(fingerprintSource));
    const owner = randomUUID();
    const mine: Entry = { state: 'in_progress', owner, fingerprint };

    const acquired = await this.guard(() =>
      this.redis.set(redisKey, JSON.stringify(mine), 'EX', LOCK_SECONDS, 'NX'),
    );
    if (acquired !== 'OK') return this.replayOrReject(redisKey, fingerprint);

    let response: StoredResponse;
    try {
      response = await run();
    } catch (err) {
      await this.release(redisKey, owner);
      throw err;
    }
    const done: Entry = { state: 'done', owner, fingerprint, response };
    try {
      await this.redis.set(
        redisKey,
        JSON.stringify(done),
        'EX',
        this.config.idempotency.ttlSeconds,
      );
    } catch (err) {
      // The work succeeded; losing the replay record only weakens future retries. Do not fail the request.
      this.logger.warn(
        { err: (err as Error).message },
        'could not store idempotent response',
      );
    }
    return { response, replayed: false };
  }

  private async replayOrReject(redisKey: string, fingerprint: string) {
    const raw = await this.guard(() => this.redis.get(redisKey));
    if (!raw)
      throw new ConflictException({}, [
        { field: 'Idempotency-Key', code: 'InProgress' },
      ]); // expired between calls: let the client retry
    const entry = JSON.parse(raw) as Entry;
    if (entry.fingerprint !== fingerprint)
      throw new ConflictException({}, [
        { field: 'Idempotency-Key', code: 'Taken' },
      ]);
    if (entry.state === 'in_progress' || !entry.response) {
      throw new ConflictException({}, [
        { field: 'Idempotency-Key', code: 'InProgress' },
      ]);
    }
    return { response: entry.response, replayed: true };
  }

  private async release(redisKey: string, owner: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE, 1, redisKey, owner);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        'could not release idempotency key (it expires by itself)',
      );
    }
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        'idempotency store unavailable',
      );
      throw new UpstreamUnavailableException();
    }
  }
}
