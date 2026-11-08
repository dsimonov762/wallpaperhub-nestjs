import type { JsonObject } from '../util/json.js';
import {
  type EntitySubscriberInterface,
  EventSubscriber,
  type InsertEvent,
  type SoftRemoveEvent,
  type UpdateEvent,
} from 'typeorm';
import { currentContext } from '../api/http/request-context.js';
import { AuditLog } from './entities/audit-log.entity.js';
import { User } from './entities/user.entity.js';

/**
 * Application-level audit via ORM entity listeners (README 11).
 * Runs inside the same transaction as the change, so the audit row can never
 * exist without the change (or the other way round).
 */
@EventSubscriber()
export class UserAuditSubscriber implements EntitySubscriberInterface<User> {
  listenTo() {
    return User;
  }

  async afterInsert(event: InsertEvent<User>): Promise<void> {
    await this.write(
      event.manager,
      'INSERT',
      event.entity.id,
      null,
      event.entity,
    );
  }

  async afterUpdate(event: UpdateEvent<User>): Promise<void> {
    const after = event.entity as User | undefined;
    if (!after?.id) return;
    await this.write(
      event.manager,
      'UPDATE',
      after.id,
      event.databaseEntity ?? null,
      after,
    );
  }

  async afterSoftRemove(event: SoftRemoveEvent<User>): Promise<void> {
    const entity = event.entity ?? event.databaseEntity;
    if (!entity?.id) return;
    await this.write(
      event.manager,
      'DELETE',
      entity.id,
      event.databaseEntity ?? null,
      null,
    );
  }

  private async write(
    manager: InsertEvent<User>['manager'],
    action: string,
    entityId: string,
    before: User | null,
    after: User | null,
  ): Promise<void> {
    const ctx = currentContext();
    await manager.insert(AuditLog, {
      actorId: ctx?.userId ?? null,
      action,
      entityType: 'User',
      entityId,
      before: before ? snapshot(before) : null,
      after: after ? snapshot(after) : null,
      traceId: ctx?.traceId ?? null,
    });
  }
}

/** Plain JSON copy of an entity without noisy bookkeeping columns. */
function snapshot(user: User): JsonObject {
  const {
    updatedAt: _u,
    version: _v,
    ...rest
  } = JSON.parse(JSON.stringify(user)) as JsonObject;
  return rest;
}
