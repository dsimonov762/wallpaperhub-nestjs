import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { RateLimitPolicy } from '../config/config.js';
import { LOGGER } from '../infra/logger.js';
import { REDIS } from '../infra/redis.module.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Token bucket in ONE atomic Lua script, so any number of service instances share the same
 * counters without races. Time comes from the Redis server, so instance clocks do not matter.
 *   bucket = { tokens, last-refill timestamp }   key: rl:{scope}:{caller}
 */
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + math.max(0, now - ts) / 1000 * refill)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / refill)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill * 1000) + 1000)
return { allowed, retry }
`;

@Injectable()
export class RateLimiter {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async consume(
    scope: string,
    caller: string,
    policy: RateLimitPolicy,
    cost = 1,
  ): Promise<RateLimitResult> {
    try {
      const [allowed, retry] = (await this.redis.eval(
        TOKEN_BUCKET,
        1,
        `rl:${scope}:${caller}`,
        policy.capacity,
        policy.refillPerSecond,
        cost,
      )) as [number, number];
      return { allowed: allowed === 1, retryAfterSeconds: Math.max(1, retry) };
    } catch (err) {
      // Fail open: a Redis outage must not take registration down. Readiness shows the problem.
      this.logger.warn(
        { err: (err as Error).message, scope },
        'rate limiter unavailable, allowing request',
      );
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }
}
