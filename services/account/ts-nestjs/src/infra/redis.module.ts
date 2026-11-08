import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import { LOGGER } from './logger.js';

export const REDIS = Symbol('REDIS');

/**
 * Commands fail FAST when Redis is down (no offline queue, short timeouts): callers decide what to do.
 * Rate limiting and idempotency fail open (the request proceeds), readiness reports DOWN.
 */
export function createRedis(url: string, logger: Pick<Logger, 'warn'>): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    commandTimeout: 1000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 3000),
  });
  // Without an 'error' listener Node would crash the process on a connection error.
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  return redis;
}

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG, LOGGER],
      useFactory: (config: AppConfig, logger: Logger) =>
        createRedis(config.redis.url, logger),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
