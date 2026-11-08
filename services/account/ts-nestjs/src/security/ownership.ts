import { ForbiddenException } from '../domain/exceptions/app.exception.js';
import { type Permission, hasPermission } from './permissions.js';
import type { Principal } from './principal.js';

/**
 * Authorization layer 3: "is this YOUR resource?".
 * Call it in the service/handler once you know who owns the resource. Passes when the caller is
 * the owner, or holds the override permission (e.g. an admin acting on someone else's account).
 *
 * Tip: when a caller must not even learn that a resource exists, throw NotFoundException instead.
 */
export function assertOwnerOrPermission(
  principal: Principal,
  ownerId: string,
  override: Permission,
): void {
  if (principal.userId === ownerId) return;
  if (hasPermission(principal, override)) return;
  throw new ForbiddenException();
}
