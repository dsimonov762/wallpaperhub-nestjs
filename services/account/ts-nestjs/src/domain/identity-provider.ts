/**
 * Port to the identity system (Keycloak). Domain code depends on this abstract class,
 * never on Keycloak: tests plug in a fake, and the real adapter lives in infra/keycloak.
 *
 * Errors the adapter throws: ConflictException (username/email taken, with field errors),
 * ValidationException (identity system rejected the data), UpstreamUnavailableException (it is down).
 */
export interface NewIdentity {
  username: string;
  email: string;
  password: string;
  displayName: string;
  locale: string;
}

export abstract class IdentityProvider {
  /** Creates a login account and returns its id (the Keycloak `sub`). */
  abstract createUser(input: NewIdentity): Promise<{ id: string }>;
  abstract assignRealmRole(userId: string, role: string): Promise<void>;
  /** Idempotent: deleting an account that does not exist is a success. */
  abstract deleteUser(userId: string): Promise<void>;
}
