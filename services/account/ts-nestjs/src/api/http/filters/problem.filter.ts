import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import {
  AppException,
  ConflictException,
  type FieldError,
  ValidationException,
} from '../../../domain/exceptions/app.exception.js';
import { I18nService } from '../../../i18n/i18n.service.js';
import { LOGGER } from '../../../infra/logger.js';
import { newTraceId, traceIdFromTraceparent } from '../../../util/ids.js';
import type { Metadata } from '@grpc/grpc-js';
import { throwError } from 'rxjs';
import { toGrpcError } from '../../grpc/grpc-errors.js';
import { currentContext } from '../request-context.js';

const PROBLEM_BASE = 'https://wallpaperhub.dev/problems/';

/** HTTP status -> problem slug, for errors thrown by Nest/Fastify rather than by us. */
const SLUG_BY_STATUS: Record<number, string> = {
  400: 'validation-failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  413: 'payload-too-large',
  415: 'unsupported-media',
  429: 'rate-limited',
  503: 'upstream-unavailable',
};

const humanize = (field: string): string => {
  const words = field
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[._]/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * THE one HTTP exception handler (README 5.3). Everything that goes wrong in a request ends here
 * and leaves as RFC 9457 `application/problem+json`, localized from Accept-Language.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly i18n: I18nService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): unknown {
    // The same filter serves gRPC calls (hybrid application): translate instead of writing an HTTP response.
    if (host.getType() === 'rpc') {
      const metadata = host.switchToRpc().getContext<Metadata>();
      const traceId =
        currentContext()?.traceId ??
        traceIdFromTraceparent(metadata.get('traceparent')[0]?.toString()) ??
        newTraceId();
      return throwError(() =>
        toGrpcError(exception, traceId, this.i18n, this.logger),
      );
    }

    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const ctx = request.ctx ?? currentContext();
    const locale = ctx?.locale ?? 'en';

    let slug: string;
    let status: number;
    let args: Record<string, string | number> = {};
    let fieldErrors: FieldError[] | undefined;
    let headers: Record<string, string> = {};

    if (exception instanceof AppException) {
      ({ code: slug, status, args, headers } = exception);
      if (exception instanceof ValidationException)
        fieldErrors = exception.errors;
      if (exception instanceof ConflictException && exception.errors.length)
        fieldErrors = exception.errors;
    } else {
      const statusCode = this.statusOf(exception);
      status = statusCode ?? 500;
      slug =
        status >= 500 && status !== 503
          ? 'internal-error'
          : (SLUG_BY_STATUS[status] ?? 'validation-failed');
      if (status >= 500) {
        // Unexpected: log everything, tell the client nothing.
        this.logger.error({ err: exception }, 'unhandled exception');
      }
    }

    const body = {
      type: `${PROBLEM_BASE}${slug}`,
      title: this.i18n.t(`problem.${slug}.title`, locale, args),
      status,
      detail: this.i18n.t(`problem.${slug}.detail`, locale, args),
      instance: request.url.split('?')[0],
      traceId: ctx?.traceId ?? newTraceId(),
      ...(fieldErrors && {
        errors: fieldErrors.map((e) => ({
          field: e.field,
          code: e.code,
          message: this.i18n.t(`validation.${e.code}`, locale, {
            field: humanize(e.field),
          }),
        })),
      }),
    };

    const adapter = this.adapterHost.httpAdapter;
    adapter.setHeader(
      reply,
      'content-type',
      'application/problem+json; charset=utf-8',
    );
    for (const [name, value] of Object.entries(headers))
      adapter.setHeader(reply, name, value);
    adapter.reply(reply, body, status);
  }

  private statusOf(exception: unknown): number | undefined {
    if (exception instanceof HttpException) return exception.getStatus();
    // Fastify's own errors (bad JSON, body too large, ...) carry a statusCode.
    const code = (exception as { statusCode?: unknown } | null)?.statusCode;
    return typeof code === 'number' && code >= 400 && code < 600
      ? code
      : undefined;
  }
}
