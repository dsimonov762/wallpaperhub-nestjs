import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Producer, stringSerializers } from '@platformatic/kafka';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/config.js';
import {
  EventPublisher,
  type OutboundEvent,
  type PublishOutcome,
  type RejectedEvent,
} from '../../domain/event-publisher.js';
import { LOGGER } from '../logger.js';
import { AvroRegistry, PermanentEncodingError } from './avro-registry.js';

/** The slice of the Kafka producer we use (lets tests substitute a fake). */
export interface ProducerLike {
  send(options: {
    messages: {
      topic: string;
      key: string;
      value: Buffer;
      headers: Record<string, string>;
    }[];
  }): Promise<unknown>;
  close(): Promise<void>;
}

export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');

export function createProducer(config: AppConfig): ProducerLike {
  return new Producer<string, Buffer, string, string>({
    clientId: config.kafka.clientId,
    bootstrapBrokers: config.kafka.brokers,
    // Idempotent producer: the broker de-duplicates producer retries (forces acks=all), so a retry after a
    // timeout cannot write the same message twice. Messages with one key keep their order.
    idempotent: true,
    timeout: config.kafka.sendTimeoutMs,
    // Local convenience: create missing topics. Production topics are created by infrastructure code.
    autocreateTopics: config.profile !== 'prod',
    serializers: { ...stringSerializers, value: (v?: Buffer) => v },
  });
}

/** W3C `traceparent` header from a bare trace id, so consumers can continue the same trace. */
export const traceparentOf = (traceId: string): string =>
  `00-${traceId}-${randomBytes(8).toString('hex')}-01`;

@Injectable()
export class KafkaEventPublisher
  extends EventPublisher
  implements OnApplicationShutdown
{
  constructor(
    @Inject(KAFKA_PRODUCER) private readonly producer: ProducerLike,
    private readonly registry: AvroRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    super();
  }

  async publish(events: OutboundEvent[]): Promise<PublishOutcome> {
    const rejected: RejectedEvent[] = [];
    const messages: {
      topic: string;
      key: string;
      value: Buffer;
      headers: Record<string, string>;
    }[] = [];

    for (const event of events) {
      try {
        const value = await this.registry.encode(event.topic, event.payload);
        const traceId = event.headers.trace_id;
        messages.push({
          topic: event.topic,
          key: event.key,
          value,
          headers: {
            eventId: event.eventId,
            eventType: event.eventType,
            ...(traceId
              ? { trace_id: traceId, traceparent: traceparentOf(traceId) }
              : {}),
          },
        });
      } catch (err) {
        // A schema problem is specific to this event; an unreachable registry is not: let that one propagate.
        if (!(err instanceof PermanentEncodingError)) throw err;
        rejected.push({ eventId: event.eventId, error: err });
      }
    }

    if (messages.length > 0) await this.producer.send({ messages });
    this.logger.debug(
      { sent: messages.length, rejected: rejected.length },
      'published batch to Kafka',
    );
    return { rejected };
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.producer.close();
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        'kafka producer did not close cleanly',
      );
    }
  }
}
