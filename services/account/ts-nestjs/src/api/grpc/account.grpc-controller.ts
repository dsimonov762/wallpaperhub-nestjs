import type { Metadata } from '@grpc/grpc-js';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { defer, from, map, type Observable } from 'rxjs';
import type { AppConfig } from '../../config/config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import {
  UnauthorizedException,
  ValidationException,
} from '../../domain/exceptions/app.exception.js';
import { UserService } from '../../domain/user.service.js';
import { type ProtoUser, toProtoUser } from '../../mapper/proto-user.mapper.js';
import { UserRepository } from '../../repository/user.repository.js';
import { Roles } from '../../security/decorators.js';
import { hasPermission } from '../../security/permissions.js';
import { callPrincipal } from '../../security/principal-store.js';
import { isUuid } from '../../util/ids.js';
import { fromTimestamp, type ProtoTimestamp } from './grpc-timestamp.js';

export const MAX_BATCH_IDS = 100;

/**
 * `AccountService` of contracts/proto/account/v1/account.proto: the internal API other services call.
 * Authentication, the `internal` role requirement and error translation are NOT written here: the global
 * AuthGuard, the problem filter and GrpcCallInterceptor handle every gRPC call the same way they handle HTTP.
 */
@Controller()
@Roles('internal')
export class AccountGrpcController {
  constructor(
    private readonly users: UserService,
    private readonly repository: UserRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private view(
    user: Parameters<typeof toProtoUser>[0],
    metadata: Metadata,
  ): ProtoUser {
    const caller = callPrincipal(metadata);
    if (!caller) throw new UnauthorizedException(); // cannot happen: the guard rejects first
    return toProtoUser(user, {
      includeEmail: hasPermission(caller, 'users:read-email'),
      mediaBaseUrl: this.config.media.publicBaseUrl,
    });
  }

  @GrpcMethod('AccountService', 'GetUser')
  async getUser(
    request: { id: string },
    metadata: Metadata,
  ): Promise<ProtoUser> {
    if (!isUuid(request.id))
      throw new ValidationException([{ field: 'id', code: 'Pattern' }]);
    return this.view(await this.users.getById(request.id), metadata); // NotFoundException -> NOT_FOUND
  }

  @GrpcMethod('AccountService', 'GetUsersByIds')
  async getUsersByIds(
    request: { ids: string[] },
    metadata: Metadata,
  ): Promise<{ users: ProtoUser[] }> {
    const ids = [...new Set(request.ids ?? [])];
    if (ids.length > MAX_BATCH_IDS)
      throw new ValidationException([{ field: 'ids', code: 'Size' }]);
    if (!ids.every(isUuid))
      throw new ValidationException([{ field: 'ids', code: 'Pattern' }]);

    // Same order as asked, so callers (DataLoader) can zip results without re-sorting.
    const users = await this.users.getByIds(ids);
    return { users: users.map((u) => this.view(u, metadata)) };
  }

  @GrpcMethod('AccountService', 'ListUsersUpdatedSince')
  listUsersUpdatedSince(
    request: { since?: ProtoTimestamp },
    metadata: Metadata,
  ): Observable<ProtoUser> {
    const since = fromTimestamp(request.since);
    // `defer` starts reading only when the call is actually consumed; the pages are fetched lazily.
    return defer(() =>
      from(
        this.repository.streamUpdatedSince(
          since,
          this.config.grpc.streamPageSize,
        ),
      ),
    ).pipe(map((user) => this.view(user, metadata)));
  }
}
