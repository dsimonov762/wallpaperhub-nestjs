import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Client } from 'pg';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import {
  EventPublisher,
  type OutboundEvent,
} from '../domain/event-publisher.js';
import { LOGGER } from '../infra/logger.js';
import type { OutboxEvent } from '../repository/entities/outbox-event.entity.js';
import { OutboxRepository } from '../repository/outbox.repository.js';
import { sleep } from '../util/sleep.js';

export interface TickResult {
  claimed: number;
  published: number;
  rejected: number;
  /** Set when the whole batch failed (broker or registry unavailable). Nothing was published. */
  error?: Error;
}

export interface RelayStatus {
  enabled: boolean;
  running: boolean;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  publishedTotal: number;
  rejectedTotal: number;
  failedBatchesTotal: number;
}

const LISTEN_CHANNEL = 'outbox_new';
const ERROR_LOG_AFTER_ATTEMPTS = 10;

export const toOutbound = (row: OutboxEvent): OutboundEvent => ({
  eventId: row.eventId,
  topic: row.topic,
  key: row.aggregateId,
  eventType: row.eventType,
  payload: row.payload,
  headers: row.headers,
});

/**
 * The outbox relay (README 4.3): moves events from the `outbox_event` table to Kafka.
 *
 *   claim rows (locked) -> publish -> mark published -> commit
 *
 * Guarantees:
 *  - AT-LEAST-ONCE: a crash between "Kafka acknowledged" and "COMMIT" re-sends the batch. Consumers de-duplicate by `eventId`.
 *  - ORDER PER AGGREGATE: see OutboxRepository.claimUnpublished.
 *  - NO LOSS DURING OUTAGES: while Kafka (or the registry) is down, rows simply stay in the table; the relay backs off
 *    exponentially and drains the backlog when the broker returns. The API keeps working the whole time.
 *
 * Latency: a Postgres LISTEN/NOTIFY wake-up (sent when a transaction commits outbox rows) plus a polling safety net.
 */
@Injectable()
export class OutboxRelay
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly stop = new AbortController();
  private running = false;
  private loops: Promise<void>[] = [];
  private listener?: Client;
  private wakeUp?: () => void;
  private wakePending = false;
  private state = {
    consecutiveFailures: 0,
    lastSuccessAt: null as Date | null,
    lastFailureAt: null as Date | null,
    lastError: null as string | null,
    publishedTotal: 0,
    rejectedTotal: 0,
    failedBatchesTotal: 0,
  };

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outbox.relayEnabled) {
      this.logger.info('outbox relay is disabled (OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = [this.publishLoop(), this.listenLoop()];
    this.logger.info(
      {
        pollMs: this.config.outbox.pollIntervalMs,
        batch: this.config.outbox.batchSize,
      },
      'outbox relay started',
    );
  }

  /** Graceful stop: lets the batch in flight finish (its rows are committed or rolled back), then returns. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stop.abort();
    await this.listener?.end().catch(() => undefined);
    await Promise.allSettled(this.loops);
    this.logger.info('outbox relay stopped');
  }

  status(): RelayStatus {
    const s = this.state;
    return {
      enabled: this.config.outbox.relayEnabled,
      running: this.running,
      consecutiveFailures: s.consecutiveFailures,
      lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: s.lastFailureAt?.toISOString() ?? null,
      lastError: s.lastError,
      publishedTotal: s.publishedTotal,
      rejectedTotal: s.rejectedTotal,
      failedBatchesTotal: s.failedBatchesTotal,
    };
  }

  /** One claim -> publish -> mark cycle. Public so tests (and operators) can drive it step by step. */
  async tick(): Promise<TickResult> {
    const result = await this.dataSource.transaction(
      async (manager): Promise<TickResult> => {
        const rows = await this.outbox.claimUnpublished(
          manager,
          this.config.outbox.batchSize,
        );
        if (rows.length === 0) return { claimed: 0, published: 0, rejected: 0 };

        let outcome;
        try {
          outcome = await this.publisher.publish(rows.map(toOutbound));
        } catch (error) {
          // Count the attempt and release the rows (commit) so the next tick can retry them.
          await this.outbox.recordFailure(
            manager,
            rows.map((r) => r.id),
          );
          return {
            claimed: rows.length,
            published: 0,
            rejected: 0,
            error: error as Error,
          };
        }

        const rejectedIds = new Set(outcome.rejected.map((r) => r.eventId));
        const ok = rows.filter((r) => !rejectedIds.has(r.eventId));
        const bad = rows.filter((r) => rejectedIds.has(r.eventId));
        await this.outbox.markPublished(
          manager,
          ok.map((r) => r.id),
        );
        await this.outbox.recordFailure(
          manager,
          bad.map((r) => r.id),
        );
        for (const row of bad) {
          const error = outcome.rejected.find(
            (r) => r.eventId === row.eventId,
          )?.error;
          const attempts = row.attempts + 1;
          // Loud, but only for THIS event: its aggregate is held back, everything else keeps flowing.
          this.logger[attempts >= ERROR_LOG_AFTER_ATTEMPTS ? 'error' : 'warn'](
            {
              eventId: row.eventId,
              topic: row.topic,
              aggregateId: row.aggregateId,
              attempts,
              err: error?.message,
            },
            'outbox event rejected and held back',
          );
        }
        return {
          claimed: rows.length,
          published: ok.length,
          rejected: bad.length,
        };
      },
    );

    this.record(result);
    return result;
  }

  // ---- loops ----------------------------------------------------------------------------------

  private async publishLoop(): Promise<void> {
    const { pollIntervalMs, batchSize } = this.config.outbox;
    let failures = 0;
    while (this.running) {
      let pause = pollIntervalMs;
      try {
        const result = await this.tick();
        if (result.error) {
          failures++;
          pause = this.backoff(failures);
          this.logger.warn(
            {
              err: result.error.message,
              retryInMs: pause,
              rows: result.claimed,
            },
            'outbox publish failed, will retry',
          );
        } else {
          failures = 0;
          if (result.claimed >= batchSize) continue; // more is waiting: no pause
        }
      } catch (err) {
        failures++;
        pause = this.backoff(failures);
        this.state.consecutiveFailures++;
        this.state.lastFailureAt = new Date();
        this.state.lastError = (err as Error).message;
        this.logger.error(
          { err, retryInMs: pause },
          'outbox relay cycle failed',
        );
      }
      await this.pause(pause);
    }
  }

  /** Exponential backoff with jitter: 0.5 s, 1 s, 2 s ... capped at OUTBOX_MAX_BACKOFF_MS. */
  private backoff(failures: number): number {
    const { pollIntervalMs, maxBackoffMs } = this.config.outbox;
    const base = Math.min(
      maxBackoffMs,
      Math.max(pollIntervalMs, 500) * 2 ** (failures - 1),
    );
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  private async pause(ms: number): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false;
      return;
    }
    const wake = new AbortController();
    this.wakeUp = () => wake.abort();
    await sleep(ms, AbortSignal.any([this.stop.signal, wake.signal]));
    this.wakeUp = undefined;
  }

  private wake(): void {
    if (this.wakeUp) this.wakeUp();
    else this.wakePending = true; // arrived while a batch was being processed: do not lose it
  }

  /** Holds a dedicated connection that LISTENs for new outbox rows; reconnects forever, polling covers the gaps. */
  private async listenLoop(): Promise<void> {
    const { host, port, name, user, password } = this.config.db;
    while (this.running) {
      const client = new Client({ host, port, database: name, user, password });
      client.on('error', (err) =>
        this.logger.warn(
          { err: err.message },
          'outbox listener connection error',
        ),
      );
      try {
        await client.connect();
        client.on('notification', () => this.wake());
        await client.query(`LISTEN ${LISTEN_CHANNEL}`);
        this.listener = client;
        this.wake(); // anything inserted while we were not listening
        // Stay until the connection drops OR we are told to stop (shutdown may arrive while we were still connecting).
        await new Promise<void>((resolve) => {
          client.once('end', resolve);
          if (this.stop.signal.aborted) resolve();
          else
            this.stop.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message },
          'outbox listener could not connect, relying on polling',
        );
      } finally {
        this.listener = undefined;
        await client.end().catch(() => undefined);
      }
      if (this.running) await sleep(2000, this.stop.signal);
    }
  }

  private record(result: TickResult): void {
    const s = this.state;
    if (result.claimed === 0) return;
    if (result.error) {
      s.consecutiveFailures++;
      s.failedBatchesTotal++;
      s.lastFailureAt = new Date();
      s.lastError = result.error.message;
      return;
    }
    s.publishedTotal += result.published;
    s.rejectedTotal += result.rejected;
    if (result.published > 0) {
      s.consecutiveFailures = 0;
      s.lastSuccessAt = new Date();
    }
  }
}
