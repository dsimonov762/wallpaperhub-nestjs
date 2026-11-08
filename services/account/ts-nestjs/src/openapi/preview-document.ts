import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from './build-document.js';

export const GLOBAL_PREFIX = 'api/v1';

/**
 * Generates the OpenAPI document WITHOUT starting the service: Nest's `preview` mode builds the module graph
 * and the routes but instantiates nothing, so no database, Redis, Kafka or Keycloak is needed (CI-friendly).
 */
export async function generateOpenApiFromCode(): Promise<OpenAPIObject> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      preview: true,
      logger: false,
    },
  );
  try {
    app.setGlobalPrefix(GLOBAL_PREFIX);
    return buildOpenApiDocument(app);
  } finally {
    await app.close();
  }
}
