import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import {
  ConflictException,
  UpstreamUnavailableException,
  ValidationException,
} from '../../domain/exceptions/app.exception.js';
import {
  IdentityProvider,
  type NewIdentity,
} from '../../domain/identity-provider.js';
import { LOGGER } from '../logger.js';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/**
 * Keycloak Admin REST API adapter. Authenticates as the `account-svc` service account
 * (client-credentials grant); the access token is cached until shortly before it expires.
 *
 * Never logs request bodies (they contain passwords).
 */
@Injectable()
export class KeycloakAdminClient extends IdentityProvider {
  private token?: { value: string; expiresAtMs: number };
  private inflight?: Promise<string>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    super();
  }

  async createUser(input: NewIdentity): Promise<{ id: string }> {
    const res = await this.admin('POST', '/users', {
      username: input.username,
      email: input.email,
      enabled: true,
      emailVerified: false,
      // Keycloak's default user profile requires BOTH names, otherwise the account is "not fully set up"
      // and password logins are refused. We only keep one display name, so the last name is a placeholder.
      firstName: input.displayName,
      lastName: '-',
      credentials: [
        { type: 'password', value: input.password, temporary: false },
      ],
    });

    if (res.status === 201) {
      const id = res.headers.get('location')?.split('/').pop() ?? '';
      if (!UUID.test(id))
        this.unavailable('create user returned no valid Location header');
      return { id };
    }
    if (res.status === 409) {
      const message =
        ((await res.json().catch(() => ({}))) as { errorMessage?: string })
          .errorMessage ?? '';
      const field = /email/i.test(message) ? 'email' : 'username';
      throw new ConflictException({}, [{ field, code: 'Taken' }]);
    }
    if (res.status === 400)
      throw new ValidationException([{ field: 'password', code: 'Invalid' }]);
    return this.unavailable(`create user failed with HTTP ${res.status}`);
  }

  async assignRealmRole(userId: string, role: string): Promise<void> {
    const roleRes = await this.admin(
      'GET',
      `/roles/${encodeURIComponent(role)}`,
    );
    if (roleRes.status !== 200)
      this.unavailable(
        `role "${role}" lookup failed with HTTP ${roleRes.status}`,
      );
    const rep = (await roleRes.json()) as { id: string; name: string };

    const res = await this.admin(
      'POST',
      `/users/${userId}/role-mappings/realm`,
      [{ id: rep.id, name: rep.name }],
    );
    if (res.status !== 204 && res.status !== 200)
      this.unavailable(`role assignment failed with HTTP ${res.status}`);
  }

  async deleteUser(userId: string): Promise<void> {
    const res = await this.admin('DELETE', `/users/${userId}`);
    if (res.status !== 204 && res.status !== 404)
      this.unavailable(`delete user failed with HTTP ${res.status}`);
  }

  // ---- plumbing ---------------------------------------------------------------------------

  private async admin(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<Response> {
    const { baseUrl, realm } = this.config.keycloak;
    const res = await this.send(`${baseUrl}/admin/realms/${realm}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) {
      this.token = undefined; // expired or revoked early: fetch a fresh one and try once more
      return this.admin(method, path, body, true);
    }
    if (res.status >= 500)
      this.unavailable(
        `Keycloak answered HTTP ${res.status} for ${method} ${path}`,
      );
    return res;
  }

  /** Single-flight: concurrent callers share one token request. */
  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - Date.now() > 30_000)
      return Promise.resolve(this.token.value);
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const { baseUrl, realm, clientId, clientSecret } = this.config.keycloak;
    const res = await this.send(
      `${baseUrl}/realms/${realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
      },
    );
    if (res.status !== 200)
      this.unavailable(
        `token request failed with HTTP ${res.status} (check the client secret)`,
      );
    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = {
      value: json.access_token,
      expiresAtMs: Date.now() + json.expires_in * 1000,
    };
    return json.access_token;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.keycloak.timeoutMs),
      });
    } catch (err) {
      return this.unavailable(
        `Keycloak unreachable: ${(err as Error).message}`,
      );
    }
  }

  private unavailable(reason: string): never {
    this.logger.warn({ reason }, 'identity provider unavailable');
    throw new UpstreamUnavailableException();
  }
}
