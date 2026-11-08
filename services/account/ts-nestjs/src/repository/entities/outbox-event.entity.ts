import type { JsonObject } from '../../util/json.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** `outbox_event` table (README 4.3 / 6.1). Rows are written in the SAME transaction as the domain change. */
@Entity({ name: 'outbox_event' })
export class OutboxEvent {
  /** bigserial: pg returns bigint as string, which is fine for ordering and keys. */
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ type: 'uuid', unique: true })
  eventId!: string;

  @Column({ type: 'varchar', length: 64 })
  aggregateType!: string;

  @Column({ type: 'varchar', length: 64 })
  aggregateId!: string;

  @Column({ type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ type: 'varchar', length: 200 })
  topic!: string;

  @Column({ type: 'jsonb' })
  payload!: JsonObject;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  headers!: Record<string, string>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;
}
