import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keep identical to contracts/db-schema/account.sql (checked by a unit test).
 * Migrations are forward-only (README section 12): to change the schema, add a NEW migration file.
 */
export const INIT_ACCOUNT_SCHEMA_SQL = `
CREATE TABLE users (
  id               uuid PRIMARY KEY,
  username         varchar(64)  NOT NULL,
  email            varchar(320) NOT NULL,
  display_name     varchar(100) NOT NULL,
  bio              varchar(500),
  locale           varchar(5)   NOT NULL DEFAULT 'en',
  avatar_asset_id  varchar(64),
  banner_asset_id  varchar(64),
  status           varchar(16)  NOT NULL DEFAULT 'ACTIVE',
  deleted_at       timestamptz,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  version          integer      NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX ux_users_username ON users (lower(username)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_users_email ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE outbox_event (
  id              bigserial PRIMARY KEY,
  event_id        uuid         NOT NULL UNIQUE,
  aggregate_type  varchar(64)  NOT NULL,
  aggregate_id    varchar(64)  NOT NULL,
  event_type      varchar(64)  NOT NULL,
  topic           varchar(200) NOT NULL,
  payload         jsonb        NOT NULL,
  headers         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer      NOT NULL DEFAULT 0
);

CREATE INDEX ix_outbox_unpublished ON outbox_event (id) WHERE published_at IS NULL;

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     varchar(64),
  action       varchar(32) NOT NULL,
  entity_type  varchar(64) NOT NULL,
  entity_id    varchar(64) NOT NULL,
  before       jsonb,
  after        jsonb,
  trace_id     varchar(32),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_audit_entity ON audit_log (entity_type, entity_id, id);
`;

export class InitAccountSchema1761264000000 implements MigrationInterface {
  name = 'InitAccountSchema1761264000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(INIT_ACCOUNT_SCHEMA_SQL);
  }

  async down(): Promise<void> {
    throw new Error(
      'Migrations are forward-only. Add a new migration instead.',
    );
  }
}
