import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Outbox relay support (README 4.3). Keep identical to the tail of contracts/db-schema/account.sql.
 *  - NOTIFY wakes the relay as soon as a transaction that inserted outbox rows COMMITS (polling stays as a safety net)
 *  - the partial index keeps the "earliest unpublished row of this aggregate" lookup cheap
 */
export const OUTBOX_NOTIFY_SQL = `
CREATE INDEX ix_outbox_unpublished_aggregate ON outbox_event (aggregate_id, id) WHERE published_at IS NULL;

CREATE FUNCTION notify_outbox_insert() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('outbox_new', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_outbox_notify
  AFTER INSERT ON outbox_event
  FOR EACH STATEMENT EXECUTE FUNCTION notify_outbox_insert();
`;

export class OutboxNotify1761350400000 implements MigrationInterface {
  name = 'OutboxNotify1761350400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(OUTBOX_NOTIFY_SQL);
  }

  async down(): Promise<void> {
    throw new Error(
      'Migrations are forward-only. Add a new migration instead.',
    );
  }
}
