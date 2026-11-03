import type { Page } from '../util/pagination.js';

export interface UserResponse {
  id: string;
  username: string;
  /** Only present for the owner, administrators and internal services. */
  email?: string;
  displayName: string;
  bio: string | null;
  locale: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  status: string;
  createdAt: string;
  version: number;
}

export type UserPageResponse = Page<UserResponse>;
