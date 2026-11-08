import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { BEARER_SCHEME } from '../api/http/openapi/decorators.js';

/** Version of the HTTP API (not of the service build). Keep in step with contracts/openapi/account.yaml. */
export const API_VERSION = '1.0.0';

/**
 * Builds the OpenAPI document from the controllers and DTO decorators of a Nest application.
 * Used by the running service (Swagger UI), by `pnpm openapi:generate`, and by the tests that compare it
 * with the contract.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Wallpaper Hub - account-service')
    .setDescription(
      'Accounts, profiles and registration. Generated from the code; the contract lives in contracts/openapi/account.yaml.',
    )
    .setVersion(API_VERSION)
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      BEARER_SCHEME,
    )
    .build();
  return SwaggerModule.createDocument(app, config);
}
