import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import {
  type OutboxStats,
  OutboxRepository,
} from '../repository/outbox.repository.js';
import { OutboxRelay, type RelayStatus } from './outbox-relay.js';

export interface OutboxSnapshot extends OutboxStats {
  relay: RelayStatus;
}

const UNHEALTHY_AFTER_FAILURES = 3;
const UNHEALTHY_BACKLOG_SECONDS = 120;

/** Outbox numbers for the management endpoint and the readiness report (step 1.7 maps them to OpenTelemetry gauges). */
@Injectable()
export class OutboxMonitor {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxRepository,
    private readonly relay: OutboxRelay,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async snapshot(): Promise<OutboxSnapshot> {
    return {
      ...(await this.outbox.stats(this.dataSource.manager)),
      relay: this.relay.status(),
    };
  }

  /** Healthy unless the relay is enabled and either failing repeatedly or the oldest event has waited too long. */
  async health(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.config.outbox.relayEnabled) return { ok: true };
    const snap = await this.snapshot();
    if (snap.relay.consecutiveFailures >= UNHEALTHY_AFTER_FAILURES) {
      return {
        ok: false,
        reason: `relay failing: ${snap.relay.lastError ?? 'unknown error'}`,
      };
    }
    if (
      snap.unpublished > 0 &&
      snap.oldestAgeSeconds > UNHEALTHY_BACKLOG_SECONDS
    ) {
      return {
        ok: false,
        reason: `backlog: ${snap.unpublished} events, oldest waiting ${snap.oldestAgeSeconds}s`,
      };
    }
    return { ok: true };
  }
}
