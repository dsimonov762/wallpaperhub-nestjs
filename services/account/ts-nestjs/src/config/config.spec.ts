import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses defaults + the local profile when nothing is set', () => {
    const c = loadConfig({});
    expect(c.profile).toBe('local');
    expect(c.http).toMatchObject({
      port: 8080,
      grpcPort: 9090,
      mgmtPort: 8081,
    });
    expect(c.log).toEqual({ level: 'debug', pretty: true });
    expect(c.db.password).toBe('account');
  });

  it('lets the prod profile avoid dev conveniences', () => {
    const c = loadConfig({
      APP_PROFILE: 'prod',
      DB_PASSWORD: 'x',
      AUTH_ISSUER: 'https://id.example.com/realms/w/',
      KEYCLOAK_CLIENT_SECRET: 's3cret',
      KAFKA_BROKERS: 'k1:9092,k2:9092',
      SCHEMA_REGISTRY_URL: 'https://registry.example.com/',
    });
    expect(c.log).toEqual({ level: 'info', pretty: false });
    expect(c.auth.issuer).toBe('https://id.example.com/realms/w');
    expect(c.auth.jwksUrl).toBe(
      'https://id.example.com/realms/w/protocol/openid-connect/certs',
    );
  });

  it('prod refuses to start without an issuer (no insecure default)', () => {
    expect(() =>
      loadConfig({ APP_PROFILE: 'prod', DB_PASSWORD: 'x' }),
    ).toThrowError(/AUTH_ISSUER/);
  });

  it('derives the Keycloak admin URL and realm from the issuer, and lets you override them', () => {
    const c = loadConfig({});
    expect(c.keycloak).toMatchObject({
      baseUrl: 'http://localhost:8180',
      realm: 'wallpaperhub',
      clientId: 'account-svc',
    });
    const d = loadConfig({
      KEYCLOAK_URL: 'http://keycloak:8080/',
      KEYCLOAK_REALM: 'other',
    });
    expect(d.keycloak).toMatchObject({
      baseUrl: 'http://keycloak:8080',
      realm: 'other',
    });
  });

  it('prod refuses to start without a Keycloak client secret', () => {
    expect(() =>
      loadConfig({
        APP_PROFILE: 'prod',
        DB_PASSWORD: 'x',
        AUTH_ISSUER: 'https://id.example.com/realms/w',
      }),
    ).toThrowError(/KEYCLOAK_CLIENT_SECRET/);
  });

  it('turns the registration limit into a token bucket', () => {
    const c = loadConfig({
      RATE_LIMIT_REGISTRATION_BURST: '3',
      RATE_LIMIT_REGISTRATION_PER_HOUR: '36',
    });
    expect(c.rateLimit.registration).toEqual({
      capacity: 3,
      refillPerSecond: 0.01,
    });
  });

  it('allows a separate JWKS URL (Docker networks)', () => {
    const c = loadConfig({
      AUTH_JWKS_URL:
        'http://keycloak:8080/realms/wallpaperhub/protocol/openid-connect/certs',
    });
    expect(c.auth.issuer).toBe('http://localhost:8180/realms/wallpaperhub');
    expect(c.auth.jwksUrl).toContain('keycloak:8080');
  });

  it('lets environment variables override the profile', () => {
    const c = loadConfig({
      HTTP_PORT: '9000',
      LOG_LEVEL: 'error',
      DB_MIGRATE_ON_STARTUP: 'true',
    });
    expect(c.http.port).toBe(9000);
    expect(c.log.level).toBe('error');
    expect(c.db.migrateOnStartup).toBe(true);
  });

  it('reads secrets from <KEY>_FILE and trims them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const file = join(dir, 'db-password');
    writeFileSync(file, 'from-file\n');
    expect(
      loadConfig({ DB_PASSWORD: 'ignored', DB_PASSWORD_FILE: file }).db
        .password,
    ).toBe('from-file');
  });

  it('fails fast with every problem listed', () => {
    expect(() =>
      loadConfig({ HTTP_PORT: 'abc', LOG_LEVEL: 'loud', DB_POOL_MAX: '0' }),
    ).toThrowError(ConfigError);
    try {
      loadConfig({ HTTP_PORT: 'abc', LOG_LEVEL: 'loud' });
    } catch (e) {
      const problems = (e as ConfigError).problems.join('\n');
      expect(problems).toContain('HTTP_PORT');
      expect(problems).toContain('LOG_LEVEL');
    }
  });

  it('rejects an unknown profile and an unreadable secret file', () => {
    expect(() => loadConfig({ APP_PROFILE: 'staging' })).toThrowError(
      /APP_PROFILE/,
    );
    expect(() =>
      loadConfig({ DB_PASSWORD_FILE: '/nope/missing' }),
    ).toThrowError(/unreadable/);
  });
});
