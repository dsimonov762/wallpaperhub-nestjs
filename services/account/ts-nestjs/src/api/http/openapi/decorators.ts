import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { FieldErrorDto, ProblemDto } from './schemas.js';

export const BEARER_SCHEME = 'bearerAuth';

const DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid input (field-level errors in `errors`)',
  401: 'Missing, malformed or invalid access token',
  403: 'Authenticated but not allowed',
  404: 'Not found',
  409: 'Conflict with the current state',
  429: 'Rate limited',
  503: 'A dependency (Keycloak, database) is unavailable; retry with backoff',
};

const HEADERS_BY_STATUS: Record<
  number,
  Record<string, { schema: { type: string } }>
> = {
  401: { 'WWW-Authenticate': { schema: { type: 'string' } } },
  429: { 'Retry-After': { schema: { type: 'integer' } } },
};

/** RFC 9457 error responses (`application/problem+json`) for the given status codes. */
export const ApiProblems = (...statuses: number[]) =>
  applyDecorators(
    ApiExtraModels(ProblemDto, FieldErrorDto),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: DESCRIPTIONS[status] ?? 'Error',
        headers: HEADERS_BY_STATUS[status],
        content: {
          'application/problem+json': {
            schema: { $ref: getSchemaPath(ProblemDto) },
          },
        },
      }),
    ),
  );

/** Everything an authenticated endpoint can answer before its own logic runs: needs a bearer token (401), keys unavailable (503). */
export const ApiAuthenticated = () =>
  applyDecorators(ApiBearerAuth(BEARER_SCHEME), ApiProblems(401, 503));
