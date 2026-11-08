import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProblemFilter } from './api/http/filters/problem.filter.js';
import { HealthService } from './api/http/health.service.js';
import { ManagementServer } from './api/http/management.server.js';
import { APP_CONFIG, ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/config.js';
import { I18nModule } from './i18n/i18n.module.js';
import { LoggingModule } from './infra/logging.module.js';
import { RedisModule } from './infra/redis.module.js';
import { OutboxModule } from './repository/outbox.module.js';
import { GrpcModule } from './grpc.module.js';
import { MessagingModule } from './messaging.module.js';
import { UsersModule } from './users.module.js';
import { SecurityModule } from './security/security.module.js';
import { buildDataSourceOptions } from './repository/data-source.js';

/**
 * Composition root: every service the application owns is wired here (dependency injection).
 * Feature modules (users, registration, auth, ...) will be added to `imports` as they are built.
 */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    RedisModule,
    OutboxModule,
    I18nModule,
    SecurityModule,
    UsersModule,
    MessagingModule,
    GrpcModule,
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildDataSourceOptions(config.db),
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    HealthService,
    ManagementServer,
  ],
  exports: [HealthService, ManagementServer],
})
export class AppModule {}
