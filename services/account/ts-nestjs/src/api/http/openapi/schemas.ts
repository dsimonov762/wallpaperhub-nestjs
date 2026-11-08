import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LOCALES } from '../../../dto/registration-request.dto.js';
import type {
  UserPageResponse,
  UserResponse,
} from '../../../dto/user-response.dto.js';

/**
 * Response shapes for the generated OpenAPI document. They only DESCRIBE what controllers return
 * (the real return types are the plain interfaces in `dto/`); the assignments at the bottom make the
 * compiler fail if a description and its interface ever drift apart.
 */

export class FieldErrorDto {
  @ApiProperty({ example: 'username' }) field!: string;
  @ApiProperty({
    example: 'Taken',
    description: 'Machine-readable code; the localized text is in `message`',
  })
  code!: string;
  @ApiProperty({ example: 'Username is already taken.' }) message!: string;
}

export class ProblemDto {
  @ApiProperty({
    format: 'uri',
    example: 'https://wallpaperhub.dev/problems/validation-failed',
  })
  type!: string;
  @ApiProperty({ example: 'Validation failed' }) title!: string;
  @ApiProperty({ type: 'integer', example: 400 }) status!: number;
  @ApiProperty({ example: 'One or more fields are invalid.' }) detail!: string;
  @ApiProperty({ example: '/api/v1/registrations' }) instance!: string;
  @ApiProperty({
    pattern: '^[0-9a-f]{32}$',
    description: 'W3C trace id: quote it when reporting a problem',
  })
  traceId!: string;
  @ApiPropertyOptional({ type: [FieldErrorDto] }) errors?: FieldErrorDto[];
}

export class UserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() username!: string;
  @ApiPropertyOptional({
    format: 'email',
    description:
      'Only present for the owner, administrators and internal services',
  })
  email?: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ type: String, nullable: true }) bio!: string | null;
  @ApiProperty({ enum: LOCALES }) locale!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) bannerUrl!: string | null;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    type: 'integer',
    description: 'Optimistic-locking version, also sent as the ETag',
  })
  version!: number;
}

export class UserPageDto {
  @ApiProperty({ type: [UserDto] }) items!: UserDto[];
  @ApiProperty({ type: 'integer' }) page!: number;
  @ApiProperty({ type: 'integer' }) size!: number;
  @ApiProperty({ type: 'integer' }) totalItems!: number;
  @ApiProperty({ type: 'integer' }) totalPages!: number;
}

export class WhoAmIDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ type: [String] }) permissions!: string[];
  @ApiProperty() service!: boolean;
  @ApiProperty({ type: String, nullable: true }) clientId!: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

// Compile-time guards: the documented shape must be what the code really returns.
export const documentedUser: UserResponse = {} as UserDto;
export const documentedPage: UserPageResponse = {} as UserPageDto;
