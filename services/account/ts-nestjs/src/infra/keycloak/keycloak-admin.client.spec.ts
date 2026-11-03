import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/support/config.js';
import {
  ConflictException,
  UpstreamUnavailableException,
  ValidationException,
} from '../../domain/exceptions/app.exception.js';
import { KeycloakAdminClient } from './keycloak-admin.client.js';

const REALM = 'wallpaperhub';
const ADMIN = `/admin/realms/${REALM}`;

/** A minimal Keycloak: token endpoint + the few admin endpoints the adapter uses. */
describe('KeycloakAdminClient', () => {
  let kc: FastifyInstance;
  let baseUrl: string;
  let tokenRequests = 0;
  let currentToken = 'tok-0';
  let users = new Map<string, unknown>();
  let lastCreateBody: Record<string, unknown> | undefined;
  let tokenStatus = 200;

  const client = (over: { baseUrl?: string; clientSecret?: string } = {}) =>
    new KeycloakAdminClient(
      testConfig({
        keycloak: {
          baseUrl: over.baseUrl ?? baseUrl,
          realm: REALM,
          clientSecret: over.clientSecret ?? 'good',
        },
      }),
      pino({ level: 'silent' }),
    );

  const person = (
    username: string,
    email = `${username}@example.com`,
    password = 'Passw0rd!',
  ) => ({
    username,
    email,
    password,
    displayName: 'Some One',
    locale: 'de',
  });

  beforeAll(async () => {
    kc = Fastify();
    kc.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) =>
        done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    kc.post(
      `/realms/${REALM}/protocol/openid-connect/token`,
      async (req, reply) => {
        tokenRequests++;
        const b = req.body as Record<string, string>;
        if (
          tokenStatus !== 200 ||
          b.client_secret !== 'good' ||
          b.grant_type !== 'client_credentials'
        ) {
          return reply
            .status(tokenStatus === 200 ? 401 : tokenStatus)
            .send({ error: 'unauthorized_client' });
        }
        currentToken = `tok-${tokenRequests}`;
        return { access_token: currentToken, expires_in: 300 };
      },
    );
    kc.addHook('preHandler', async (req, reply) => {
      if (
        req.url.startsWith(ADMIN) &&
        req.headers.authorization !== `Bearer ${currentToken}`
      ) {
        return reply.status(401).send({ error: 'HTTP 401 Unauthorized' });
      }
    });
    kc.post(`${ADMIN}/users`, async (req, reply) => {
      const b = req.body as {
        username: string;
        email: string;
        credentials: { value: string }[];
      };
      lastCreateBody = b as Record<string, unknown>;
      if (b.username === 'taken')
        return reply
          .status(409)
          .send({ errorMessage: 'User exists with same username' });
      if (b.email === 'taken@example.com')
        return reply
          .status(409)
          .send({ errorMessage: 'User exists with same email' });
      if (b.credentials[0]?.value === 'x')
        return reply.status(400).send({ errorMessage: 'Invalid password' });
      if (b.username === 'boom') return reply.status(500).send({});
      const id = crypto.randomUUID();
      users.set(id, b);
      return reply
        .status(201)
        .header('location', `${baseUrl}${ADMIN}/users/${id}`)
        .send();
    });
    kc.get(`${ADMIN}/roles/:name`, async (req, reply) =>
      (req.params as { name: string }).name === 'USER'
        ? { id: 'role-id', name: 'USER' }
        : reply.status(404).send({}),
    );
    kc.post(`${ADMIN}/users/:id/role-mappings/realm`, async (_req, reply) =>
      reply.status(204).send(),
    );
    kc.delete(`${ADMIN}/users/:id`, async (req, reply) =>
      users.delete((req.params as { id: string }).id)
        ? reply.status(204).send()
        : reply.status(404).send({}),
    );
    baseUrl = await kc.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(() => kc.close());

  beforeEach(() => {
    tokenRequests = 0;
    currentToken = 'tok-0';
    tokenStatus = 200;
    users = new Map();
    lastCreateBody = undefined;
  });

  it('creates a user with a non-temporary password and both names', async () => {
    const { id } = await client().createUser(person('alice'));
    expect(id).toMatch(/^[\da-f-]{36}$/);
    expect(lastCreateBody).toMatchObject({
      username: 'alice',
      email: 'alice@example.com',
      enabled: true,
      firstName: 'Some One',
      lastName: '-',
      credentials: [{ type: 'password', value: 'Passw0rd!', temporary: false }],
    });
  });

  it('caches the service token across calls', async () => {
    const c = client();
    await c.createUser(person('a1'));
    await c.createUser(person('a2'));
    await c.createUser(person('a3'));
    expect(tokenRequests).toBe(1);
  });

  it('shares ONE token request between concurrent callers (single flight)', async () => {
    const c = client();
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => c.createUser(person(`p${n}`))),
    );
    expect(tokenRequests).toBe(1);
  });

  it('fetches a new token and retries once when Keycloak rejects the cached one', async () => {
    const c = client();
    await c.createUser(person('first'));
    currentToken = 'rotated-by-keycloak'; // cached token is now invalid
    await expect(c.createUser(person('second'))).resolves.toHaveProperty('id');
    expect(tokenRequests).toBe(2);
  });

  it('maps 409 to a field-level conflict (username or email)', async () => {
    const c = client();
    await expect(c.createUser(person('taken'))).rejects.toMatchObject({
      constructor: ConflictException,
      errors: [{ field: 'username', code: 'Taken' }],
    });
    await expect(
      c.createUser(person('someone', 'taken@example.com')),
    ).rejects.toMatchObject({
      errors: [{ field: 'email', code: 'Taken' }],
    });
  });

  it('maps 400 to a validation error', async () => {
    await expect(
      client().createUser(person('weak', 'weak@example.com', 'x')),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it.each([
    ['a 500 from Keycloak', () => client(), () => person('boom')],
    [
      'an unreachable server',
      () => client({ baseUrl: 'http://127.0.0.1:1' }),
      () => person('x1'),
    ],
    [
      'a wrong client secret',
      () => client({ clientSecret: 'bad' }),
      () => person('x2'),
    ],
  ])('answers 503 for %s', async (_name, make, input) => {
    await expect(make().createUser(input())).rejects.toBeInstanceOf(
      UpstreamUnavailableException,
    );
  });

  it('assigns a realm role, and fails clearly for an unknown role', async () => {
    const c = client();
    await expect(
      c.assignRealmRole(crypto.randomUUID(), 'USER'),
    ).resolves.toBeUndefined();
    await expect(
      c.assignRealmRole(crypto.randomUUID(), 'NOPE'),
    ).rejects.toBeInstanceOf(UpstreamUnavailableException);
  });

  it('deletes idempotently (a missing account counts as deleted)', async () => {
    const c = client();
    const { id } = await c.createUser(person('gone'));
    await expect(c.deleteUser(id)).resolves.toBeUndefined();
    await expect(c.deleteUser(id)).resolves.toBeUndefined();
  });
});
