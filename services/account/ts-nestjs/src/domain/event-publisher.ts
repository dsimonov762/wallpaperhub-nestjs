/**
 * Port to the message broker. The relay depends on this abstract class, never on Kafka:
 * tests plug in a fake, the real adapter lives in infra/kafka.
 */
export interface OutboundEvent {
  eventId: string;
  topic: string;
  /** Partition key. Same key = same partition = delivered in order. We use the aggregate id (the user id). */
  key: string;
  eventType: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface RejectedEvent {
  eventId: string;
  error: Error;
}

export interface PublishOutcome {
  /** Events that can never be published as they are (e.g. payload violates the schema): a bug, not an outage. */
  rejected: RejectedEvent[];
}

export abstract class EventPublisher {
  /**
   * Publishes the events and resolves once the broker has acknowledged all of them.
   *
   * - Resolves with `rejected` entries for events that are individually unpublishable; all others WERE published.
   * - Rejects (throws) when the broker or schema registry is unavailable: NOTHING may be assumed published.
   *
   * Delivery is at-least-once: after a throw (or a crash) the same events may be sent again.
   */
  abstract publish(events: OutboundEvent[]): Promise<PublishOutcome>;
}
