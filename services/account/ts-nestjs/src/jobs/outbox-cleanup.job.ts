import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import { LOGGER } from '../infra/logger.js';
import { OutboxRepository } from '../repository/outbox.repository.js';
import { Clock } from '../util/clock.js';
import type { ScheduledJob } from './job-scheduler.js';

/** Deletes published outbox rows after the retention period, in small batches so no long lock is held. */
@Injectable()
export class OutboxCleanupJob implements ScheduledJob {
  readonly name = 'outbox-cleanup';

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const cutoff = new Date(
      this.clock.now().getTime() -
        this.config.outbox.retentionHours * 3_600_000,
    );
    let total = 0;
    while (!signal.aborted) {
      const deleted = await this.outbox.deletePublishedBefore(
        this.dataSource.manager,
        cutoff,
      );
      total += deleted;
      if (deleted === 0) break;
    }
    if (total > 0)
      this.logger.info(
        { deleted: total },
        'outbox cleanup removed published events',
      );
  }
}
