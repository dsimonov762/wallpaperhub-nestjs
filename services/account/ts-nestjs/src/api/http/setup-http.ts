import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { negotiateLocale } from '../../i18n/i18n.service.js';
import { newTraceId, newUuid, traceIdFromTraceparent } from '../../util/ids.js';
import { type RequestContext, runInContext } from './request-context.js';
import { createValidationPipe } from './validation.pipe.js';

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

const REQUEST_ID = /^[\w.-]{1,128}$/;

/**
 * Cross-cutting HTTP wiring. Order follows README section 12:
 * correlation-id -> request logging -> locale -> (rate limit, auth, idempotency: later) -> security headers.
 */
export function setupHttp(app: NestFastifyApplication, logger: Logger): void {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());

  const fastify = app.getHttpAdapter().getInstance();
  fastify.decorateRequest('ctx', undefined as unknown as RequestContext);

  // 1 + 3: correlation id, trace id and locale, available to every later layer.
  fastify.addHook('onRequest', (request, reply, done) => {
    const incoming = request.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && REQUEST_ID.test(incoming)
        ? incoming
        : newUuid();
    const traceId =
      traceIdFromTraceparent(
        request.headers.traceparent as string | undefined,
      ) ?? newTraceId();
    const locale = negotiateLocale(request.headers['accept-language']);
    request.ctx = { requestId, traceId, locale };
    reply.header('x-request-id', requestId);
    runInContext(request.ctx, done);
  });

  // 2: structured access log, one line per request.
  fastify.addHook('onResponse', (request, reply, done) => {
    logger.info(
      {
        trace_id: request.ctx.traceId,
        request_id: request.ctx.requestId,
        method: request.method,
        path: request.url.split('?')[0],
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });

  // Last: security headers (the gateway adds HSTS/CORS at the edge).
  fastify.addHook('onSend', (_request, reply, _payload, done) => {
    reply.header('x-content-type-options', 'nosniff');
    done();
  });
}
