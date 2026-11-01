import type { JsonObject } from '../util/json.js';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { OutboxEvent } from './entities/outbox-event.entity.js';

export interface NewOutboxEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  topic: string;
  payload: JsonObject;
  headers?: Record<string, string>;
}

/**
 * Transactional outbox storage (README 4.3).
 * Every method takes the caller's EntityManager so it joins the caller's transaction.
 */
@Injectable()
export class OutboxRepository {
  /** Call this INSIDE the same transaction that changes the domain data. */
  async enqueue(manager: EntityManager, event: NewOutboxEvent): Promise<void> {
    await manager.insert(OutboxEvent, {
      ...event,
      headers: event.headers ?? {},
    });
  }

  /**
   * Locks and returns the next rows to publish, oldest first.
   *
   * Two rules keep this safe with several relay instances running at once:
   *  1. `FOR UPDATE SKIP LOCKED`: rows another relay already holds are silently skipped.
   *  2. Only the EARLIEST unpublished row of each aggregate is eligible. While relay A holds (or has
   *     failed to publish) an aggregate's first row, relay B cannot publish that aggregate's later rows,
   *     so events of one aggregate always leave in the order they were written. Rows of different
   *     aggregates still flow in parallel.
   *
   * Must run inside a transaction: the row locks last until it ends.
   */
  async claimUnpublished(
    manager: EntityManager,
    limit = 100,
  ): Promise<OutboxEvent[]> {
    return manager
      .createQueryBuilder(OutboxEvent, 'o')
      .where('o.published_at IS NULL')
      .andWhere(
        `NOT EXISTS (
           SELECT 1 FROM outbox_event p
           WHERE p.aggregate_id = o.aggregate_id AND p.published_at IS NULL AND p.id < o.id
         )`,
      )
      .orderBy('o.id', 'ASC')
      .limit(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
  }

  async markPublished(manager: EntityManager, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await manager
      .createQueryBuilder()
      .update(OutboxEvent)
      .set({ publishedAt: () => 'now()' })
      .where('id IN (:...ids)', { ids })
      .execute();
  }

  async recordFailure(manager: EntityManager, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await manager
      .createQueryBuilder()
      .update(OutboxEvent)
      .set({ attempts: () => 'attempts + 1' })
      .where('id IN (:...ids)', { ids })
      .execute();
  }

  /** Backlog numbers for monitoring: how many events wait, how long the oldest has waited. */
  async stats(manager: EntityManager): Promise<OutboxStats> {
    const [row] = (await manager.query(
      `SELECT count(*)::int AS unpublished,
              COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))), 0)::float AS oldest_age_seconds,
              COALESCE(max(attempts), 0)::int AS max_attempts
         FROM outbox_event WHERE published_at IS NULL`,
    )) as {
      unpublished: number;
      oldest_age_seconds: number;
      max_attempts: number;
    }[];
    return {
      unpublished: row!.unpublished,
      oldestAgeSeconds: Math.round(row!.oldest_age_seconds),
      maxAttempts: row!.max_attempts,
    };
  }

  /** Deletes up to `limit` published rows older than `cutoff`; returns how many. Call repeatedly until 0. */
  async deletePublishedBefore(
    manager: EntityManager,
    cutoff: Date,
    limit = 1000,
  ): Promise<number> {
    const [, count] = (await manager.query(
      `DELETE FROM outbox_event WHERE id IN (
         SELECT id FROM outbox_event WHERE published_at IS NOT NULL AND published_at < $1 ORDER BY id LIMIT $2
       )`,
      [cutoff, limit],
    )) as [unknown, number];
    return count;
  }
}

export interface OutboxStats {
  unpublished: number;
  oldestAgeSeconds: number;
  maxAttempts: number;
}
