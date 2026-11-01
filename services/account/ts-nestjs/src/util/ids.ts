import { randomBytes, randomUUID } from 'node:crypto';

export const newUuid = (): string => randomUUID();

/** 32 lowercase hex chars: the W3C trace-id format. */
export const newTraceId = (): string => randomBytes(16).toString('hex');

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;

/** Extracts the trace id from a W3C `traceparent` header, or undefined if malformed. */
export function traceIdFromTraceparent(
  header: string | undefined,
): string | undefined {
  const match = header ? TRACEPARENT.exec(header.trim()) : null;
  const traceId = match?.[1];
  return traceId && traceId !== '0'.repeat(32) ? traceId : undefined;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
