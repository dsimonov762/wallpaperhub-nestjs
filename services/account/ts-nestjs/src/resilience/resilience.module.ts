import { Module } from '@nestjs/common';
import { DistributedLock } from './distributed-lock.js';
import { IdempotencyService } from './idempotency.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimiter } from './rate-limiter.js';

@Module({
  providers: [RateLimiter, RateLimitGuard, IdempotencyService, DistributedLock],
  exports: [RateLimiter, RateLimitGuard, IdempotencyService, DistributedLock],
})
export class ResilienceModule {}
