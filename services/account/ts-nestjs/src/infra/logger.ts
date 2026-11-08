import type { LoggerService } from '@nestjs/common';
import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config/config.js';
import { LOG_REDACT_PATHS } from '../util/pii.js';
import { currentContext } from '../api/http/request-context.js';

/** Structured JSON logs on stdout (pretty-printed only in the local profile). */
export function createLogger(
  config: AppConfig['log'],
  service = 'account-service',
): Logger {
  return pino({
    level: config.level,
    base: { service },
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
    // Adds trace_id / request_id / user_id to every line logged during a request.
    mixin() {
      const ctx = currentContext();
      return ctx
        ? {
            trace_id: ctx.traceId,
            request_id: ctx.requestId,
            user_id: ctx.userId,
          }
        : {};
    },
    ...(config.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

/** Lets Nest's own internal logging flow through pino too (so everything is JSON). */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string) {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }
}

export const LOGGER = Symbol('LOGGER');
