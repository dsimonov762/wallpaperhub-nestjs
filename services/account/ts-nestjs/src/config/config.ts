import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Layered configuration (README section 12):
 *   defaults -> profile (local | test | prod) -> environment variables -> secrets from files
 *
 * Everything is a flat KEY=value string (like real environment variables), then
 * validated and turned into one typed, nested object. Invalid config = the process
 * refuses to start ("fail fast").
 */

const DEFAULTS: Record<string, string> = {
  APP_PROFILE: 'local',
  HOST: '0.0.0.0',
  HTTP_PORT: '8080',
  GRPC_PORT: '9090',
  MGMT_PORT: '8081',
  HTTP_BODY_LIMIT_BYTES: '1048576',
  HTTP_TRUST_PROXY: 'false',
  LOG_LEVEL: 'info',
  LOG_PRETTY: 'false',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'account',
  DB_USER: 'account',
  DB_PASSWORD: '',
  DB_POOL_MAX: '10',
  DB_MIGRATE_ON_STARTUP: 'false',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_ISSUER: '',
  AUTH_JWKS_URL: '',
  AUTH_AUDIENCE: 'account-svc',
  AUTH_CLOCK_TOLERANCE_SECONDS: '5',
  AUTH_JWKS_TIMEOUT_MS: '3000',
  AUTH_JWKS_COOLDOWN_MS: '30000',
  // Keycloak admin access. URL and realm are derived from AUTH_ISSUER when left empty.
  KEYCLOAK_URL: '',
  KEYCLOAK_REALM: '',
  KEYCLOAK_CLIENT_ID: 'account-svc',
  KEYCLOAK_CLIENT_SECRET: '',
  KEYCLOAK_TIMEOUT_MS: '3000',
  RATE_LIMIT_REGISTRATION_BURST: '5',
  RATE_LIMIT_REGISTRATION_PER_HOUR: '30',
  IDEMPOTENCY_TTL_SECONDS: '86400',
  MEDIA_PUBLIC_BASE_URL: 'http://localhost:8080/api/v1/media',
  KAFKA_BROKERS: '',
  KAFKA_CLIENT_ID: 'account-service',
  KAFKA_SEND_TIMEOUT_MS: '10000',
  SCHEMA_REGISTRY_URL: '',
  OUTBOX_RELAY_ENABLED: 'true',
  OUTBOX_POLL_INTERVAL_MS: '500',
  OUTBOX_BATCH_SIZE: '100',
  OUTBOX_MAX_BACKOFF_MS: '30000',
  OUTBOX_RETENTION_HOURS: '168',
  OPENAPI_ENABLED: 'false',
  CACHE_ENABLED: 'true',
  CACHE_PROFILE_TTL_SECONDS: '300',
  CACHE_NEGATIVE_TTL_SECONDS: '30',
  CACHE_COOLDOWN_MS: '5000',
  GRPC_ENABLED: 'true',
  GRPC_STREAM_PAGE_SIZE: '500',
  JOBS_ENABLED: 'true',
  JOBS_INTERVAL_MINUTES: '60',
  USER_PURGE_AFTER_DAYS: '30',
};

const PROFILES: Record<string, Record<string, string>> = {
  local: {
    LOG_PRETTY: 'true',
    LOG_LEVEL: 'debug',
    DB_PORT: '5433',
    DB_PASSWORD: 'account',
    AUTH_ISSUER: 'http://localhost:8180/realms/wallpaperhub',
    KEYCLOAK_CLIENT_SECRET: 'dev-secret-account-svc',
    OPENAPI_ENABLED: 'true',
    KAFKA_BROKERS: 'localhost:9094',
    SCHEMA_REGISTRY_URL: 'http://localhost:8085',
  },
  test: {
    LOG_LEVEL: 'warn',
    AUTH_ISSUER: 'http://localhost:8180/realms/wallpaperhub',
    KEYCLOAK_CLIENT_SECRET: 'test-secret',
    KAFKA_BROKERS: 'localhost:9094',
    SCHEMA_REGISTRY_URL: 'http://localhost:8085',
  },
  prod: {},
};

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

const schema = z.object({
  APP_PROFILE: z.enum(['local', 'test', 'prod']),
  HOST: z.string().min(1),
  HTTP_PORT: port,
  GRPC_PORT: port,
  MGMT_PORT: port,
  HTTP_BODY_LIMIT_BYTES: positiveInt,
  HTTP_TRUST_PROXY: z.stringbool(),
  LOG_LEVEL: z.enum([
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
    'silent',
  ]),
  LOG_PRETTY: z.stringbool(),
  DB_HOST: z.string().min(1),
  DB_PORT: port,
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200),
  DB_MIGRATE_ON_STARTUP: z.stringbool(),
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, 'must start with redis:// or rediss://'),
  AUTH_ISSUER: z.url(),
  AUTH_JWKS_URL: z.union([z.literal(''), z.url()]),
  AUTH_AUDIENCE: z.string().min(1),
  AUTH_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60),
  AUTH_JWKS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000),
  AUTH_JWKS_COOLDOWN_MS: z.coerce.number().int().min(0).max(3600000),
  KEYCLOAK_URL: z.union([z.literal(''), z.url()]),
  KEYCLOAK_REALM: z.string(),
  KEYCLOAK_CLIENT_ID: z.string().min(1),
  KEYCLOAK_CLIENT_SECRET: z
    .string()
    .min(1, 'is required (set it, or KEYCLOAK_CLIENT_SECRET_FILE)'),
  KEYCLOAK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000),
  RATE_LIMIT_REGISTRATION_BURST: positiveInt,
  RATE_LIMIT_REGISTRATION_PER_HOUR: positiveInt,
  IDEMPOTENCY_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(7 * 86400),
  MEDIA_PUBLIC_BASE_URL: z.url(),
  // Comma-separated host:port list, e.g. "kafka-1:9092,kafka-2:9092".
  KAFKA_BROKERS: z
    .string()
    .regex(
      /^[^\s:,]+:\d+(,[^\s:,]+:\d+)*$/,
      'expected host:port[,host:port...]',
    ),
  KAFKA_CLIENT_ID: z.string().min(1),
  KAFKA_SEND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000),
  SCHEMA_REGISTRY_URL: z.url(),
  OUTBOX_RELAY_ENABLED: z.stringbool(),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000),
  OUTBOX_MAX_BACKOFF_MS: z.coerce.number().int().min(1000).max(600000),
  OUTBOX_RETENTION_HOURS: z.coerce.number().int().min(1).max(8760),
  OPENAPI_ENABLED: z.stringbool(),
  CACHE_ENABLED: z.stringbool(),
  CACHE_PROFILE_TTL_SECONDS: z.coerce.number().int().min(1).max(86400),
  CACHE_NEGATIVE_TTL_SECONDS: z.coerce.number().int().min(1).max(3600),
  CACHE_COOLDOWN_MS: z.coerce.number().int().min(0).max(300000),
  GRPC_ENABLED: z.stringbool(),
  GRPC_STREAM_PAGE_SIZE: z.coerce.number().int().min(1).max(5000),
  JOBS_ENABLED: z.stringbool(),
  JOBS_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440),
  USER_PURGE_AFTER_DAYS: z.coerce.number().int().min(1).max(3650),
});

export interface RateLimitPolicy {
  /** Bucket size: how many requests may arrive back to back. */
  capacity: number;
  /** Tokens added per second (a fraction for slow refills). */
  refillPerSecond: number;
}

export interface AppConfig {
  profile: 'local' | 'test' | 'prod';
  http: {
    host: string;
    port: number;
    grpcPort: number;
    mgmtPort: number;
    bodyLimitBytes: number;
    trustProxy: boolean;
  };
  log: { level: string; pretty: boolean };
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    poolMax: number;
    migrateOnStartup: boolean;
  };
  redis: { url: string };
  auth: {
    /** Expected `iss` claim. Must match what Keycloak puts in tokens (the URL clients used to reach it). */
    issuer: string;
    /** Where to fetch signing keys. Differs from the issuer when running inside Docker networks. */
    jwksUrl: string;
    audience: string;
    clockToleranceSeconds: number;
    jwksTimeoutMs: number;
    jwksCooldownMs: number;
  };
  keycloak: {
    /** Server base URL, e.g. http://keycloak:8080 (no realm path). */
    baseUrl: string;
    realm: string;
    clientId: string;
    clientSecret: string;
    timeoutMs: number;
  };
  rateLimit: { registration: RateLimitPolicy };
  idempotency: { ttlSeconds: number };
  media: { publicBaseUrl: string };
  kafka: {
    brokers: string[];
    clientId: string;
    sendTimeoutMs: number;
    schemaRegistryUrl: string;
  };
  outbox: {
    /** Turn the relay off on instances that should not publish (e.g. a one-off admin task). */
    relayEnabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    maxBackoffMs: number;
    /** Published rows older than this are deleted by the cleanup job. */
    retentionHours: number;
  };
  openapi: {
    /** Serves Swagger UI and the generated OpenAPI document. On in the local profile only by default. */
    enabled: boolean;
  };
  cache: {
    enabled: boolean;
    /** How long a profile may be served from Redis (each entry gets +/-20% jitter). A safety net: writes invalidate. */
    profileTtlSeconds: number;
    /** How long "this user does not exist" is remembered. */
    negativeTtlSeconds: number;
    /** After a Redis error the cache is bypassed for this long, so a dead Redis costs nothing per request. */
    cooldownMs: number;
  };
  grpc: {
    enabled: boolean;
    /** Rows read from the database per round trip while streaming. */
    streamPageSize: number;
  };
  jobs: {
    enabled: boolean;
    intervalMinutes: number;
    /** Soft-deleted users are erased for good after this many days. */
    userPurgeAfterDays: number;
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Reads `<KEY>_FILE` (Docker/Kubernetes secrets style) and returns the file content. */
function readSecretFiles(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULTS)) {
    const path = env[`${key}_FILE`];
    if (path) {
      try {
        out[key] = readFileSync(path, 'utf8').trim();
      } catch {
        throw new ConfigError([
          `${key}_FILE points to an unreadable file: ${path}`,
        ]);
      }
    }
  }
  return out;
}

/** `http://host:8180/realms/wallpaperhub` -> { baseUrl: 'http://host:8180', realm: 'wallpaperhub' } */
function splitIssuer(
  issuer: string,
): { baseUrl: string; realm: string } | undefined {
  const m = /^(.*)\/realms\/([^/]+)$/.exec(issuer);
  return m ? { baseUrl: m[1]!, realm: m[2]! } : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const profileName = env.APP_PROFILE ?? DEFAULTS.APP_PROFILE!;
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new ConfigError([
      `APP_PROFILE must be one of ${Object.keys(PROFILES).join(', ')}, got "${profileName}"`,
    ]);
  }

  const fromEnv: Record<string, string> = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = env[key];
    if (value !== undefined && value !== '') fromEnv[key] = value;
  }

  const merged = {
    ...DEFAULTS,
    ...profile,
    ...fromEnv,
    ...readSecretFiles(env),
  };
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const c = parsed.data;
  const issuer = c.AUTH_ISSUER.replace(/\/+$/, '');
  const fromIssuer = splitIssuer(issuer);
  const keycloakBase = (c.KEYCLOAK_URL || fromIssuer?.baseUrl || '').replace(
    /\/+$/,
    '',
  );
  const keycloakRealm = c.KEYCLOAK_REALM || fromIssuer?.realm || '';
  if (!keycloakBase || !keycloakRealm) {
    throw new ConfigError([
      'KEYCLOAK_URL / KEYCLOAK_REALM: cannot be derived from AUTH_ISSUER (expected .../realms/<name>); set them explicitly',
    ]);
  }

  return {
    profile: c.APP_PROFILE,
    http: {
      host: c.HOST,
      port: c.HTTP_PORT,
      grpcPort: c.GRPC_PORT,
      mgmtPort: c.MGMT_PORT,
      bodyLimitBytes: c.HTTP_BODY_LIMIT_BYTES,
      trustProxy: c.HTTP_TRUST_PROXY,
    },
    log: { level: c.LOG_LEVEL, pretty: c.LOG_PRETTY },
    db: {
      host: c.DB_HOST,
      port: c.DB_PORT,
      name: c.DB_NAME,
      user: c.DB_USER,
      password: c.DB_PASSWORD,
      poolMax: c.DB_POOL_MAX,
      migrateOnStartup: c.DB_MIGRATE_ON_STARTUP,
    },
    redis: { url: c.REDIS_URL },
    auth: {
      issuer,
      jwksUrl: c.AUTH_JWKS_URL || `${issuer}/protocol/openid-connect/certs`,
      audience: c.AUTH_AUDIENCE,
      clockToleranceSeconds: c.AUTH_CLOCK_TOLERANCE_SECONDS,
      jwksTimeoutMs: c.AUTH_JWKS_TIMEOUT_MS,
      jwksCooldownMs: c.AUTH_JWKS_COOLDOWN_MS,
    },
    keycloak: {
      baseUrl: keycloakBase,
      realm: keycloakRealm,
      clientId: c.KEYCLOAK_CLIENT_ID,
      clientSecret: c.KEYCLOAK_CLIENT_SECRET,
      timeoutMs: c.KEYCLOAK_TIMEOUT_MS,
    },
    rateLimit: {
      registration: {
        capacity: c.RATE_LIMIT_REGISTRATION_BURST,
        refillPerSecond: c.RATE_LIMIT_REGISTRATION_PER_HOUR / 3600,
      },
    },
    idempotency: { ttlSeconds: c.IDEMPOTENCY_TTL_SECONDS },
    media: { publicBaseUrl: c.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, '') },
    kafka: {
      brokers: c.KAFKA_BROKERS.split(','),
      clientId: c.KAFKA_CLIENT_ID,
      sendTimeoutMs: c.KAFKA_SEND_TIMEOUT_MS,
      schemaRegistryUrl: c.SCHEMA_REGISTRY_URL.replace(/\/+$/, ''),
    },
    outbox: {
      relayEnabled: c.OUTBOX_RELAY_ENABLED,
      pollIntervalMs: c.OUTBOX_POLL_INTERVAL_MS,
      batchSize: c.OUTBOX_BATCH_SIZE,
      maxBackoffMs: c.OUTBOX_MAX_BACKOFF_MS,
      retentionHours: c.OUTBOX_RETENTION_HOURS,
    },
    openapi: { enabled: c.OPENAPI_ENABLED },
    cache: {
      enabled: c.CACHE_ENABLED,
      profileTtlSeconds: c.CACHE_PROFILE_TTL_SECONDS,
      negativeTtlSeconds: c.CACHE_NEGATIVE_TTL_SECONDS,
      cooldownMs: c.CACHE_COOLDOWN_MS,
    },
    grpc: { enabled: c.GRPC_ENABLED, streamPageSize: c.GRPC_STREAM_PAGE_SIZE },
    jobs: {
      enabled: c.JOBS_ENABLED,
      intervalMinutes: c.JOBS_INTERVAL_MINUTES,
      userPurgeAfterDays: c.USER_PURGE_AFTER_DAYS,
    },
  };
}
