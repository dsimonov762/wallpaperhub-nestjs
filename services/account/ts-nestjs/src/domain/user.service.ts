import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxRepository } from '../repository/outbox.repository.js';
import type { User } from '../repository/entities/user.entity.js';
import { ProfileCache } from '../repository/profile-cache.js';
import { UserRepository } from '../repository/user.repository.js';
import { Clock } from '../util/clock.js';
import type { Page, PageQuery, SortOrder } from '../util/pagination.js';
import {
  ConflictException,
  NotFoundException,
} from './exceptions/app.exception.js';
import { IdentityProvider } from './identity-provider.js';
import { userDeleted, userProfileUpdated } from './user-events.js';

export interface ProfilePatch {
  displayName?: string;
  bio?: string;
  locale?: string;
}

@Injectable()
export class UserService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UserRepository,
    private readonly outbox: OutboxRepository,
    private readonly identity: IdentityProvider,
    private readonly clock: Clock,
    private readonly cache: ProfileCache,
  ) {}

  /** Served from Redis when possible (see ProfileCache); the database is the source of truth. */
  async getById(id: string): Promise<User> {
    const user = await this.cache.get(id, () => this.users.findById(id));
    if (!user) throw new NotFoundException('User', id);
    return user;
  }

  /** Live users among `ids`, in the order asked, duplicates collapsed; unknown and deleted ids are left out. */
  async getByIds(ids: string[]): Promise<User[]> {
    const unique = [...new Set(ids)];
    const found = await this.cache.getMany(unique, (missing) =>
      this.users.findByIds(missing),
    );
    return unique.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
  }

  list(
    query: Pick<PageQuery, 'page' | 'size'>,
    sort: SortOrder,
  ): Promise<Page<User>> {
    return this.users.findPage(query, sort);
  }

  /**
   * Optimistic locking (ETag / If-Match): the caller says which version they edited.
   * The row is locked for the duration of the transaction, so two concurrent PATCHes with the same
   * ETag cannot both win: the second sees a newer version and gets 409.
   */
  async updateProfile(
    userId: string,
    expectedVersion: number,
    patch: ProfilePatch,
  ): Promise<User> {
    const { user, changed } = await this.dataSource.transaction(
      async (manager) => {
        const user = await this.users.lockById(manager, userId);
        if (!user) throw new NotFoundException('User', userId);
        if (user.version !== expectedVersion) throw new ConflictException();

        let changed = false;
        const set = <K extends keyof User>(key: K, value: User[K]) => {
          if (user[key] !== value) {
            user[key] = value;
            changed = true;
          }
        };
        if (patch.displayName !== undefined)
          set('displayName', patch.displayName);
        if (patch.bio !== undefined)
          set('bio', patch.bio === '' ? null : patch.bio);
        if (patch.locale !== undefined) set('locale', patch.locale);
        if (!changed) return { user, changed }; // no-op: same version, no event, no audit row

        await manager.save(user);
        await this.outbox.enqueue(
          manager,
          userProfileUpdated(user, this.clock.now()),
        );
        return { user, changed };
      },
    );
    // Only after the commit: a reader can no longer see the old row, so the old cache entry may go.
    if (changed) await this.cache.invalidate(user.id, user.version);
    return user;
  }

  /**
   * Deletes the login account first, then soft-deletes the profile. If the second step fails the call
   * can simply be repeated: deleting an already-deleted Keycloak account succeeds.
   */
  async delete(userId: string): Promise<void> {
    await this.getById(userId);
    await this.identity.deleteUser(userId);
    await this.dataSource.transaction(async (manager) => {
      const user = await this.users.lockById(manager, userId);
      if (!user) return; // deleted concurrently: nothing left to do
      await manager.softRemove(user);
      await this.outbox.enqueue(manager, userDeleted(user, this.clock.now()));
    });
    await this.cache.markDeleted(userId);
  }
}
