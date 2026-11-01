import { ConflictException } from '../../src/domain/exceptions/app.exception.js';
import {
  IdentityProvider,
  type NewIdentity,
} from '../../src/domain/identity-provider.js';
import { newUuid } from '../../src/util/ids.js';

/** In-memory identity provider with failure hooks, for exercising the registration saga. */
export class FakeIdentityProvider extends IdentityProvider {
  created: (NewIdentity & { id: string })[] = [];
  roles: [string, string][] = [];
  deleted: string[] = [];
  takenUsernames = new Set<string>();

  /** Id handed out by the next createUser (otherwise a random one). */
  nextId?: string;
  failCreate?: Error;
  failRole?: Error;
  failDelete?: Error;
  /** Runs before an account is created (use a latch here to hold a request in flight). */
  beforeCreate?: () => Promise<void>;
  /** Runs after an account was created (use it to simulate a parallel registration winning a race). */
  afterCreate?: (id: string, input: NewIdentity) => Promise<void>;

  reset(): void {
    this.created = [];
    this.roles = [];
    this.deleted = [];
    this.takenUsernames.clear();
    this.failCreate = this.failRole = this.failDelete = undefined;
    this.nextId = undefined;
    this.beforeCreate = this.afterCreate = undefined;
  }

  async createUser(input: NewIdentity): Promise<{ id: string }> {
    if (this.failCreate) throw this.failCreate;
    await this.beforeCreate?.();
    if (this.takenUsernames.has(input.username.toLowerCase())) {
      throw new ConflictException({}, [{ field: 'username', code: 'Taken' }]);
    }
    const id = this.nextId ?? newUuid();
    this.created.push({ ...input, id });
    await this.afterCreate?.(id, input);
    return { id };
  }

  async assignRealmRole(userId: string, role: string): Promise<void> {
    if (this.failRole) throw this.failRole;
    this.roles.push([userId, role]);
  }

  async deleteUser(userId: string): Promise<void> {
    if (this.failDelete) throw this.failDelete;
    this.deleted.push(userId);
  }
}
