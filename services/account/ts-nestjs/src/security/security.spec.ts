import { Controller, Get, Param } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from 'jose';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemFilter } from '../api/http/filters/problem.filter.js';
import { setupHttp } from '../api/http/setup-http.js';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG, ConfigModule } from '../config/config.module.js';
import { testConfig } from '../../test/support/config.js';
import { UpstreamUnavailableException } from '../domain/exceptions/app.exception.js';
import { I18nModule } from '../i18n/i18n.module.js';
import { LOGGER } from '../infra/logger.js';
import { LoggingModule } from '../infra/logging.module.js';
import {
  CurrentPrincipal,
  Public,
  RequirePermissions,
  Roles,
} from './decorators.js';
import { assertOwnerOrPermission } from './ownership.js';
import type { Principal } from './principal.js';
import { SecurityModule } from './security.module.js';
import { TokenVerifier } from './token-verifier.js';

const ISSUER = 'http://keycloak.test/realms/wallpaperhub';
const AUDIENCE = 'account-svc';

@Controller('probe')
class ProbeController {
  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }
  @Get('any')
  any(@CurrentPrincipal() who: Principal) {
    return { id: who.userId };
  }
  @Roles('ADMIN')
  @Get('admin')
  admin() {
    return { ok: true };
  }
  @RequirePermissions('users:delete-any')
  @Get('delete-any')
  deleteAny() {
    return { ok: true };
  }
  @Get('owned/:ownerId')
  owned(@Param('ownerId') ownerId: string, @CurrentPrincipal() who: Principal) {
    assertOwnerOrPermission(who, ownerId, 'users:update-any');
    return { ok: true };
  }
}

interface KeyPair {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

async function makeKey(kid: string, alg = 'RS256'): Promise<KeyPair> {
  const { publicKey, privateKey } = await generateKeyPair(alg, {
    extractable: true,
  });
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' },
  };
}

describe('security', () => {
  let jwksServer: FastifyInstance;
  let jwksUrl: string;
  let fetchCount = 0;
  let publishedKeys: JWK[] = [];
  let k1: KeyPair;
  let k2: KeyPair;
  let app: NestFastifyApplication;
  const logger = pino({ level: 'silent' });

  const config = (over: Partial<AppConfig['auth']> = {}): AppConfig =>
    testConfig({
      auth: {
        issuer: ISSUER,
        jwksUrl,
        audience: AUDIENCE,
        jwksTimeoutMs: 1000,
        jwksCooldownMs: 0,
        ...over,
      },
    });

  interface TokenOptions {
    sub?: string;
    roles?: string[];
    key?: KeyPair;
    iss?: string;
    aud?: string;
    typ?: string;
    exp?: number | string;
    alg?: string;
  }

  async function token(o: TokenOptions = {}): Promise<string> {
    const key = o.key ?? k1;
    return new SignJWT({
      typ: o.typ ?? 'Bearer',
      preferred_username: 'tester',
      azp: 'web-spa',
      realm_access: { roles: o.roles ?? ['USER'] },
    })
      .setProtectedHeader({ alg: o.alg ?? 'RS256', kid: key.kid })
      .setSubject(o.sub ?? 'user-1')
      .setIssuer(o.iss ?? ISSUER)
      .setAudience(o.aud ?? AUDIENCE)
      .setJti('jti-1')
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '5m')
      .sign(key.privateKey);
  }

  const call = (path: string, bearer?: string, scheme = 'Bearer') =>
    app.inject({
      method: 'GET',
      url: `/api/v1${path}`,
      headers: bearer ? { authorization: `${scheme} ${bearer}` } : {},
    });

  beforeAll(async () => {
    k1 = await makeKey('k1');
    k2 = await makeKey('k2');
    publishedKeys = [k1.jwk];
    jwksServer = Fastify();
    jwksServer.get('/certs', async () => {
      fetchCount++;
      return { keys: publishedKeys };
    });
    jwksUrl = `${await jwksServer.listen({ host: '127.0.0.1', port: 0 })}/certs`;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, LoggingModule, I18nModule, SecurityModule],
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config())
      .overrideProvider(LOGGER)
      .useValue(logger)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    setupHttp(app, logger);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await jwksServer.close();
  });

  describe('layer 1: authentication', () => {
    it('rejects a missing token with 401 + WWW-Authenticate', async () => {
      const res = await call('/probe/any');
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json().type).toBe(
        'https://wallpaperhub.dev/problems/unauthorized',
      );
    });

    it('accepts a valid token and exposes the principal', async () => {
      const res = await call('/probe/any', await token({ sub: 'abc' }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: 'abc' });
    });

    it('lets @Public() routes through without (or despite) a token', async () => {
      expect((await call('/probe/public')).statusCode).toBe(200);
      expect((await call('/probe/public', 'garbage')).statusCode).toBe(200);
    });

    it.each([
      ['expired', () => token({ exp: Math.floor(Date.now() / 1000) - 3600 })],
      ['wrong audience', () => token({ aud: 'media-svc' })],
      ['wrong issuer', () => token({ iss: 'http://evil.test/realms/x' })],
      ['refresh/ID token type', () => token({ typ: 'Refresh' })],
      ['unknown key id', async () => token({ key: await makeKey('unknown') })],
      [
        'same key id, different key',
        async () => token({ key: { ...(await makeKey('k1')) } }),
      ],
      ['garbage', async () => 'not.a.jwt'],
    ])(
      'rejects %s with 401 and the same generic problem',
      async (_name, make) => {
        const res = await call('/probe/any', await make());
        expect(res.statusCode).toBe(401);
        expect(res.headers['www-authenticate']).toBe(
          'Bearer error="invalid_token"',
        );
        expect(res.body).not.toMatch(/expired|audience|issuer|signature/i); // no hints for attackers
      },
    );

    it('rejects an unsigned (alg=none) token', async () => {
      const b64 = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
        sub: 'x',
        iss: ISSUER,
        aud: AUDIENCE,
        typ: 'Bearer',
        exp: Math.floor(Date.now() / 1000) + 300,
      })}.`;
      expect((await call('/probe/any', unsigned)).statusCode).toBe(401);
    });

    it('rejects an HS256 token (algorithm confusion attempt)', async () => {
      const forged = await new SignJWT({ typ: 'Bearer' })
        .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
        .setSubject('x')
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(JSON.stringify(k1.jwk)));
      expect((await call('/probe/any', forged)).statusCode).toBe(401);
    });

    it('rejects a wrong scheme and a malformed header', async () => {
      const t = await token();
      expect((await call('/probe/any', t, 'Basic')).statusCode).toBe(401);
      expect((await call('/probe/any', `${t} extra`)).statusCode).toBe(401);
    });
  });

  describe('key handling', () => {
    it('caches the JWKS: many verifications, no extra fetches', async () => {
      await call('/probe/any', await token()); // warm
      const before = fetchCount;
      for (let i = 0; i < 5; i++)
        expect((await call('/probe/any', await token())).statusCode).toBe(200);
      expect(fetchCount).toBe(before);
    });

    it('picks up a rotated key when a token names an unknown key id', async () => {
      expect(
        (await call('/probe/any', await token({ key: k2 }))).statusCode,
      ).toBe(401); // not published yet
      publishedKeys = [k1.jwk, k2.jwk]; // Keycloak rotates
      expect(
        (await call('/probe/any', await token({ key: k2 }))).statusCode,
      ).toBe(200);
      publishedKeys = [k1.jwk];
    });

    it('answers 503 (not 401) when the key server is unreachable', async () => {
      const dead = new TokenVerifier(
        config({ jwksUrl: 'http://127.0.0.1:1/certs', jwksTimeoutMs: 500 }),
        logger,
      );
      await expect(dead.verify(await token())).rejects.toBeInstanceOf(
        UpstreamUnavailableException,
      );
    });
  });

  describe('layer 2: roles and permissions', () => {
    it('@Roles: USER is forbidden, ADMIN passes', async () => {
      expect(
        (await call('/probe/admin', await token({ roles: ['USER'] })))
          .statusCode,
      ).toBe(403);
      expect(
        (await call('/probe/admin', await token({ roles: ['USER', 'ADMIN'] })))
          .statusCode,
      ).toBe(200);
    });

    it('@RequirePermissions: derived from roles', async () => {
      expect(
        (
          await call(
            '/probe/delete-any',
            await token({ roles: ['USER', 'MODERATOR'] }),
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            '/probe/delete-any',
            await token({ roles: ['USER', 'ADMIN'] }),
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await call('/probe/delete-any', await token({ roles: ['internal'] })))
          .statusCode,
      ).toBe(403);
    });

    it('unknown roles grant nothing', async () => {
      expect(
        (await call('/probe/delete-any', await token({ roles: ['SUPERUSER'] })))
          .statusCode,
      ).toBe(403);
    });
  });

  describe('layer 3: ownership', () => {
    it('owner passes, stranger is forbidden, admin override passes', async () => {
      expect(
        (await call('/probe/owned/user-1', await token({ sub: 'user-1' })))
          .statusCode,
      ).toBe(200);
      expect(
        (await call('/probe/owned/user-1', await token({ sub: 'user-2' })))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            '/probe/owned/user-1',
            await token({ sub: 'admin-1', roles: ['ADMIN'] }),
          )
        ).statusCode,
      ).toBe(200);
    });
  });

  describe('whoami', () => {
    it('reports identity, roles, permissions and service flag', async () => {
      const res = await call(
        '/whoami',
        await token({ sub: 'svc', roles: ['internal'] }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: 'svc',
        service: true,
        roles: ['internal'],
        permissions: ['users:read-any', 'users:read-email'],
        clientId: 'web-spa',
      });
    });

    it('requires a token', async () => {
      expect((await call('/whoami')).statusCode).toBe(401);
    });
  });
});
