import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type FakeRegistry,
  startFakeRegistry,
} from '../../../test/support/fake-registry.js';
import type { OutboundEvent } from '../../domain/event-publisher.js';
import { TOPICS } from '../../domain/user-events.js';
import { AvroRegistry, RegistryUnavailableError } from './avro-registry.js';
import {
  KafkaEventPublisher,
  type ProducerLike,
} from './kafka-event-publisher.js';

const event = (
  n: number,
  over: Partial<OutboundEvent> = {},
): OutboundEvent => ({
  eventId: `00000000-0000-4000-8000-00000000000${n}`,
  topic: TOPICS.deleted,
  key: `user-${n}`,
  eventType: 'UserDeleted',
  payload: {
    eventId: `00000000-0000-4000-8000-00000000000${n}`,
    userId: `user-${n}`,
    occurredAt: 1_700_000_000_000,
  },
  headers: { trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' },
  ...over,
});

describe('KafkaEventPublisher', () => {
  let registry: FakeRegistry;
  let sent: Parameters<ProducerLike['send']>[0][];
  let sendError: Error | undefined;
  let closed = false;
  let publisher: KafkaEventPublisher;
  let avro: AvroRegistry;

  const producer: ProducerLike = {
    send: async (options) => {
      if (sendError) throw sendError;
      sent.push(options);
      return {};
    },
    close: async () => {
      closed = true;
    },
  };

  beforeAll(async () => {
    registry = await startFakeRegistry();
  });
  afterAll(() => registry.close());
  beforeEach(() => {
    sent = [];
    sendError = undefined;
    closed = false;
    registry.forceStatus = undefined;
    avro = new AvroRegistry(registry.url, 1000);
    publisher = new KafkaEventPublisher(
      producer,
      avro,
      pino({ level: 'silent' }),
    );
  });

  it('sends Avro-encoded messages keyed by aggregate id, with event and trace headers', async () => {
    const outcome = await publisher.publish([
      event(1),
      event(2, { headers: {} }),
    ]);
    expect(outcome.rejected).toEqual([]);
    expect(sent).toHaveLength(1);

    const [first, second] = sent[0]!.messages;
    expect(first).toMatchObject({ topic: TOPICS.deleted, key: 'user-1' });
    expect(first!.value[0]).toBe(0); // Confluent magic byte
    expect(first!.headers).toMatchObject({
      eventId: event(1).eventId,
      eventType: 'UserDeleted',
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
    expect(first!.headers.traceparent).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[\da-f]{16}-01$/,
    );
    expect(second!.headers).not.toHaveProperty('traceparent');
    expect(await avro.decode(first!.value)).toEqual(event(1).payload);
  });

  it('rejects only the event that violates its schema and still sends the others', async () => {
    const bad = event(2, { payload: { eventId: 'x', userId: 'user-2' } }); // occurredAt missing
    const outcome = await publisher.publish([event(1), bad, event(3)]);
    expect(outcome.rejected.map((r) => r.eventId)).toEqual([bad.eventId]);
    expect(sent[0]!.messages.map((m) => m.key)).toEqual(['user-1', 'user-3']);
  });

  it('does not call the broker when nothing is publishable', async () => {
    const outcome = await publisher.publish([
      event(1, { topic: 'account.unknown.v1' }),
    ]);
    expect(outcome.rejected).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('throws (nothing published) when the schema registry is down', async () => {
    registry.forceStatus = 503;
    await expect(publisher.publish([event(1)])).rejects.toBeInstanceOf(
      RegistryUnavailableError,
    );
    expect(sent).toHaveLength(0);
  });

  it('throws when the broker send fails', async () => {
    sendError = new Error('broker unreachable');
    await expect(publisher.publish([event(1)])).rejects.toThrowError(
      'broker unreachable',
    );
  });

  it('closes the producer on shutdown, and survives a failing close', async () => {
    await publisher.onApplicationShutdown();
    expect(closed).toBe(true);
    const failing = new KafkaEventPublisher(
      { ...producer, close: async () => Promise.reject(new Error('x')) },
      avro,
      pino({ level: 'silent' }),
    );
    await expect(failing.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
