import type { JsonObject } from '../../util/json.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** `audit_log` table (README 6.1 / 11): application-level audit written by an ORM subscriber. */
@Entity({ name: 'audit_log' })
export class AuditLog {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 32 })
  action!: string;

  @Column({ type: 'varchar', length: 64 })
  entityType!: string;

  @Column({ type: 'varchar', length: 64 })
  entityId!: string;

  @Column({ type: 'jsonb', nullable: true })
  before!: JsonObject | null;

  @Column({ type: 'jsonb', nullable: true })
  after!: JsonObject | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  traceId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
