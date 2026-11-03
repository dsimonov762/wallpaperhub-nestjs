import { Metadata, status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { Logger } from 'pino';
import {
  AppException,
  ConflictException,
  ValidationException,
} from '../../domain/exceptions/app.exception.js';
import type { I18nService } from '../../i18n/i18n.service.js';

export interface GrpcError {
  code: number;
  message: string;
  details: string;
  metadata: Metadata;
}

/**
 * The gRPC twin of the HTTP problem+json filter (README 5.3): the SAME AppException becomes a gRPC status.
 * The status code comes from the exception itself (`AppException.grpc`), the text is English (service-to-service
 * callers do not have an Accept-Language), field errors travel as JSON in the `x-field-errors` trailer.
 */
export function toGrpcError(
  exception: unknown,
  traceId: string,
  i18n: I18nService,
  logger: Logger,
): GrpcError {
  const metadata = new Metadata();
  metadata.set('x-trace-id', traceId);

  if (exception instanceof AppException) {
    const fields =
      exception instanceof ValidationException ||
      exception instanceof ConflictException
        ? exception.errors
        : [];
    if (fields.length > 0)
      metadata.set('x-field-errors', JSON.stringify(fields));
    const message = i18n.t(
      `problem.${exception.code}.detail`,
      'en',
      exception.args,
    );
    return {
      code: status[exception.grpc as keyof typeof status] ?? status.UNKNOWN,
      message,
      details: message,
      metadata,
    };
  }

  if (exception instanceof RpcException) {
    const error = exception.getError();
    const code =
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : status.INTERNAL;
    const message =
      typeof error === 'string'
        ? error
        : ((error as { message?: string }).message ?? 'error');
    return { code, message, details: message, metadata };
  }

  // Unexpected: log everything, tell the caller nothing.
  logger.error(
    { err: exception, trace_id: traceId },
    'unhandled exception in gRPC call',
  );
  const message = i18n.t('problem.internal-error.detail', 'en');
  return { code: status.INTERNAL, message, details: message, metadata };
}
