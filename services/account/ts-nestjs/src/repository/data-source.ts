import { DataSource, type DataSourceOptions } from 'typeorm';
import type { AppConfig } from '../config/config.js';
import { OutboxNotify1761350400000 } from '../resources/migrations/1761350400000-outbox-notify.js';
import { InitAccountSchema1761264000000 } from '../resources/migrations/1761264000000-init-account-schema.js';
import { UserAuditSubscriber } from './audit.subscriber.js';
import { AuditLog } from './entities/audit-log.entity.js';
import { OutboxEvent } from './entities/outbox-event.entity.js';
import { User } from './entities/user.entity.js';
import { SnakeNamingStrategy } from './snake-naming.strategy.js';

export const ENTITIES = [User, OutboxEvent, AuditLog];
export const MIGRATIONS = [
  InitAccountSchema1761264000000,
  OutboxNotify1761350400000,
];

/** One place that describes how we talk to PostgreSQL. Used by the app AND by the migrate command. */
export function buildDataSourceOptions(db: AppConfig['db']): DataSourceOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    database: db.name,
    username: db.user,
    password: db.password,
    poolSize: db.poolMax,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    subscribers: [UserAuditSubscriber],
    namingStrategy: new SnakeNamingStrategy(),
    migrationsRun: db.migrateOnStartup,
    synchronize: false, // never let an ORM change a schema behind your back
  };
}

export const createDataSource = (db: AppConfig['db']): DataSource =>
  new DataSource(buildDataSourceOptions(db));
