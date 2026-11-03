/**
 * End-to-end test against REAL Kafka and a REAL Schema Registry (the docker compose infrastructure):
 *
 *   pnpm infra:up                                   # kafka (9094), schema-registry (8085), topics created by kafka-init
 *   pnpm --filter account-service test:kafka
 *
 * It registers a user through the HTTP API, updates and deletes the profile, and reads the three events back
 * from Kafka with an independent consumer: decoding Avro through the registry, checking key, headers and order.
 * Postgres and Redis come from TEST_DB_URL / TEST_REDIS_URL or from Testcontainers (Docker must be running).
 */
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  Consumer,
  MessagesStreamModes,
  stringDeserializers,
} from '@platformatic/kafka';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHttp } from '../src/api/http/setup-http.js';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import { IdentityProvider } from '../src/domain/identity-provider.js';
import { TOPICS } from '../src/domain/user-events.js';
import { AvroRegistry } from '../src/infra/kafka/avro-registry.js';
import { LOGGER } from '../src/infra/logger.js';
import { createDataSource } from '../src/repository/data-source.js';
import { testConfig } from './support/config.js';
import { FakeIdentityProvider } from './support/fake-identity.js';
import { type FakeIssuer, startFakeIssuer } from './support/fake-issuer.js';
import { startTestDatabase, type TestDatabase } from './support/postgres.js';
import { startTestRedis, type TestRedis } from './support/redis.js';
import type { Logger } from 'pino';

const BROKERS = (process.env.TEST_KAFKA_BROKERS ?? 'localhost:9094').split(',');
const REGISTRY_URL =
  process.env.TEST_SCHEMA_REGISTRY_URL ?? 'http://localhost:8085';

interface Received {
  topic: string;
  key: string;
  headers: Map<string, string>;
  value: Buffer;
}

let db: TestDatabase;
let redisServer: TestRedis;
let issuer: FakeIssuer;
let app: NestFastifyApplication;
let consumer: Consumer<string, Buffer, string, string>;
let stream: Awaited<ReturnType<typeof consumer.consume>>;
const received: Received[] = [];
const idp = new FakeIdentityProvider();

async function waitFor(
  condition: () => boolean,
  ms: number,
  what: string,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  [db, redisServer, issuer] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    startFakeIssuer(),
  ]);
  const admin = createDataSource(db.db);
  await admin.initialize();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.runMigrations();
  await admin.destroy();

  // An independent consumer, positioned at the end of the topics BEFORE anything is published.
  consumer = new Consumer<string, Buffer, string, string>({
    groupId: `account-it-${crypto.randomUUID()}`,
    clientId: 'account-it-consumer',
    bootstrapBrokers: BROKERS,
    deserializers: { ...stringDeserializers, value: (data?: Buffer) => data },
  });
  stream = await consumer.consume({
    autocommit: true,
    topics: Object.values(TOPICS),
    mode: MessagesStreamModes.LATEST,
    sessionTimeout: 10_000,
    heartbeatInterval: 500,
  });
  stream.on('data', (m) =>
    received.push({
      topic: m.topic,
      key: m.key,
      headers: m.headers as Map<string, string>,
      value: m.value,
    }),
  );
  await new Promise((r) => setTimeout(r, 3000)); // let the group join and get its partitions

  const config = testConfig({
    db: db.db,
    redis: { url: redisServer.url },
    auth: { jwksUrl: issuer.jwksUrl },
    kafka: {
      brokers: BROKERS,
      schemaRegistryUrl: REGISTRY_URL,
      clientId: 'account-service-it',
      sendTimeoutMs: 10_000,
    },
    outbox: {
      relayEnabled: true,
      pollIntervalMs: 100,
      batchSize: 50,
      maxBackoffMs: 2000,
    },
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(IdentityProvider)
    .useValue(idp)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  setupHttp(app, app.get<Logger>(LOGGER));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await stream?.close();
  await consumer?.close();
  await issuer?.close();
  await db?.stop();
  await redisServer?.stop();
});

describe('events reach real Kafka as Avro', () => {
  it('delivers UserRegistered, UserProfileUpdated and UserDeleted for one user, in order, schema-checked', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/registrations',
      payload: {
        username: `kafka_${Date.now()}`,
        email: `kafka_${Date.now()}@example.com`,
        password: 'correct-horse-battery',
        displayName: 'Kafka Test',
      },
    });
    expect(registered.statusCode).toBe(201);
    const userId = registered.json().id as string;
    const as = { authorization: `Bearer ${await issuer.token(userId)}` };

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { ...as, 'if-match': '"1"' },
      payload: { displayName: 'Renamed' },
    });
    expect(patched.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/users/${userId}`,
          headers: as,
        })
      ).statusCode,
    ).toBe(204);

    const mine = () => received.filter((m) => m.key === userId);
    await waitFor(
      () => mine().length >= 3,
      30_000,
      'three events for the user on Kafka',
    );

    // Same key -> same partition -> the order of writing is the order of reading.
    expect(mine().map((m) => m.headers.get('eventType'))).toEqual([
      'UserRegistered',
      'UserProfileUpdated',
      'UserDeleted',
    ]);
    expect(mine().map((m) => m.topic)).toEqual([
      TOPICS.registered,
      TOPICS.profileUpdated,
      TOPICS.deleted,
    ]);

    const registry = new AvroRegistry(REGISTRY_URL);
    const [first, second, third] = await Promise.all(
      mine().map((m) => registry.decode(m.value)),
    );
    expect(first).toMatchObject({
      userId,
      username: registered.json().username,
      email: registered.json().email,
      locale: 'en',
    });
    expect(second).toMatchObject({
      userId,
      displayName: 'Renamed',
      avatarAssetId: null,
    });
    expect(third).toMatchObject({ userId });
    expect((first as { eventId: string }).eventId).toBe(
      mine()[0]!.headers.get('eventId'),
    );
    expect(mine()[0]!.headers.get('traceparent')).toMatch(
      /^00-[\da-f]{32}-[\da-f]{16}-01$/,
    );

    const subjects = (await (
      await fetch(`${REGISTRY_URL}/subjects`)
    ).json()) as string[];
    expect(subjects).toEqual(
      expect.arrayContaining(Object.values(TOPICS).map((t) => `${t}-value`)),
    );
  });
});
