import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../../config/config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { ValidationException } from '../../domain/exceptions/app.exception.js';
import { UserService } from '../../domain/user.service.js';
import { PageQueryDto } from '../../dto/page-query.dto.js';
import { ProfilePatchDto } from '../../dto/profile-patch.dto.js';
import type {
  UserPageResponse,
  UserResponse,
} from '../../dto/user-response.dto.js';
import { toUserResponse } from '../../mapper/user.mapper.js';
import type { User } from '../../repository/entities/user.entity.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../security/decorators.js';
import { assertOwnerOrPermission } from '../../security/ownership.js';
import type { Principal } from '../../security/principal.js';
import { etagOf, parseIfMatch } from '../../util/etag.js';
import { parseSort } from '../../util/pagination.js';
import { ApiAuthenticated, ApiProblems } from './openapi/decorators.js';
import { UserDto, UserPageDto } from './openapi/schemas.js';
import { uuidParam } from './pipes.js';
import {
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

const SORTABLE = ['createdAt', 'username', 'displayName'] as const;

@ApiTags('Users')
@ApiAuthenticated()
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UserService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private view(user: User, viewer: Principal): UserResponse {
    return toUserResponse(user, {
      viewer,
      mediaBaseUrl: this.config.media.publicBaseUrl,
    });
  }

  /** Admin listing. Every other route in this controller is open to any authenticated user (see each one). */
  @ApiOperation({ summary: 'List users (ADMIN)' })
  @ApiOkResponse({ description: 'A page of users', type: UserPageDto })
  @ApiProblems(400, 403)
  @Get()
  @RequirePermissions('users:list')
  async list(
    @Query() q: PageQueryDto,
    @CurrentPrincipal() who: Principal,
  ): Promise<UserPageResponse> {
    const sort = parseSort(q.sort, SORTABLE, {
      field: 'createdAt',
      direction: 'desc',
    });
    const page = await this.users.list(q, sort);
    return { ...page, items: page.items.map((u) => this.view(u, who)) };
  }

  // NOTE: 'me' routes are declared before ':id' so "me" is never parsed as an id.
  @ApiOperation({ summary: 'Own profile' })
  @ApiResponse({
    status: 200,
    description: 'OK',
    type: UserDto,
    headers: {
      ETag: { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string' } },
    },
  })
  @ApiProblems(403, 404)
  @Get('me')
  @RequirePermissions('profile:read-own')
  async me(
    @CurrentPrincipal() who: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const user = await this.users.getById(who.userId);
    reply
      .header('etag', etagOf(user.version))
      .header('cache-control', 'no-store');
    return this.view(user, who);
  }

  @ApiOperation({
    summary: 'Update own profile (optimistic locking via If-Match)',
  })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'The ETag of the version being edited, e.g. "3"',
    schema: { type: 'string' },
  })
  @ApiResponse({
    status: 200,
    description: 'OK',
    type: UserDto,
    headers: {
      ETag: { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string' } },
    },
  })
  @ApiProblems(400, 403, 404, 409)
  @Patch('me')
  @RequirePermissions('profile:update-own')
  async updateMe(
    @Body() dto: ProfilePatchDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() who: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (Object.values(dto).every((v) => v === undefined)) {
      throw new ValidationException([{ field: 'body', code: 'NotBlank' }]);
    }
    const version = parseIfMatch(ifMatch);
    const user = await this.users.updateProfile(who.userId, version, dto);
    reply
      .header('etag', etagOf(user.version))
      .header('cache-control', 'no-store');
    return this.view(user, who);
  }

  /** Public profile: any authenticated user. The email field appears only for the owner / privileged callers. */
  @ApiOperation({
    summary:
      'Get a user (the email appears only for the owner, administrators and internal services)',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiOkResponse({ description: 'OK', type: UserDto })
  @ApiProblems(400, 404)
  @Get(':id')
  async byId(
    @Param('id', uuidParam('id')) id: string,
    @CurrentPrincipal() who: Principal,
  ) {
    return this.view(await this.users.getById(id), who);
  }

  /** Owner deletes their own account, or an admin deletes anyone's. */
  @ApiOperation({ summary: 'Delete a user (the owner, or an administrator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiNoContentResponse({ description: 'No content' })
  @ApiProblems(400, 403, 404)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', uuidParam('id')) id: string,
    @CurrentPrincipal() who: Principal,
  ): Promise<void> {
    assertOwnerOrPermission(who, id, 'users:delete-any');
    await this.users.delete(id);
  }
}
