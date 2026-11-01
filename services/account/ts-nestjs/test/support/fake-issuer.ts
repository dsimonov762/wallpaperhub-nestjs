import Fastify, { type FastifyInstance } from 'fastify';
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from 'jose';

export const TEST_ISSUER = 'http://keycloak.test/realms/wallpaperhub';

/** A tiny stand-in for Keycloak: serves a JWKS and mints signed access tokens. */
export interface FakeIssuer {
  jwksUrl: string;
  token: (sub: string, roles?: string[]) => Promise<string>;
  close: () => Promise<void>;
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'e2e',
    alg: 'RS256',
    use: 'sig',
  };
  const server: FastifyInstance = Fastify();
  server.get('/certs', async () => ({ keys: [jwk] }));
  const jwksUrl = `${await server.listen({ host: '127.0.0.1', port: 0 })}/certs`;
  const key: CryptoKey = privateKey;
  return {
    jwksUrl,
    token: (sub, roles = ['USER']) =>
      new SignJWT({
        typ: 'Bearer',
        preferred_username: `u-${sub.slice(0, 6)}`,
        azp: 'web-spa',
        realm_access: { roles },
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
        .setSubject(sub)
        .setIssuer(TEST_ISSUER)
        .setAudience('account-svc')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(key),
    close: async () => {
      await server.close();
    },
  };
}
