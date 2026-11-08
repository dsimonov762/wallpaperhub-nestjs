import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Res } from '@nestjs/common';
import type { AppConfig } from '../../config/config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { RegistrationService } from '../../domain/registration.service.js';
import { RegistrationRequestDto } from '../../dto/registration-request.dto.js';
import { toUserResponse } from '../../mapper/user.mapper.js';
import {
  IdempotencyService,
  type StoredResponse,
} from '../../resilience/idempotency.service.js';
import {
  RateLimit,
  RateLimitGuard,
} from '../../resilience/rate-limit.guard.js';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../security/decorators.js';
import { sha256Hex } from '../../util/hashing.js';
import { ApiProblems } from './openapi/decorators.js';
import { UserDto } from './openapi/schemas.js';
import { currentContext } from './request-context.js';

@ApiTags('Registration')
@Controller('registrations')
export class RegistrationController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly idempotency: IdempotencyService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Public, rate limited per IP, safe to retry with an `Idempotency-Key` header. */
  @ApiOperation({ summary: 'Register a new user (public, rate-limited)' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Makes a retry safe. The same key with the same request returns the original response.',
    schema: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[\\w.:-]{1,128}$',
    },
  })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description:
      'Language of error messages and the default locale of the new account (en, de, es)',
    schema: { type: 'string', example: 'de-DE,de;q=0.9' },
  })
  @ApiResponse({
    status: 201,
    description:
      'Created (or the replayed original response when the same Idempotency-Key is repeated, marked by the Idempotent-Replayed header)',
    type: UserDto,
    headers: {
      Location: { schema: { type: 'string' } },
      'Idempotent-Replayed': { schema: { type: 'string', enum: ['true'] } },
    },
  })
  @ApiProblems(400, 409, 429, 503)
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit('registration')
  @Post()
  @HttpCode(201)
  async register(
    @Body() dto: RegistrationRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const create = async (): Promise<StoredResponse> => {
      const user = await this.registration.register({
        username: dto.username,
        email: dto.email,
        password: dto.password,
        displayName: dto.displayName,
        locale: dto.locale ?? currentContext()?.locale ?? 'en',
      });
      return {
        status: 201,
        headers: { location: `/api/v1/users/${user.id}` },
        // The new user may see their own email; nobody else is reading this response.
        body: toUserResponse(user, {
          viewer: { userId: user.id, roles: [] },
          mediaBaseUrl: this.config.media.publicBaseUrl,
        }),
      };
    };

    let stored: StoredResponse;
    if (idempotencyKey === undefined) {
      stored = await create();
    } else {
      IdempotencyService.validateKey(idempotencyKey);
      // The fingerprint binds the key to THIS request. The password enters it only as a hash.
      const fingerprint = {
        username: dto.username,
        email: dto.email,
        displayName: dto.displayName,
        locale: dto.locale ?? null,
        password: sha256Hex(dto.password),
      };
      const result = await this.idempotency.execute(
        'registrations',
        idempotencyKey,
        fingerprint,
        create,
      );
      stored = result.response;
      if (result.replayed) reply.header('idempotent-replayed', 'true');
    }

    for (const [name, value] of Object.entries(stored.headers ?? {}))
      reply.header(name, value);
    reply.status(stored.status);
    return stored.body;
  }
}
