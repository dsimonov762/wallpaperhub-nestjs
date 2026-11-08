import {
  type ProtoTimestamp,
  toTimestamp,
} from '../api/grpc/grpc-timestamp.js';
import type { User } from '../repository/entities/user.entity.js';

/** `wallpaperhub.account.v1.User` as a plain object (proto-loader maps snake_case to camelCase). */
export interface ProtoUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  locale: string;
  avatarUrl: string;
  updatedAt: ProtoTimestamp;
  deleted: boolean;
}

export interface ProtoMappingContext {
  includeEmail: boolean;
  mediaBaseUrl: string;
}

export function toProtoUser(user: User, ctx: ProtoMappingContext): ProtoUser {
  // A deleted user is announced, but no personal data about them leaves this service any more.
  if (user.deletedAt) {
    return {
      id: user.id,
      username: '',
      displayName: '',
      email: '',
      locale: '',
      avatarUrl: '',
      updatedAt: toTimestamp(user.updatedAt),
      deleted: true,
    };
  }
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: ctx.includeEmail ? user.email : '',
    locale: user.locale,
    avatarUrl: user.avatarAssetId
      ? `${ctx.mediaBaseUrl}/${encodeURIComponent(user.avatarAssetId)}`
      : '',
    updatedAt: toTimestamp(user.updatedAt),
    deleted: false,
  };
}
