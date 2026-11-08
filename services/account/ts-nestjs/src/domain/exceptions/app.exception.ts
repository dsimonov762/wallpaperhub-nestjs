/**
 * The exception model of README section 5.3.
 *
 * Domain code throws these; it never builds HTTP responses itself. One global HTTP
 * filter (api/http/filters), later one gRPC interceptor and one GraphQL error
 * formatter, translate them. `grpc` / `graphql` are already filled in so those
 * adapters only have to read the table.
 */

export type MessageArgs = Record<string, string | number>;

export interface FieldError {
  field: string;
  /** Machine-readable code, e.g. NotBlank. Also the i18n key suffix: validation.<code>. */
  code: string;
}

export abstract class AppException extends Error {
  /** `code` doubles as the problem slug and the i18n key stem: problem.<code>.title/detail */
  protected constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly grpc: string,
    public readonly graphql: string,
    public readonly args: MessageArgs = {},
    /** Extra HTTP response headers (Retry-After, WWW-Authenticate, ...). */
    public readonly headers: Record<string, string> = {},
  ) {
    super(code);
    this.name = new.target.name;
  }
}

export class ValidationException extends AppException {
  constructor(public readonly errors: FieldError[]) {
    super('validation-failed', 400, 'INVALID_ARGUMENT', 'BAD_USER_INPUT');
  }
}

export class UnauthorizedException extends AppException {
  /** `reason` is for logs only: clients get no hint about why a token was rejected. */
  constructor(public readonly reason = 'missing_token') {
    super(
      'unauthorized',
      401,
      'UNAUTHENTICATED',
      'UNAUTHENTICATED',
      {},
      {
        'www-authenticate':
          reason === 'missing_token'
            ? 'Bearer'
            : 'Bearer error="invalid_token"',
      },
    );
  }
}

export class ForbiddenException extends AppException {
  constructor() {
    super('forbidden', 403, 'PERMISSION_DENIED', 'FORBIDDEN');
  }
}

export class NotFoundException extends AppException {
  constructor(resource?: string, id?: string) {
    super(
      'not-found',
      404,
      'NOT_FOUND',
      'NOT_FOUND',
      resource && id ? { resource, id } : {},
    );
  }
}

export class ConflictException extends AppException {
  /** Optional field-level detail, e.g. [{ field: 'username', code: 'Taken' }]. */
  constructor(
    args: MessageArgs = {},
    public readonly errors: FieldError[] = [],
  ) {
    super('conflict', 409, 'ALREADY_EXISTS', 'CONFLICT', args);
  }
}

export class PayloadTooLargeException extends AppException {
  constructor() {
    super('payload-too-large', 413, 'RESOURCE_EXHAUSTED', 'PAYLOAD_TOO_LARGE');
  }
}

export class UnsupportedMediaException extends AppException {
  constructor() {
    super('unsupported-media', 415, 'INVALID_ARGUMENT', 'UNSUPPORTED_MEDIA');
  }
}

export class RateLimitedException extends AppException {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      'rate-limited',
      429,
      'RESOURCE_EXHAUSTED',
      'RATE_LIMITED',
      { retryAfter: retryAfterSeconds },
      { 'retry-after': String(retryAfterSeconds) },
    );
  }
}

export class UpstreamUnavailableException extends AppException {
  constructor() {
    super('upstream-unavailable', 503, 'UNAVAILABLE', 'UPSTREAM_UNAVAILABLE');
  }
}
