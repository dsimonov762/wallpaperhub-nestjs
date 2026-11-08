import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import { LOGGER } from '../infra/logger.js';
import { Clock } from '../util/clock.js';
import type { ScheduledJob } from './job-scheduler.js';

const BATCH = 100;

/**
 * Erases users that were soft-deleted more than USER_PURGE_AFTER_DAYS ago (privacy: do not keep personal data forever).
 * Per batch, in one transaction:
 *  - the `users` rows are removed
 *  - audit rows of those users lose their before/after snapshots (they contain email etc.); the fact that the
 *    user existed and was deleted stays, plus one PURGE row
 *
 * Not covered yet: copies of the email inside outbox rows (the cleanup job removes those after their retention).
 */
@Injectable()
export class UserPurgeJob implements ScheduledJob {
  readonly name = 'user-purge';

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const cutoff = new Date(
      this.clock.now().getTime() -
        this.config.jobs.userPurgeAfterDays * 86_400_000,
    );
    let total = 0;
    while (!signal.aborted) {
      const purged = await this.dataSource.transaction(async (m) => {
        const rows = (await m.query(
          `SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at < $1 ORDER BY deleted_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
          [cutoff],
        )) as { id: string }[];
        if (rows.length === 0) return 0;
        const ids = rows.map((r) => r.id);
        await m.query(
          `UPDATE audit_log SET before = NULL, after = NULL WHERE entity_type = 'User' AND entity_id = ANY($1::text[])`,
          [ids],
        );
        await m.query(
          `INSERT INTO audit_log (actor_id, action, entity_type, entity_id) SELECT NULL, 'PURGE', 'User', unnest($1::text[])`,
          [ids],
        );
        await m.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
        return ids.length;
      });
      total += purged;
      if (purged < BATCH) break;
    }
    if (total > 0)
      this.logger.info(
        { purged: total },
        'user purge erased soft-deleted users',
      );
  }
}
