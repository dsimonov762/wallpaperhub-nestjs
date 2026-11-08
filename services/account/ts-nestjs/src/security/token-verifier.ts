import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify } from 'jose';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../config/config.module.js';
import {
  UnauthorizedException,
  UpstreamUnavailableException,
} from '../domain/exceptions/app.exception.js';
import { LOGGER } from '../infra/logger.js';
import type { Principal } from './principal.js';

/** Only asymmetric algorithms. Never HS* (an attacker could sign with the public key) and never `none`. */
const ALLOWED_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'ES256',
  'ES384',
];

/** jose error codes that mean "this token is bad" (401), as opposed to "we could not check it" (503). */
const BAD_TOKEN_CODES = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
]);

/**
 * Verifies Keycloak access tokens locally: no network call per request.
 * The signing keys (JWKS) are fetched once, cached in memory, and re-fetched only when a token
 * names a key id we do not know (key rotation), at most once per `jwksCooldownMs`.
 */
@Injectable()
export class TokenVerifier {
  private readonly jwks;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.jwks = createRemoteJWKSet(new URL(config.auth.jwksUrl), {
      timeoutDuration: config.auth.jwksTimeoutMs,
      cooldownDuration: config.auth.jwksCooldownMs,
    });
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.auth.issuer,
        audience: this.config.auth.audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: this.config.auth.clockToleranceSeconds,
        requiredClaims: ['exp', 'sub', 'iss'],
      }));
    } catch (e) {
      const code = e instanceof errors.JOSEError ? e.code : undefined;
      if (code && BAD_TOKEN_CODES.has(code))
        throw new UnauthorizedException(code);
      // Keys could not be fetched (Keycloak down, timeout, DNS...). That is OUR dependency failing, not a bad token.
      this.logger.warn({ err: e }, 'token verification unavailable');
      throw new UpstreamUnavailableException();
    }

    // Keycloak marks access tokens `typ: Bearer`; refresh and ID tokens carry other types and must not work here.
    if (payload.typ !== 'Bearer')
      throw new UnauthorizedException('wrong_token_type');

    const realmRoles = (payload.realm_access as { roles?: unknown } | undefined)
      ?.roles;
    const roles = Array.isArray(realmRoles)
      ? realmRoles.filter((r): r is string => typeof r === 'string')
      : [];
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' ? v : undefined;

    return {
      userId: payload.sub!,
      username: str(payload.preferred_username) ?? payload.sub!,
      email: str(payload.email),
      roles,
      clientId: str(payload.azp),
      isService: roles.includes('internal'),
      tokenId: payload.jti,
      expiresAt: new Date(payload.exp! * 1000),
    };
  }
}
