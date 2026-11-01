import {
  EventPublisher,
  type OutboundEvent,
  type PublishOutcome,
} from '../../src/domain/event-publisher.js';

/** In-memory broker stand-in with the failure hooks the relay tests need. */
export class FakePublisher extends EventPublisher {
  /** Everything "acknowledged by the broker", in order. */
  published: OutboundEvent[] = [];
  /** While set, publish() throws (broker down). */
  down?: Error;
  /** Event ids that are individually unpublishable (schema problems). */
  poison = new Set<string>();
  /** Awaited at the start of every publish() (use a latch to hold a batch "in flight"). */
  gate?: () => Promise<void>;
  calls = 0;

  reset(): void {
    this.published = [];
    this.down = undefined;
    this.poison.clear();
    this.gate = undefined;
    this.calls = 0;
  }

  async publish(events: OutboundEvent[]): Promise<PublishOutcome> {
    this.calls++;
    await this.gate?.();
    if (this.down) throw this.down;
    const rejected = events
      .filter((e) => this.poison.has(e.eventId))
      .map((e) => ({
        eventId: e.eventId,
        error: new Error('schema violation'),
      }));
    this.published.push(...events.filter((e) => !this.poison.has(e.eventId)));
    return { rejected };
  }
}

/** A promise you resolve by hand: hold a publish in flight, then let it go. */
export function latch(): { wait: () => Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { wait: () => promise, open };
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  what = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
