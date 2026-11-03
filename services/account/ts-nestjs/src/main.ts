import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { setupHttp } from './api/http/setup-http.js';
import { setupOpenApi } from './openapi/setup-openapi.js';
import { attachGrpc } from './api/grpc/setup-grpc.js';
import { EXPIRY_WARNING_DAYS, TlsConfigError } from './api/grpc/tls.js';
import { ManagementServer } from './api/http/management.server.js';
import { HealthService } from './api/http/health.service.js';
import { AppModule } from './app.module.js';
import { ConfigError, loadConfig } from './config/config.js';
import { loadDotenv } from './config/load-dotenv.js';
import { createLogger, LOGGER, PinoNestLogger } from './infra/logger.js';
import type { Logger } from 'pino';

/**
 * Bootstrap order (README section 12):
 *   config -> logging -> DB (+ optional migrations) -> DI wiring -> HTTP + management server
 *   -> (later: gRPC, Kafka producer, outbox relay, schedulers) -> graceful shutdown
 */
async function bootstrap(): Promise<void> {
  loadDotenv();
  // 1. Config: fail fast with a readable message.
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  // 2. Logging.
  const log = createLogger(config.log);

  // 3 + 4. DB connection (and migrations, if enabled) happens while Nest builds the DI container.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: config.http.bodyLimitBytes,
      // Behind the gateway the real client IP is in X-Forwarded-For; only trust it when told to.
      trustProxy: config.http.trustProxy,
    }),
    { logger: new PinoNestLogger(log) },
  );
  const appLogger = app.get<Logger>(LOGGER);

  // 5. HTTP: validation, error handling, request context, access log.
  setupHttp(app, appLogger);
  if (config.openapi.enabled) setupOpenApi(app);

  // 6. Graceful shutdown on SIGTERM/SIGINT (Docker stop, Ctrl+C): drains, closes DB pool, stops servers.
  app.enableShutdownHooks();

  if (config.grpc.enabled) {
    try {
      const tls = attachGrpc(app, config);
      const days = tls?.certificate?.daysLeft;
      appLogger.info(
        { mode: config.grpc.tls.mode, certificateDaysLeft: days },
        'gRPC transport security',
      );
      if (days !== undefined && days < EXPIRY_WARNING_DAYS) {
        appLogger.warn(
          { daysLeft: days },
          'the gRPC server certificate expires soon: renew it',
        );
      }
    } catch (e) {
      if (!(e instanceof TlsConfigError)) throw e;
      console.error(`Invalid gRPC TLS configuration:\n  - ${e.message}`);
      process.exit(1);
    }
  }

  await app.listen(config.http.port, config.http.host);
  await app.get(ManagementServer).start();
  // 7. gRPC: same container, second port (api/grpc/setup-grpc.ts).
  if (config.grpc.enabled) await app.startAllMicroservices();
  app.get(HealthService).markStarted();
  appLogger.info(
    {
      http: config.http.port,
      grpc: config.grpc.enabled ? config.http.grpcPort : null,
      mgmt: config.http.mgmtPort,
      profile: config.profile,
    },
    'account-service started',
  );
}

await bootstrap();
