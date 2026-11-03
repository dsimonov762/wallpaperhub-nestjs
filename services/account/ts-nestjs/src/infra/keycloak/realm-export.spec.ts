import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const realmFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'infra',
  'keycloak',
  'realm-export.json',
);

describe('infra/keycloak/realm-export.json', () => {
  const realm = JSON.parse(readFileSync(realmFile, 'utf8')) as {
    users: {
      serviceAccountClientId?: string;
      clientRoles?: Record<string, string[]>;
    }[];
    roles: { realm: { name: string }[] };
  };

  it('lets account-svc do everything KeycloakAdminClient does', () => {
    const account = realm.users.find(
      (u) => u.serviceAccountClientId === 'account-svc',
    );
    // create/delete users + role mapping, and READ the USER realm role (that is `view-realm`: HTTP 403 without it)
    expect(account?.clientRoles?.['realm-management']).toEqual(
      expect.arrayContaining([
        'manage-users',
        'view-users',
        'query-users',
        'view-realm',
      ]),
    );
  });

  it('defines the realm roles the service assigns and checks', () => {
    expect(realm.roles.realm.map((r) => r.name)).toEqual(
      expect.arrayContaining(['USER', 'MODERATOR', 'ADMIN', 'internal']),
    );
  });
});
