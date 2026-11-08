import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type FakeRegistry,
  startFakeRegistry,
} from '../../../test/support/fake-registry.js';
import {
  TOPICS,
  userDeleted,
  userProfileUpdated,
  userRegistered,
} from '../../domain/user-events.js';
import { User } from '../../repository/entities/user.entity.js';
import {
  AvroRegistry,
  PermanentEncodingError,
  RegistryUnavailableError,
} from './avro-registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const serviceAvro = join(here, '..', '..', 'resources', 'avro');
const contractsAvro = join(
  here,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'avro',
);

const user = Object.assign(new User(), {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'alice_01',
  email: 'alice@example.com',
  displayName: 'Alice',
  locale: 'en',
  avatarAssetId: null,
});
const now = new Date('2026-10-25T10:00:00.000Z');

describe('AvroRegistry', () => {
  let registry: FakeRegistry;
  let avro: AvroRegistry;

  beforeAll(async () => {
    registry = await startFakeRegistry();
  });
  afterAll(() => registry.close());
  beforeEach(() => {
    registry.registrations.length = 0;
    registry.forceStatus = undefined;
    registry.rejectPrefix = undefined;
    avro = new AvroRegistry(registry.url, 1000);
  });

  it('has a schema for every topic the service publishes', () => {
    expect(avro.topics().sort()).toEqual(Object.values(TOPICS).sort());
  });

  describe('contract: every outbox event matches its Avro schema', () => {
    it.each([
      ['UserRegistered', TOPICS.registered, () => userRegistered(user, now)],
      [
        'UserProfileUpdated',
        TOPICS.profileUpdated,
        () => userProfileUpdated(user, now),
      ],
      ['UserDeleted', TOPICS.deleted, () => userDeleted(user, now)],
    ])('%s round-trips unchanged', async (_name, topic, make) => {
      const event = make();
      const bytes = await avro.encode(topic, event.payload);
      expect(await avro.decode(bytes)).toEqual(event.payload);
    });

    it('handles the nullable avatarAssetId both ways', async () => {
      for (const avatarAssetId of [null, 'asset-123']) {
        const payload = userProfileUpdated(
          Object.assign(new User(), { ...user, avatarAssetId }),
          now,
        ).payload;
        expect(
          await avro.decode(await avro.encode(TOPICS.profileUpdated, payload)),
        ).toMatchObject({ avatarAssetId });
      }
    });
  });

  it('frames messages in the Confluent wire format: magic byte, schema id, Avro bytes', async () => {
    const bytes = await avro.encode(
      TOPICS.deleted,
      userDeleted(user, now).payload,
    );
    expect(bytes[0]).toBe(0);
    const again = await avro.encode(
      TOPICS.deleted,
      userDeleted(user, now).payload,
    );
    expect(bytes.readUInt32BE(1)).toBeGreaterThanOrEqual(100); // an id handed out by the registry
    expect(again.readUInt32BE(1)).toBe(bytes.readUInt32BE(1)); // stable per schema
    expect(bytes.length).toBeGreaterThan(5);
  });

  it('registers each schema once, even for concurrent encodes', async () => {
    const payload = userDeleted(user, now).payload;
    await Promise.all(
      [1, 2, 3, 4, 5].map(() => avro.encode(TOPICS.deleted, payload)),
    );
    await avro.encode(TOPICS.deleted, payload);
    expect(registry.registrations).toEqual([`${TOPICS.deleted}-value`]);
  });

  it('rejects a payload that violates the schema, naming the field (permanent)', async () => {
    const { email: _omitted, ...incomplete } = userRegistered(
      user,
      now,
    ).payload;
    await expect(
      avro.encode(TOPICS.registered, incomplete),
    ).rejects.toThrowError(/email/);
    await expect(
      avro.encode(TOPICS.registered, {
        ...userRegistered(user, now).payload,
        occurredAt: 'yesterday',
      }),
    ).rejects.toBeInstanceOf(PermanentEncodingError);
  });

  it('rejects a topic without a schema (permanent)', async () => {
    await expect(avro.encode('account.unknown.v1', {})).rejects.toBeInstanceOf(
      PermanentEncodingError,
    );
  });

  it('treats a registry compatibility rejection (409) as permanent', async () => {
    registry.rejectPrefix = TOPICS.deleted;
    await expect(
      avro.encode(TOPICS.deleted, userDeleted(user, now).payload),
    ).rejects.toBeInstanceOf(PermanentEncodingError);
  });

  it('treats an unavailable registry as transient and recovers afterwards (failures are not cached)', async () => {
    const payload = userDeleted(user, now).payload;
    registry.forceStatus = 503;
    await expect(avro.encode(TOPICS.deleted, payload)).rejects.toBeInstanceOf(
      RegistryUnavailableError,
    );
    registry.forceStatus = undefined;
    await expect(avro.encode(TOPICS.deleted, payload)).resolves.toBeInstanceOf(
      Buffer,
    );

    const dead = new AvroRegistry('http://127.0.0.1:1', 500);
    await expect(dead.encode(TOPICS.deleted, payload)).rejects.toBeInstanceOf(
      RegistryUnavailableError,
    );
  });

  it('refuses to decode bytes that are not Confluent-framed', async () => {
    await expect(avro.decode(Buffer.from([1, 2, 3]))).rejects.toBeInstanceOf(
      PermanentEncodingError,
    );
  });

  it('loads schemas from a custom directory (topic = file name)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avsc-'));
    cpSync(
      join(serviceAvro, `${TOPICS.deleted}.avsc`),
      join(dir, 'my.topic.v1.avsc'),
    );
    expect(new AvroRegistry(registry.url, 1000, dir).topics()).toEqual([
      'my.topic.v1',
    ]);
  });
});

describe('Avro schema files', () => {
  it('the service copy is identical to contracts/avro (run `pnpm contracts:sync` if this fails)', () => {
    const files = readdirSync(contractsAvro)
      .filter((f) => f.endsWith('.avsc'))
      .sort();
    expect(
      readdirSync(serviceAvro)
        .filter((f) => f.endsWith('.avsc'))
        .sort(),
    ).toEqual(files);
    for (const f of files) {
      expect(readFileSync(join(serviceAvro, f), 'utf8')).toBe(
        readFileSync(join(contractsAvro, f), 'utf8'),
      );
    }
  });
});
