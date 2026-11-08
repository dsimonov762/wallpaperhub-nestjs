import { SwaggerModule } from '@nestjs/swagger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildOpenApiDocument } from './build-document.js';

/**
 * Interactive documentation of the running service:
 *   /api/docs        Swagger UI (click "Authorize", paste an access token, try the endpoints)
 *   /api/docs-json   the OpenAPI document as JSON
 *   /api/docs-yaml   the same as YAML
 * These routes need no token (documentation only), so they are off unless OPENAPI_ENABLED=true (local profile default).
 */
export function setupOpenApi(app: NestFastifyApplication): void {
  SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app), {
    useGlobalPrefix: false,
    jsonDocumentUrl: 'api/docs-json',
    yamlDocumentUrl: 'api/docs-yaml',
    customSiteTitle: 'Wallpaper Hub - account-service API',
  });
}
