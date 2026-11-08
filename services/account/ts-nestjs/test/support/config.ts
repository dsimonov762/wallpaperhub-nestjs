import type { AppConfig } from '../../src/config/config.js';

type Overrides = Partial<{
  [K in Exclude<keyof AppConfig, 'profile'>]: Partial<AppConfig[K]>;
}>;

/** A complete AppConfig for tests; override only the parts a test cares about. */
export function testConfig(over: Overrides = {}): AppConfig {
  return {
    profile: 'test',
    http: {
      host: '127.0.0.1',
      port: 0,
      grpcPort: 0,
      mgmtPort: 0,
      bodyLimitBytes: 1_048_576,
      trustProxy: false,
      ...over.http,
    },
    log: { level: 'silent', pretty: false, ...over.log },
    db: {
      host: 'localhost',
      port: 5432,
      name: 'x',
      user: 'x',
      password: 'x',
      poolMax: 5,
      migrateOnStartup: false,
      ...over.db,
    },
    redis: { url: 'redis://localhost:6379', ...over.redis },
    auth: {
      issuer: 'http://keycloak.test/realms/wallpaperhub',
      jwksUrl: 'http://127.0.0.1:1/certs',
      audience: 'account-svc',
      clockToleranceSeconds: 5,
      jwksTimeoutMs: 1000,
      jwksCooldownMs: 0,
      ...over.auth,
    },
    keycloak: {
      baseUrl: 'http://127.0.0.1:1',
      realm: 'wallpaperhub',
      clientId: 'account-svc',
      clientSecret: 's',
      timeoutMs: 1500,
      ...over.keycloak,
    },
    rateLimit: {
      registration: { capacity: 5, refillPerSecond: 30 / 3600 },
      ...over.rateLimit,
    },
    idempotency: { ttlSeconds: 3600, ...over.idempotency },
    media: { publicBaseUrl: 'http://media.test/api/v1/media', ...over.media },
    kafka: {
      brokers: ['127.0.0.1:1'],
      clientId: 'account-service-test',
      sendTimeoutMs: 2000,
      schemaRegistryUrl: 'http://127.0.0.1:1',
      ...over.kafka,
    },
    // Background workers are OFF in tests unless a test turns them on.
    outbox: {
      relayEnabled: false,
      pollIntervalMs: 50,
      batchSize: 50,
      maxBackoffMs: 1000,
      retentionHours: 24,
      ...over.outbox,
    },
    openapi: { enabled: false, ...over.openapi },
    // Off by default so tests that edit the database directly never meet a stale cache; cache tests turn it on.
    cache: {
      enabled: false,
      profileTtlSeconds: 300,
      negativeTtlSeconds: 30,
      cooldownMs: 5000,
      ...over.cache,
    },
    grpc: {
      enabled: false,
      streamPageSize: 500,
      tls: {
        mode: 'off',
        certFile: '',
        keyFile: '',
        caFile: '',
        allowedClients: [],
      },
      ...over.grpc,
    },
    jobs: {
      enabled: false,
      intervalMinutes: 60,
      userPurgeAfterDays: 30,
      ...over.jobs,
    },
  };
}
