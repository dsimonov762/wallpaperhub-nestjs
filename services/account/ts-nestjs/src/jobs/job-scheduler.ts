import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import { LOGGER } from '../infra/logger.js';
import { DistributedLock } from '../resilience/distributed-lock.js';
import { sleep } from '../util/sleep.js';

export interface ScheduledJob {
  name: string;
  run(signal: AbortSignal): Promise<void>;
}

export const SCHEDULED_JOBS = Symbol('SCHEDULED_JOBS');

const LOCK_TTL_MS = 10 * 60_000;

/**
 * Runs maintenance jobs periodically. With several instances running, a Redis lock makes sure
 * each job runs on only ONE of them at a time. Start times and intervals are jittered so instances
 * do not all fire in the same second.
 */
@Injectable()
export class JobScheduler
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly stop = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(
    @Inject(SCHEDULED_JOBS) private readonly jobs: ScheduledJob[],
    private readonly lock: DistributedLock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.jobs.enabled) {
      this.logger.info('background jobs are disabled (JOBS_ENABLED=false)');
      return;
    }
    this.loops = this.jobs.map((job) => this.loop(job));
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled(this.loops);
  }

  /** Runs one job now, under the cluster-wide lock. Returns whether THIS instance ran it. */
  async runNow(name: string): Promise<boolean> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`unknown job "${name}"`);
    try {
      const outcome = await this.lock.runExclusive(
        `job:${job.name}`,
        LOCK_TTL_MS,
        () => job.run(this.stop.signal),
      );
      return outcome.ran;
    } catch (err) {
      this.logger.error({ err, job: job.name }, 'background job failed');
      return false;
    }
  }

  private async loop(job: ScheduledJob): Promise<void> {
    const interval = this.config.jobs.intervalMinutes * 60_000;
    await sleep(Math.random() * Math.min(interval, 30_000), this.stop.signal);
    while (!this.stop.signal.aborted) {
      await this.runNow(job.name);
      await sleep(interval * (0.9 + Math.random() * 0.2), this.stop.signal);
    }
  }
}
