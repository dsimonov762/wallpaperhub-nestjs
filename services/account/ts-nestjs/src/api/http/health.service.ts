import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { OutboxMonitor } from '../../jobs/outbox-monitor.js';
import { REDIS } from '../../infra/redis.module.js';

export interface CheckResult {
  status: 'UP' | 'DOWN';
  error?: string;
  /**
   * Only critical checks decide overall readiness. A non-critical dependency (Redis) is REPORTED when
   * down, but the instance stays in rotation: it degrades (no rate limiting) instead of causing an outage.
   */
  critical: boolean;
}

export interface ReadinessReport {
  status: 'UP' | 'DOWN';
  checks: Record<string, CheckResult>;
}

/**
 * Backs the management endpoints (README 11):
 *  - live:    the process is running (never checks dependencies, or a DB blip would restart the pod)
 *  - ready:   dependencies are reachable (DB now; Redis/Kafka are added as they appear)
 *  - startup: bootstrap finished
 */
@Injectable()
export class HealthService {
  private started = false;
  private draining = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly outboxMonitor: OutboxMonitor,
  ) {}

  markStarted(): void {
    this.started = true;
  }

  /** Called when shutdown begins: readiness turns DOWN so the load balancer stops sending traffic. */
  markDraining(): void {
    this.draining = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  async readiness(): Promise<ReadinessReport> {
    const checks: Record<string, CheckResult> = {
      postgres: await this.run(true, () => this.dataSource.query('SELECT 1')),
      redis: await this.run(false, () => this.redis.ping()),
      // Kafka outages must not take the API out of rotation: events wait safely in the outbox table.
      outbox: await this.run(false, async () => {
        const health = await this.outboxMonitor.health();
        if (!health.ok) throw new Error(health.reason);
      }),
    };
    const allUp =
      Object.values(checks).every((c) => !c.critical || c.status === 'UP') &&
      !this.draining;
    return { status: allUp ? 'UP' : 'DOWN', checks };
  }

  private async run(
    critical: boolean,
    fn: () => Promise<unknown>,
    timeoutMs = 2000,
  ): Promise<CheckResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ]);
      return { status: 'UP', critical };
    } catch (e) {
      return {
        status: 'DOWN',
        critical,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
