import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import { Observable } from 'rxjs';
import type { Logger } from 'pino';
import { AppException } from '../../domain/exceptions/app.exception.js';
import { LOGGER } from '../../infra/logger.js';
import { callPrincipal } from '../../security/principal-store.js';
import { newTraceId, newUuid, traceIdFromTraceparent } from '../../util/ids.js';
import { type RequestContext, runInContext } from '../http/request-context.js';

const REQUEST_ID = /^[\w.-]{1,128}$/;
const first = (md: Metadata, key: string): string | undefined =>
  md.get(key)[0]?.toString();

/**
 * What setup-http.ts hooks do for HTTP, for gRPC: a request context (request id, trace id, caller) that
 * logging and the audit trail can read anywhere, plus one structured log line per call.
 */
@Injectable()
export class GrpcCallInterceptor implements NestInterceptor {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') return next.handle();

    const metadata = context.switchToRpc().getContext<Metadata>();
    const incoming = first(metadata, 'x-request-id');
    const ctx: RequestContext = {
      requestId: incoming && REQUEST_ID.test(incoming) ? incoming : newUuid(),
      traceId:
        traceIdFromTraceparent(first(metadata, 'traceparent')) ?? newTraceId(),
      locale: 'en',
      userId: callPrincipal(metadata)?.userId,
    };
    const rpc = `${context.getClass().name}.${context.getHandler().name}`;
    const started = performance.now();
    let outcome = 'OK';

    return new Observable((subscriber) => {
      const subscription = runInContext(ctx, () =>
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err: unknown) => {
            outcome = err instanceof AppException ? err.grpc : 'ERROR';
            subscriber.error(err);
          },
          complete: () => subscriber.complete(),
        }),
      );
      return () => {
        subscription.unsubscribe();
        this.logger.info(
          {
            trace_id: ctx.traceId,
            request_id: ctx.requestId,
            user_id: ctx.userId,
            rpc,
            outcome,
            durationMs: Math.round(performance.now() - started),
          },
          'rpc completed',
        );
      };
    });
  }
}
