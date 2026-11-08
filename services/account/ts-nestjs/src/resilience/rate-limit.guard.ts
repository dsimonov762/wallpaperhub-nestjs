import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import { RateLimitedException } from '../domain/exceptions/app.exception.js';
import { RateLimiter } from './rate-limiter.js';

const RATE_LIMIT_KEY = 'rate-limit:scope';

/** `@RateLimit('registration')`: apply the policy named `registration` from config.rateLimit. */
export const RateLimit = (scope: keyof AppConfig['rateLimit']) =>
  SetMetadata(RATE_LIMIT_KEY, scope);

/**
 * Runs AFTER AuthGuard (see AppModule), so authenticated callers are limited per user id and
 * anonymous callers per IP address. Routes without @RateLimit are untouched (the gateway limits the edge).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<
      keyof AppConfig['rateLimit'] | undefined
    >(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!scope) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const caller = request.principal
      ? `user:${request.principal.userId}`
      : `ip:${request.ip}`;
    const result = await this.limiter.consume(
      scope,
      caller,
      this.config.rateLimit[scope],
    );
    if (!result.allowed)
      throw new RateLimitedException(result.retryAfterSeconds);
    return true;
  }
}
