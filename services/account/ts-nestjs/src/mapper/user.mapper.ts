import type { UserResponse } from '../dto/user-response.dto.js';
import type { Principal } from '../security/principal.js';

type Viewer = Pick<Principal, 'userId' | 'roles'>;
import { hasPermission } from '../security/permissions.js';
import type { User } from '../repository/entities/user.entity.js';

export interface MappingContext {
  viewer: Viewer;
  mediaBaseUrl: string;
}

/** Email is personal data: only the owner and holders of `users:read-email` see it. */
export const canSeeEmail = (viewer: Viewer, user: Pick<User, 'id'>): boolean =>
  viewer.userId === user.id || hasPermission(viewer, 'users:read-email');

export function toUserResponse(user: User, ctx: MappingContext): UserResponse {
  const asset = (id: string | null) =>
    id ? `${ctx.mediaBaseUrl}/${encodeURIComponent(id)}` : null;
  return {
    id: user.id,
    username: user.username,
    ...(canSeeEmail(ctx.viewer, user) ? { email: user.email } : {}),
    displayName: user.displayName,
    bio: user.bio,
    locale: user.locale,
    avatarUrl: asset(user.avatarAssetId),
    bannerUrl: asset(user.bannerAssetId),
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    version: user.version,
  };
}
