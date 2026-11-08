import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { setupHttp } from '../src/api/http/setup-http.js';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import { IdentityProvider } from '../src/domain/identity-provider.js';
import { LOGGER } from '../src/infra/logger.js';
import { setupOpenApi } from '../src/openapi/setup-openapi.js';
import { createDataSource } from '../src/repository/data-source.js';
import { testConfig } from './support/config.js';
import { FakeIdentityProvider } from './support/fake-identity.js';
import { startFakeIssuer, type FakeIssuer } from './support/fake-issuer.js';
import { startTestDatabase, type TestDatabase } from './support/postgres.js';
import { startTestRedis, type TestRedis } from './support/redis.js';

let db: TestDatabase;
let redisServer: TestRedis;
let issuer: FakeIssuer;
let docsOn: NestFastifyApplication;
let docsOff: NestFastifyApplication;

async function buildApp(enabled: boolean): Promise<NestFastifyApplication> {
  const config = testConfig({
    db: db.db,
    redis: { url: redisServer.url },
    auth: { jwksUrl: issuer.jwksUrl },
    openapi: { enabled },
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(IdentityProvider)
    .useValue(new FakeIdentityProvider())
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  setupHttp(app, app.get<Logger>(LOGGER));
  if (config.openapi.enabled) setupOpenApi(app); // exactly what main.ts does
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

beforeAll(async () => {
  [db, redisServer, issuer] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    startFakeIssuer(),
  ]);
  const admin = createDataSource(db.db);
  await admin.initialize();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.runMigrations();
  await admin.destroy();
  docsOn = await buildApp(true);
  docsOff = await buildApp(false);
});

afterAll(async () => {
  await docsOn?.close();
  await docsOff?.close();
  await issuer?.close();
  await db?.stop();
  await redisServer?.stop();
});

describe('interactive API documentation', () => {
  it('serves the OpenAPI document as JSON and YAML without a token', async () => {
    const json = await docsOn.inject({ method: 'GET', url: '/api/docs-json' });
    expect(json.statusCode).toBe(200);
    expect(json.json().paths['/api/v1/registrations']).toBeDefined();
    expect(json.json().components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });

    const yaml = await docsOn.inject({ method: 'GET', url: '/api/docs-yaml' });
    expect(yaml.statusCode).toBe(200);
    expect(parse(yaml.body).info.title).toBe('Wallpaper Hub - account-service');
  });

  it('serves Swagger UI', async () => {
    const page = await docsOn.inject({ method: 'GET', url: '/api/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('swagger-ui');
  });

  it('is not served when OPENAPI_ENABLED is false (the default outside the local profile)', async () => {
    expect(
      (await docsOff.inject({ method: 'GET', url: '/api/docs-json' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await docsOff.inject({ method: 'GET', url: '/api/docs' })).statusCode,
    ).toBe(404);
  });

  it('does not weaken the API itself: protected endpoints still need a token', async () => {
    expect(
      (await docsOn.inject({ method: 'GET', url: '/api/v1/users/me' }))
        .statusCode,
    ).toBe(401);
    const res = await docsOn.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: { authorization: `Bearer ${await issuer.token('someone')}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
