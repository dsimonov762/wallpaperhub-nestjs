import type { Principal } from './principal.js';

/**
 * Authorization layer 2: roles grant permissions; endpoints ask for permissions.
 * Roles come from Keycloak (realm roles); this table says what each role may do in THIS service.
 * Extend it as endpoints are added.
 */
export type Permission =
  | 'profile:read-own'
  | 'profile:update-own'
  | 'profile:delete-own'
  | 'users:list'
  | 'users:read-any'
  | 'users:read-email'
  | 'users:update-any'
  | 'users:delete-any';

const USER: Permission[] = [
  'profile:read-own',
  'profile:update-own',
  'profile:delete-own',
];

export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  USER,
  MODERATOR: [...USER, 'users:read-any'],
  ADMIN: [
    ...USER,
    'users:list',
    'users:read-any',
    'users:read-email',
    'users:update-any',
    'users:delete-any',
  ],
  // Other services calling us (catalog needs profiles for authors, notification needs emails).
  internal: ['users:read-any', 'users:read-email'],
};

export function permissionsOf(roles: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles)
    for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  return out;
}

export const hasPermission = (
  principal: Pick<Principal, 'roles'>,
  permission: Permission,
): boolean => permissionsOf(principal.roles).has(permission);
