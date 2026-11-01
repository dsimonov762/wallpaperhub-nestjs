import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Logger } from 'pino';
import { DataSource, QueryFailedError } from 'typeorm';
import { LOGGER } from '../infra/logger.js';
import { OutboxRepository } from '../repository/outbox.repository.js';
import { User } from '../repository/entities/user.entity.js';
import { ProfileCache } from '../repository/profile-cache.js';
import { UserRepository } from '../repository/user.repository.js';
import { Clock } from '../util/clock.js';
import { ConflictException } from './exceptions/app.exception.js';
import { IdentityProvider } from './identity-provider.js';
import { userRegistered } from './user-events.js';

export interface RegisterCommand {
  username: string;
  email: string;
  password: string;
  displayName: string;
  locale: string;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Registration spans TWO systems (Keycloak and our database) that cannot share a transaction.
 * The sequence below is ordered so every failure leaves a recoverable state:
 *
 *   1. cheap duplicate check in our DB          (nothing created yet)
 *   2. create the login account in Keycloak     (can fail: nothing to undo)
 *   3. give it the USER role                    (can fail: undo 2)
 *   4. DB transaction: profile row + outbox event (can fail: undo 2)
 *
 * "Undo 2" = delete the Keycloak account. If even that fails we log loudly with the user id (an orphan).
 */
@Injectable()
export class RegistrationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly identity: IdentityProvider,
    private readonly users: UserRepository,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
    private readonly cache: ProfileCache,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async register(cmd: RegisterCommand): Promise<User> {
    const taken = await this.users.findTaken(cmd.username, cmd.email);
    if (taken.username || taken.email) throw this.taken(taken);

    const { id } = await this.identity.createUser(cmd);

    try {
      await this.identity.assignRealmRole(id, 'USER');
      const created = await this.dataSource.transaction(async (manager) => {
        const user = manager.create(User, {
          id,
          username: cmd.username,
          email: cmd.email,
          displayName: cmd.displayName,
          locale: cmd.locale,
          bio: null,
          avatarAssetId: null,
          bannerAssetId: null,
        });
        await manager.save(user);
        await this.outbox.enqueue(
          manager,
          userRegistered(user, this.clock.now()),
        );
        return user;
      });
      // A "no such user" answer cached earlier for this id must not outlive the registration.
      await this.cache.invalidate(created.id, created.version);
      return created;
    } catch (err) {
      await this.undoIdentity(id);
      if (this.isUniqueViolation(err)) {
        // Lost a race with a parallel registration between step 1 and step 4.
        const constraint =
          (err.driverError as { constraint?: string }).constraint ?? '';
        throw this.taken({
          username: constraint.includes('username'),
          email: constraint.includes('email'),
        });
      }
      throw err;
    }
  }

  private taken(which: {
    username: boolean;
    email: boolean;
  }): ConflictException {
    const errors = [];
    if (which.username) errors.push({ field: 'username', code: 'Taken' });
    if (which.email) errors.push({ field: 'email', code: 'Taken' });
    return new ConflictException({}, errors);
  }

  private isUniqueViolation(err: unknown): err is QueryFailedError {
    return (
      err instanceof QueryFailedError &&
      (err.driverError as { code?: string }).code === UNIQUE_VIOLATION
    );
  }

  private async undoIdentity(userId: string): Promise<void> {
    try {
      await this.identity.deleteUser(userId);
    } catch (err) {
      this.logger.error(
        { err, userId, orphanedIdentity: true },
        'registration rolled back but the Keycloak account could not be deleted: remove it manually',
      );
    }
  }
}
