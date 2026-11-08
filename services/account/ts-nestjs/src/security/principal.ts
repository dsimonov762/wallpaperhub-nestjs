/** Who is calling: built from a verified access token. Never built from anything unverified. */
export interface Principal {
  /** Keycloak `sub`. For users this is also users.id in our database. */
  userId: string;
  username: string;
  email?: string;
  roles: string[];
  /** `azp`: the OAuth client the token was issued to (web-spa, catalog-svc, ...). */
  clientId?: string;
  /** True for service-account tokens (they carry the `internal` realm role). */
  isService: boolean;
  tokenId?: string;
  expiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by AuthGuard on authenticated routes. */
    principal?: Principal;
  }
}
