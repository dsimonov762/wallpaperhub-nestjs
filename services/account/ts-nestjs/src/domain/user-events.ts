import { currentContext } from '../api/http/request-context.js';
import type { NewOutboxEvent } from '../repository/outbox.repository.js';
import type { User } from '../repository/entities/user.entity.js';
import { newUuid } from '../util/ids.js';

/**
 * Domain events as outbox rows. Each payload has EXACTLY the shape of its Avro schema in
 * contracts/avro (timestamps are epoch milliseconds), so the relay can encode it as-is.
 */
export const TOPICS = {
  registered: 'account.user.registered.v1',
  profileUpdated: 'account.user.profile-updated.v1',
  deleted: 'account.user.deleted.v1',
} as const;

function base(
  user: Pick<User, 'id'>,
  eventType: string,
  topic: string,
  payload: Record<string, unknown>,
): NewOutboxEvent {
  const eventId = newUuid();
  const traceId = currentContext()?.traceId;
  return {
    eventId,
    aggregateType: 'User',
    aggregateId: user.id,
    eventType,
    topic,
    payload: { eventId, userId: user.id, ...payload },
    headers: traceId ? { trace_id: traceId } : {},
  };
}

export const userRegistered = (user: User, now: Date): NewOutboxEvent =>
  base(user, 'UserRegistered', TOPICS.registered, {
    username: user.username,
    email: user.email,
    locale: user.locale,
    occurredAt: now.getTime(),
  });

export const userProfileUpdated = (user: User, now: Date): NewOutboxEvent =>
  base(user, 'UserProfileUpdated', TOPICS.profileUpdated, {
    username: user.username,
    displayName: user.displayName,
    avatarAssetId: user.avatarAssetId,
    occurredAt: now.getTime(),
  });

export const userDeleted = (user: User, now: Date): NewOutboxEvent =>
  base(user, 'UserDeleted', TOPICS.deleted, { occurredAt: now.getTime() });
